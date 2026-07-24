// Dimensioning a segment, and the overlay tracking the camera (FR-12). This one
// test guards THREE separate defects, all on the path from "select a line" to
// "its label sits in the right place":
//
//  1. Overlay projection. Glyphs used to be drawn through a fixed, centred 2D
//     view pinned on entering the sketch, while the geometry was drawn by the 3D
//     camera — so the first orbit, pan or zoom slid the annotations off the
//     entities they belong to. The camera moves here for real.
//  2. Dimensioning a SELECTED LINE (dim.ts). Only loose points were resolved, so
//     picking a segment and dimensioning it measured nothing and silently built
//     no constraint. If that regresses there is no glyph here at all.
//  3. MIDPOINT anchoring (Sketcher.tsx). A point-pair dimension anchored on `a`
//     alone, hanging the label off one endpoint instead of spanning the pair. A
//     regression puts the anchor ~18 mm off for this segment.
//
// The check trusts no projection maths of its own. It reads the glyph's position
// out of the DOM, then asks the APP where that screen point lands on the sketch
// plane (the store's `cursor`, fed by the 3D plane's own hit test — a separate
// code path from the overlay's projection). If the two agree before AND after the
// camera moves, the overlay is genuinely camera-synced.

import { expect, test, type Page } from "@playwright/test";

type UV = [number, number];
type Store = {
  setTool(t: string): void;
  clickAt(u: number, v: number): void;
  cancelGesture(): void;
  setSelection(ids: string[]): void;
  addDimension(kind: string): void;
  cursor: UV | null;
  model: {
    points: { id: string; u: number; v: number }[];
    entities: { id: string; kind: string; a?: string; b?: string }[];
  };
};

/**
 * The glyph's ANCHOR — the point on the geometry it labels.
 *
 * Sketcher.tsx renders each glyph as `<g transform="translate(at.x + 8 + w/2,
 * at.y - 8)">` around `<rect x={-w/2} y={-9} width={w} height={14}>`, so the
 * bounding box's left edge is `at.x + 8` and its top is `at.y - 17` whatever the
 * label's width turns out to be. Recovering `at` this way keeps the test
 * independent of the rendered text.
 */
async function glyphAnchor(page: Page): Promise<{ x: number; y: number }> {
  const b = (await page.getByTestId("dimension-glyph").first().boundingBox())!;
  return { x: b.x - 8, y: b.y + 17 };
}

/** Where the APP says a screen point lands on the sketch plane. */
async function uvAt(page: Page, x: number, y: number): Promise<UV | null> {
  await page.mouse.move(x, y);
  return page.evaluate(
    () => (globalThis as { __sketchStore?: { getState(): Store } }).__sketchStore!.getState().cursor,
  );
}

/**
 * Plane distance the glyph may sit from the geometry: well inside a pick radius.
 *
 * Do NOT tighten this, and do not enlarge the segment expecting exact agreement.
 * `pairMid` averages the two endpoints in SCREEN space (matching `lineMid`, so
 * the badge lands at the segment's visual centre), while the expected value here
 * is the midpoint in PLANE space. Under a perspective camera those are not the
 * same point; the gap is far below this tolerance for a segment this size, and
 * grows with the segment's depth extent.
 */
const ON_GEOMETRY = 2e-3;

test("a line's dimension anchors mid-span and follows the camera", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("status")).toHaveText("ready", { timeout: 240_000 });
  await page.getByTestId("enter-sketch").click();
  await expect(page.getByTestId("sketcher")).toBeVisible();

  // Draw a segment and dimension it by selecting the SEGMENT — the ordinary CAD
  // gesture, which used to be a silent no-op (dim.ts resolved loose points only).
  // The glyph then anchors at the span's MIDPOINT, not off one endpoint. Read the
  // endpoints back AFTER the dimension is added: addDimension solves, and the
  // solve is free to move points.
  const anchorUv = await page.evaluate(() => {
    // getState() is a SNAPSHOT — re-read it after each mutation, or `model` is
    // the pre-click one and the new line is invisible.
    const st = (): Store =>
      (globalThis as { __sketchStore?: { getState(): Store } }).__sketchStore!.getState();
    st().setTool("line");
    st().clickAt(0, 0);
    st().clickAt(0.03, 0.02);
    st().cancelGesture();
    const line = st().model.entities.find((e) => e.kind === "line")!;
    st().setSelection([line.id]);
    st().addDimension("hDistance");
    const pt = (pid: string): { u: number; v: number } =>
      st().model.points.find((p) => p.id === pid)!;
    const [a, b] = [pt(line.a!), pt(line.b!)];
    return [(a.u + b.u) / 2, (a.v + b.v) / 2] as UV;
  });

  await expect(page.getByTestId("dimension-glyph").first()).toBeVisible();

  // The app's own hit test must report that same plane coordinate at the anchor.
  const before = await glyphAnchor(page);
  const seen = (await uvAt(page, before.x, before.y))!;
  expect(
    Math.hypot(seen[0] - anchorUv[0], seen[1] - anchorUv[1]),
    "the glyph starts on the geometry it annotates",
  ).toBeLessThan(ON_GEOMETRY);

  // Move the camera through the published seam the view cube picks use.
  await page.evaluate(() => {
    (
      globalThis as {
        __plastiqViewport?: { setView?: (d: readonly [number, number, number]) => void };
      }
    ).__plastiqViewport!.setView!([1, -1, 1]);
  });

  // It must have MOVED — otherwise "still on the geometry" passes vacuously.
  await expect
    .poll(
      async () => {
        const at = await glyphAnchor(page);
        return Math.hypot(at.x - before.x, at.y - before.y);
      },
      { timeout: 15_000 },
    )
    .toBeGreaterThan(10);

  // …and moved to the RIGHT place. Under the old fixed centred view the glyph
  // held its screen position while the geometry swung out from under it, so this
  // probe would land somewhere else on the plane entirely.
  const after = await glyphAnchor(page);
  const stillOn = (await uvAt(page, after.x, after.y))!;
  expect(
    Math.hypot(stillOn[0] - anchorUv[0], stillOn[1] - anchorUv[1]),
    "the glyph tracked the camera and stayed on its geometry",
  ).toBeLessThan(ON_GEOMETRY);
});
