// §2.6.1 — ENTITY selection in the sketcher, and the constraint buttons it gates.
//
// The 3D sketch plane used to hit-test POINTS only, so `canApply` (which counts
// the lines/circles in the selection) always saw zero and every constraint that
// needs a curve was permanently disabled no matter what the user clicked.
//
// Clicking "on the line" cannot be done with hardcoded screen coordinates: the
// sketch camera's orientation relative to the plane's u/v axes is not fixed, so
// a screen position does not map to a predictable plane coordinate. The test
// therefore CALIBRATES the mapping from the app itself — three probe moves give
// the affine screen→plane transform, which is inverted to aim the click. That
// tests the real thing (a click that lands on the segment selects it) without
// assuming anything about the camera.

import { expect, test, type Page } from "@playwright/test";

type UV = [number, number];
type Store = {
  setTool(t: string): void;
  tool: string;
  selection: string[];
  cursor: UV | null;
  model: { points: { id: string; u: number; v: number }[]; entities: { id: string; kind: string; a?: string; b?: string }[] };
};

const read = <T,>(page: Page, f: (s: Store) => T): Promise<T> =>
  page.evaluate(
    (src) => {
      const s = (globalThis as { __sketchStore?: { getState(): Store } }).__sketchStore!.getState();
      return (new Function("s", `return (${src})(s)`) as (x: Store) => T)(s);
    },
    f.toString(),
  );

const setTool = (page: Page, t: string): Promise<void> =>
  page.evaluate(
    (tool) => (globalThis as { __sketchStore?: { getState(): Store } }).__sketchStore!.getState().setTool(tool),
    t,
  );

/** Convergence target for {@link aimAt}: ~1 screen pixel in plane metres. */
const AIM_TOL = 6e-4;

/** Plane coordinate under a screen point, as the app itself reports it. */
async function uvAt(page: Page, x: number, y: number): Promise<UV | null> {
  await page.mouse.move(x, y);
  return read(page, (s) => s.cursor);
}

/**
 * Calibrate screen→plane, then return its inverse: plane → screen.
 *
 * Three samples determine an affine map exactly. The sketch camera is
 * perspective, so this is a LOCAL linearisation rather than the true inverse —
 * accurate near the probe origin and drifting a few millimetres further out,
 * which is why {@link aimAt} refines it against the app instead of trusting it.
 */
async function planeToScreen(
  page: Page,
  box: { x: number; y: number; width: number; height: number },
): Promise<(uv: UV) => { x: number; y: number }> {
  const ox = box.x + box.width * 0.5;
  const oy = box.y + box.height * 0.5;
  const d = Math.min(box.width, box.height) * 0.15;
  const o = (await uvAt(page, ox, oy))!;
  const ex = (await uvAt(page, ox + d, oy))!;
  const ey = (await uvAt(page, ox, oy + d))!;
  // Columns of the 2x2 screen→plane matrix (per screen pixel).
  const a = (ex[0] - o[0]) / d;
  const c = (ex[1] - o[1]) / d;
  const b = (ey[0] - o[0]) / d;
  const e = (ey[1] - o[1]) / d;
  const det = a * e - b * c;
  expect(Math.abs(det), "the sketch plane must be visible, not edge-on").toBeGreaterThan(1e-12);
  return (uv: UV) => {
    const du = uv[0] - o[0];
    const dv = uv[1] - o[1];
    return { x: ox + (e * du - b * dv) / det, y: oy + (-c * du + a * dv) / det };
  };
}

/**
 * Move the pointer until it actually lands on `target` in the sketch plane, and
 * return that screen position. Starts from the linearised inverse and corrects
 * against what the app reports, so perspective foreshortening cannot make the
 * click miss what it is aiming at.
 */
async function aimAt(
  page: Page,
  toScreen: (uv: UV) => { x: number; y: number },
  target: UV,
): Promise<{ x: number; y: number }> {
  const origin = toScreen(target);
  let at = origin;
  let landed = (await uvAt(page, at.x, at.y))!;
  // AIM_TOL is one screen pixel's worth of plane distance at the sketch zoom:
  // Playwright moves the pointer in whole pixels, so no amount of refining gets
  // below it. It is far inside hitTest's ~1.75 mm pick radius, which is what the
  // click actually needs to satisfy.
  for (let i = 0; i < 6 && Math.hypot(landed[0] - target[0], landed[1] - target[1]) > AIM_TOL; i++) {
    // Correct in SCREEN space by the linear image of the plane-space error.
    const corrected = toScreen([2 * target[0] - landed[0], 2 * target[1] - landed[1]]);
    at = { x: at.x + (corrected.x - origin.x), y: at.y + (corrected.y - origin.y) };
    landed = (await uvAt(page, at.x, at.y))!;
  }
  expect(
    Math.hypot(landed[0] - target[0], landed[1] - target[1]),
    "the pointer converged onto the target point on the plane",
  ).toBeLessThan(AIM_TOL);
  return at;
}

async function enterSketch(page: Page): Promise<{ x: number; y: number; width: number; height: number }> {
  await page.goto("/");
  await expect(page.getByTestId("status")).toHaveText("ready", { timeout: 240_000 });
  await page.getByTestId("enter-sketch").click();
  await expect(page.getByTestId("sketcher")).toBeVisible();
  const box = (await page.locator("#viewport-root canvas").boundingBox())!;
  // The plane must be pickable before anything is calibrated against it.
  await expect
    .poll(async () => (await uvAt(page, box.x + box.width * 0.5, box.y + box.height * 0.5)) !== null, {
      timeout: 30_000,
    })
    .toBe(true);
  return box;
}

/** Draw one line segment by dragging, and return its two endpoints in plane coords. */
async function drawLine(page: Page, from: { x: number; y: number }, to: { x: number; y: number }): Promise<UV[]> {
  await setTool(page, "line");
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 6 });
  await page.mouse.move(to.x, to.y, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => read(page, (s) => s.model.entities.length)).toBe(1);
  const line = await read(page, (s) => {
    const e = s.model.entities.find((x) => x.kind === "line")!;
    const pt = (id: string): UV => {
      const p = s.model.points.find((q) => q.id === id)!;
      return [p.u, p.v];
    };
    return [pt(e.a as string), pt(e.b as string)] as UV[];
  });
  return line;
}

test("clicking a LINE selects the entity and enables its constraints", async ({ page }) => {
  const box = await enterSketch(page);
  const ends = await drawLine(
    page,
    { x: box.x + box.width * 0.35, y: box.y + box.height * 0.5 },
    { x: box.x + box.width * 0.62, y: box.y + box.height * 0.5 },
  );
  const mid: UV = [(ends[0]![0] + ends[1]![0]) / 2, (ends[0]![1] + ends[1]![1]) / 2];
  // Calibrate now: drawing may have refit the camera, so a mapping measured
  // before the geometry existed would aim the click somewhere else entirely.
  const toScreen = await planeToScreen(page, box);

  await setTool(page, "select");
  await expect(page.getByTestId("constrain-horizontal")).toBeDisabled();

  // Aim at the segment's MIDPOINT — not an endpoint, so only an entity hit can
  // select it. Confirm the click really lands there before trusting the result.
  const at = await aimAt(page, toScreen, mid);
  await page.mouse.click(at.x, at.y);

  await expect
    .poll(async () =>
      read(page, (s) => {
        const lines = s.model.entities.filter((e) => e.kind === "line").map((e) => e.id);
        return s.selection.some((id) => lines.includes(id));
      }),
    )
    .toBe(true); // the LINE is selected, not one of its endpoints

  // …so the constraints that need a line are reachable at last.
  await expect(page.getByTestId("constrain-horizontal")).toBeEnabled();
  await expect(page.getByTestId("constrain-vertical")).toBeEnabled();
});

test("clicking empty space clears the selection and re-disables the buttons", async ({ page }) => {
  const box = await enterSketch(page);
  const ends = await drawLine(
    page,
    { x: box.x + box.width * 0.35, y: box.y + box.height * 0.5 },
    { x: box.x + box.width * 0.62, y: box.y + box.height * 0.5 },
  );
  const mid: UV = [(ends[0]![0] + ends[1]![0]) / 2, (ends[0]![1] + ends[1]![1]) / 2];
  const toScreen = await planeToScreen(page, box);

  await setTool(page, "select");
  const at = await aimAt(page, toScreen, mid);
  await page.mouse.click(at.x, at.y);
  await expect(page.getByTestId("constrain-horizontal")).toBeEnabled();

  // A point well clear of the segment, in PLANE coords so it is genuinely far.
  const away = await aimAt(page, toScreen, [mid[0] + 0.03, mid[1] + 0.03]);
  await page.mouse.click(away.x, away.y);
  await expect.poll(async () => read(page, (s) => s.selection.length)).toBe(0);
  await expect(page.getByTestId("constrain-horizontal")).toBeDisabled();
});
