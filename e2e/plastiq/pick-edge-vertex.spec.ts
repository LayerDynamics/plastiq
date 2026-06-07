// E2E (no mock): edges and vertices are selectable by clicking near them. They are
// thin targets the raycast usually misses, so Picking falls back to the nearest
// projected candidate within a pixel tolerance. We switch selection mode, ask the
// viewport where the first edge/vertex projects (candidatePx seam), dispatch a real
// click there, and assert the store recorded a pick of that kind.

import { expect, test, type Page } from "@playwright/test";

async function boot(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByTestId("status")).toHaveText("ready", { timeout: 240_000 });
  await page.waitForFunction(
    () =>
      (globalThis as { __plastiqViewport?: { builtPart: unknown } }).__plastiqViewport?.builtPart !=
      null,
    undefined,
    { timeout: 240_000 },
  );
  await page.evaluate(() => {
    (globalThis as { __plastiqViewport?: { fitToView(): void } }).__plastiqViewport?.fitToView();
  });
  await page.waitForTimeout(700);
}

const pickCount = (page: Page, kind: string): Promise<number> =>
  page.evaluate(
    (k) =>
      (globalThis as { __cadStore?: { getState(): { picks: { kind: string }[] } } }).__cadStore!
        .getState()
        .picks.filter((p) => p.kind === k).length,
    kind,
  );

async function selectFirst(page: Page, mode: "edge" | "vertex"): Promise<void> {
  await page.evaluate(
    (m) => (globalThis as { __cadStore?: { getState(): { setSelMode(x: string): void } } }).__cadStore!.getState().setSelMode(m),
    mode,
  );
  const px = await page.evaluate(
    (m) =>
      (
        globalThis as {
          __plastiqViewport?: { candidatePx?: (mode: string) => { x: number; y: number } | null };
        }
      ).__plastiqViewport?.candidatePx?.(m) ?? null,
    mode,
  );
  if (!px) throw new Error(`no ${mode} candidate on screen`);
  await page.evaluate(
    ([x, y]) => {
      const el = document.querySelector("#viewport-root canvas")!;
      const opts = { clientX: x, clientY: y, button: 0, bubbles: true } as PointerEventInit;
      el.dispatchEvent(new PointerEvent("pointerdown", opts));
      el.dispatchEvent(new PointerEvent("pointerup", opts));
    },
    [px.x, px.y],
  );
}

test("edges are selectable by clicking near them", async ({ page }) => {
  await boot(page);
  expect(await pickCount(page, "edge")).toBe(0);
  await selectFirst(page, "edge");
  await expect.poll(() => pickCount(page, "edge")).toBe(1);
});

test("vertices are selectable by clicking near them", async ({ page }) => {
  await boot(page);
  expect(await pickCount(page, "vertex")).toBe(0);
  await selectFirst(page, "vertex");
  await expect.poll(() => pickCount(page, "vertex")).toBe(1);
});
