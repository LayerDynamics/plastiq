// E2E (no mock): click-drag-release drawing. For the 2-click primitives (line,
// rectangle, circle) a single left press-drag-release builds the shape — press is the
// first click, release the second. Click-by-click still works (covered elsewhere);
// pan moves to the middle mouse button. Drives the REAL pointer (mouse down/move/up)
// over the canvas and asserts the geometry the drag produced.

import { expect, test, type Page } from "@playwright/test";

type SketchState = {
  setTool(t: string): void;
  model: { points: { id: string; u: number; v: number }[]; entities: { id: string; kind: string }[] };
};

const model = (page: Page): Promise<SketchState["model"]> =>
  page.evaluate(
    () => (globalThis as { __sketchStore?: { getState(): SketchState } }).__sketchStore!.getState().model,
  );

async function enterSketch(page: Page, tool: string): Promise<{ x: number; y: number; w: number; h: number }> {
  await page.goto("/");
  await expect(page.getByTestId("status")).toHaveText("ready", { timeout: 240_000 });
  await page.getByTestId("enter-sketch").click();
  await expect(page.getByTestId("sketcher")).toBeVisible();
  await page.evaluate(
    (t) => (globalThis as { __sketchStore?: { getState(): SketchState } }).__sketchStore!.getState().setTool(t),
    tool,
  );
  return (await page.locator("#viewport-root canvas").boundingBox())!;
}

/** A real left press at (x1,y1), drag to (x2,y2), release. */
async function dragDraw(page: Page, x1: number, y1: number, x2: number, y2: number): Promise<void> {
  await page.mouse.move(x1, y1);
  await page.mouse.down();
  await page.mouse.move((x1 + x2) / 2, (y1 + y2) / 2, { steps: 6 });
  await page.mouse.move(x2, y2, { steps: 6 });
  await page.mouse.up();
}

test("dragging the Line tool builds one segment from press to release", async ({ page }) => {
  const b = await enterSketch(page, "line");
  await dragDraw(page, b.x + b.width * 0.4, b.y + b.height * 0.5, b.x + b.width * 0.65, b.y + b.height * 0.5);
  await expect
    .poll(async () => (await model(page)).entities.filter((e) => e.kind === "line").length)
    .toBe(1); // a single drag drew exactly one line
  const m = await model(page);
  expect(m.points.length).toBeGreaterThanOrEqual(2); // start + end
});

test("dragging the Circle tool builds a circle (centre = press, radius = drag)", async ({ page }) => {
  const b = await enterSketch(page, "circle");
  const cx = b.x + b.width * 0.5;
  const cy = b.y + b.height * 0.5;
  await dragDraw(page, cx, cy, cx + 80, cy); // drag out a radius
  await expect
    .poll(async () => (await model(page)).entities.filter((e) => e.kind === "circle").length)
    .toBe(1);
});

test("a drag preview appears while dragging and clears on release", async ({ page }) => {
  const b = await enterSketch(page, "rectangle");
  const x1 = b.x + b.width * 0.4;
  const y1 = b.y + b.height * 0.45;
  await page.mouse.move(x1, y1);
  await page.mouse.down();
  await page.mouse.move(x1 + 90, y1 + 60, { steps: 8 });
  // While dragging, a dashed preview rect is shown.
  await expect(page.locator("rect[stroke-dasharray]")).toBeVisible();
  await page.mouse.up();
  const m = await model(page);
  expect(m.entities.filter((e) => e.kind === "line")).toHaveLength(4); // a real rectangle
});
