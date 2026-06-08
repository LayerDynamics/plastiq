// E2E (no mock): while a sketch is open, the GLOBAL viewport shortcuts must not
// leak into it. Before the fix, App's window keydown ran alongside the sketcher's:
// Esc double-fired, keys 1–4 switched the hidden 3D selection mode, and Ctrl+Z
// reverted a committed DOCUMENT feature instead of the last sketch action (the
// sketch is transient — ADR-0013 — and had no undo of its own). This drives real
// KeyboardEvents on window and asserts the sketch owns its keys.

import { expect, test, type Page } from "@playwright/test";

type SketchState = {
  active: boolean;
  setTool(t: string): void;
  clickAt(u: number, v: number): void;
  model: { points: { id: string }[]; entities: { id: string }[] };
};
type CadState = { features: { id: string }[]; selMode: string; setSelMode(m: string): void };

const sketchCounts = (page: Page): Promise<{ points: number; entities: number; active: boolean }> =>
  page.evaluate(() => {
    const st = (globalThis as { __sketchStore?: { getState(): SketchState } }).__sketchStore!.getState();
    return { points: st.model.points.length, entities: st.model.entities.length, active: st.active };
  });

const featureCount = (page: Page): Promise<number> =>
  page.evaluate(
    () => (globalThis as { __cadStore?: { getState(): CadState } }).__cadStore!.getState().features.length,
  );

const selMode = (page: Page): Promise<string> =>
  page.evaluate(
    () => (globalThis as { __cadStore?: { getState(): CadState } }).__cadStore!.getState().selMode,
  );

const pressKey = (page: Page, init: KeyboardEventInit): Promise<void> =>
  page.evaluate((i) => window.dispatchEvent(new KeyboardEvent("keydown", { ...i, bubbles: true })), init);

async function boot(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByTestId("status")).toHaveText("ready", { timeout: 240_000 });
  await page.waitForFunction(
    () => (globalThis as { __plastiqViewport?: { builtPart: unknown } }).__plastiqViewport?.builtPart != null,
    undefined,
    { timeout: 240_000 },
  );
}

async function enterSketchWithALine(page: Page): Promise<void> {
  await expect(page.getByTestId("enter-sketch")).toBeEnabled({ timeout: 240_000 });
  await page.getByTestId("enter-sketch").click();
  await expect(page.getByTestId("sketcher")).toBeVisible();
  await page.evaluate(() => {
    const st = (globalThis as { __sketchStore?: { getState(): SketchState } }).__sketchStore!.getState();
    st.setTool("line");
    st.clickAt(0, 0);
    st.clickAt(0.05, 0);
  });
}

test("Ctrl+Z while sketching undoes the last SKETCH action, not a document feature", async ({ page }) => {
  await boot(page);
  const featuresBefore = await featureCount(page); // the seeded box
  await enterSketchWithALine(page);

  let counts = await sketchCounts(page);
  expect(counts.points).toBe(2);
  expect(counts.entities).toBe(1); // one line

  await pressKey(page, { key: "z", ctrlKey: true });

  counts = await sketchCounts(page);
  expect(counts.entities).toBe(0); // the line was undone (sketch-local undo)
  expect(counts.points).toBe(1);
  expect(counts.active).toBe(true); // still sketching
  expect(await featureCount(page)).toBe(featuresBefore); // the document feature was NOT touched
});

test("number keys 1–4 do not switch the 3D selection mode while sketching", async ({ page }) => {
  await boot(page);
  await page.evaluate(() =>
    (globalThis as { __cadStore?: { getState(): CadState } }).__cadStore!.getState().setSelMode("face"),
  );
  await enterSketchWithALine(page);

  await pressKey(page, { key: "2" }); // would be "edge" if it leaked
  await pressKey(page, { key: "4" }); // would be "body" if it leaked
  expect(await selMode(page)).toBe("face"); // unchanged — the sketch swallowed the keys
});

test("Esc while sketching cancels the gesture without clearing picks or exiting", async ({ page }) => {
  await boot(page);
  const featuresBefore = await featureCount(page);
  await enterSketchWithALine(page);

  await pressKey(page, { key: "Escape" });

  const counts = await sketchCounts(page);
  expect(counts.active).toBe(true); // Esc cancels the in-progress gesture, doesn't exit the sketch
  expect(await featureCount(page)).toBe(featuresBefore); // and didn't remove a document feature
});
