// E2E (no mock): Fusion-style "type exact dimensions while drawing". During a draw
// gesture an inline value box shows live values; typing a value places the geometry
// EXACTLY at it AND creates a driving dimension so the sketch stays parametric. We
// drive the real box (field buttons + inputs + Enter) and assert both the solved
// geometry and the created dimension constraints — not merely that the box rendered.

import { expect, test, type Page } from "@playwright/test";

type Pt = { id: string; u: number; v: number };
type Ent = { id: string; kind: string; a?: string; b?: string; center?: string };
type Con = { kind: string; value?: number; a?: string; b?: string; line?: string; circle?: string };
type SketchState = {
  setTool(t: string): void;
  clickAt(u: number, v: number): void;
  model: { points: Pt[]; entities: Ent[]; constraints: Con[] };
};

const model = (page: Page): Promise<SketchState["model"]> =>
  page.evaluate(
    () =>
      (globalThis as { __sketchStore?: { getState(): SketchState } }).__sketchStore!.getState().model,
  );

async function enterSketch(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByTestId("status")).toHaveText("ready", { timeout: 240_000 });
  await expect(page.getByTestId("enter-sketch")).toBeEnabled({ timeout: 240_000 });
  await page.getByTestId("enter-sketch").click();
  await expect(page.getByTestId("sketcher")).toBeVisible();
}

/** Place the gesture's anchor at the origin via the store, leaving the inline box open. */
async function anchorAtOrigin(page: Page, tool: string): Promise<void> {
  await page.evaluate((t) => {
    const s = (globalThis as { __sketchStore?: { getState(): SketchState } }).__sketchStore!.getState();
    s.setTool(t);
    s.clickAt(0, 0);
  }, tool);
  await expect(page.getByTestId("draw-input")).toBeVisible();
}

/** Type a value into a named field of the inline box (focus it, then fill). */
async function typeField(page: Page, key: string, value: string): Promise<void> {
  await page.getByTestId(`draw-field-${key}`).click();
  await page.getByTestId(`draw-input-${key}`).fill(value);
}

test("typing length + angle for a line places it exactly and dimensions it", async ({ page }) => {
  await enterSketch(page);
  await anchorAtOrigin(page, "line");

  await typeField(page, "length", "30"); // 30 mm
  await typeField(page, "angle", "45"); // 45°
  await page.getByTestId("draw-input-angle").press("Enter"); // commit

  const m = await model(page);
  // The endpoint solved to exactly 30mm @ 45° from the origin anchor.
  const line = m.entities.find((e) => e.kind === "line")!;
  const a = m.points.find((p) => p.id === line.a)!;
  const b = m.points.find((p) => p.id === line.b)!;
  const len = Math.hypot(b.u - a.u, b.v - a.v);
  const ang = Math.atan2(b.v - a.v, b.u - a.u);
  expect(len).toBeCloseTo(0.03, 4);
  expect(ang).toBeCloseTo(Math.PI / 4, 4);
  // …and it is parametric: a distance dim (30mm) + a real lineAngle dim (45°) exist.
  const distance = m.constraints.find((c) => c.kind === "distance");
  const lineAngle = m.constraints.find((c) => c.kind === "lineAngle");
  expect(distance?.value).toBeCloseTo(0.03, 5);
  expect(lineAngle?.value).toBeCloseTo(Math.PI / 4, 5);
});

test("typing width + height for a rectangle sizes it and adds hDistance + vDistance dims", async ({
  page,
}) => {
  await enterSketch(page);
  await anchorAtOrigin(page, "rectangle");

  await typeField(page, "width", "40");
  await typeField(page, "height", "20");
  await page.getByTestId("draw-input-height").press("Enter");

  const m = await model(page);
  expect(m.entities.filter((e) => e.kind === "line")).toHaveLength(4); // a real rectangle
  const us = m.points.map((p) => p.u);
  const vs = m.points.map((p) => p.v);
  expect(Math.max(...us) - Math.min(...us)).toBeCloseTo(0.04, 4); // 40mm wide
  expect(Math.max(...vs) - Math.min(...vs)).toBeCloseTo(0.02, 4); // 20mm tall
  expect(m.constraints.find((c) => c.kind === "hDistance")?.value).toBeCloseTo(0.04, 5);
  expect(m.constraints.find((c) => c.kind === "vDistance")?.value).toBeCloseTo(0.02, 5);
});

test("typing a radius for a circle sizes it and adds a radius dim", async ({ page }) => {
  await enterSketch(page);
  await anchorAtOrigin(page, "circle");

  await typeField(page, "radius", "12");
  await page.getByTestId("draw-input-radius").press("Enter");

  const m = await model(page);
  const circle = m.entities.find((e) => e.kind === "circle");
  expect(circle).toBeTruthy();
  expect(m.constraints.find((c) => c.kind === "radius")?.value).toBeCloseTo(0.012, 5);
});

test("typing a digit over the canvas opens the value box seeded with it", async ({ page }) => {
  await enterSketch(page);
  await anchorAtOrigin(page, "line");
  // Box is present but not yet in entry mode; pressing a digit on the canvas starts it.
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "5", bubbles: true })));
  await expect(page.getByTestId("draw-input-length")).toBeVisible();
  await expect(page.getByTestId("draw-input-length")).toHaveValue("5");
});

test("the X/Y tools (point/spline/arc/…) place a point at exact typed coordinates", async ({
  page,
}) => {
  await enterSketch(page);
  await page.evaluate(() =>
    (globalThis as { __sketchStore?: { getState(): SketchState } }).__sketchStore!.getState().setTool("point"),
  );
  // No anchor for a point tool → move the cursor over the canvas so the box appears.
  const box = (await page.locator("#viewport-root canvas").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.getByTestId("draw-input")).toBeVisible();

  // Keyboard flow (the primary Fusion path): start typing → box captures, Tab → next
  // field, Enter → commit. (No clicking the box, which tracks the cursor until entry.)
  await page.keyboard.press("1"); // seeds X with "1" and focuses it
  await expect(page.getByTestId("draw-input-x")).toBeVisible();
  await page.keyboard.type("0"); // X = "10"
  await page.keyboard.press("Tab"); // → Y
  await page.keyboard.type("20"); // Y = "20"
  await page.keyboard.press("Enter"); // commit

  const m = await model(page);
  const placed = m.points.find((p) => Math.abs(p.u - 0.01) < 1e-6 && Math.abs(p.v - 0.02) < 1e-6);
  expect(placed).toBeTruthy(); // a point landed exactly at the typed (10mm, 20mm)
});
