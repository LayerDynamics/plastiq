// E2E (no mock): Fusion-style keyboard shortcuts in the sketcher. Single letters
// switch tools (L/R/C/G/V…), X toggles construction, D dimensions the selection,
// Esc backs out to Select. A modifier (Ctrl) suppresses them so App's Ctrl+Z etc.
// still work. Drives real KeyboardEvents on window and reads the sketch store seam.

import { expect, test, type Page } from "@playwright/test";

type SketchState = {
  tool: string;
  construction: boolean;
  setTool(t: string): void;
  clickAt(u: number, v: number): void;
  setSelection(ids: string[]): void;
  model: { points: { id: string }[]; constraints: { kind: string }[] };
};

const tool = (page: Page): Promise<string> =>
  page.evaluate(
    () => (globalThis as { __sketchStore?: { getState(): SketchState } }).__sketchStore!.getState().tool,
  );
const construction = (page: Page): Promise<boolean> =>
  page.evaluate(
    () =>
      (globalThis as { __sketchStore?: { getState(): SketchState } }).__sketchStore!.getState()
        .construction,
  );
const hasDistanceDim = (page: Page): Promise<boolean> =>
  page.evaluate(() =>
    (globalThis as { __sketchStore?: { getState(): SketchState } }).__sketchStore!
      .getState()
      .model.constraints.some((c) => c.kind === "distance"),
  );

const key = (page: Page, k: string, init: KeyboardEventInit = {}): Promise<void> =>
  page.evaluate(
    ([kk, i]) => window.dispatchEvent(new KeyboardEvent("keydown", { key: kk as string, bubbles: true, ...(i as object) })),
    [k, init] as const,
  );

async function enterSketch(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByTestId("status")).toHaveText("ready", { timeout: 240_000 });
  await expect(page.getByTestId("enter-sketch")).toBeEnabled({ timeout: 240_000 });
  await page.getByTestId("enter-sketch").click();
  await expect(page.getByTestId("sketcher")).toBeVisible();
}

test("single-letter keys switch the active tool", async ({ page }) => {
  await enterSketch(page);
  await key(page, "l");
  expect(await tool(page)).toBe("line");
  await key(page, "c");
  expect(await tool(page)).toBe("circle");
  await key(page, "r");
  expect(await tool(page)).toBe("rectangle");
  await key(page, "g");
  expect(await tool(page)).toBe("polygon");
  await key(page, "v");
  expect(await tool(page)).toBe("select");
});

test("X toggles construction; a modifier suppresses the shortcut", async ({ page }) => {
  await enterSketch(page);
  expect(await construction(page)).toBe(false);
  await key(page, "x");
  expect(await construction(page)).toBe(true);
  await key(page, "x");
  expect(await construction(page)).toBe(false);

  // Ctrl+L must NOT switch tools (App owns Ctrl-combos like undo).
  await key(page, "l", { ctrlKey: true });
  expect(await tool(page)).toBe("select");
});

test("Esc backs out to the Select tool when no gesture is in progress", async ({ page }) => {
  await enterSketch(page);
  await key(page, "l");
  expect(await tool(page)).toBe("line");
  await key(page, "Escape");
  expect(await tool(page)).toBe("select");
});

test("D applies a smart dimension to the current selection", async ({ page }) => {
  await enterSketch(page);
  // Draw a line, then select its two endpoints.
  await page.evaluate(() => {
    const s = (globalThis as { __sketchStore?: { getState(): SketchState } }).__sketchStore!.getState();
    s.setTool("line");
    s.clickAt(0, 0);
    s.clickAt(0.05, 0);
  });
  await page.evaluate(() => {
    const s = (globalThis as { __sketchStore?: { getState(): SketchState } }).__sketchStore!.getState();
    s.setTool("select");
    s.setSelection(s.model.points.map((p) => p.id));
  });
  await key(page, "d");
  expect(await hasDistanceDim(page)).toBe(true);
});
