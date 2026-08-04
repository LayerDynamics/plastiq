// Strict E2E for the dimension-glyph cleanup (R13/S9): real toolbar buttons,
// pointer drawing, entity selection, solver action, and rendered overlay. Store
// access below is read-only evidence; no component or action is mocked/injected.

import { expect, test, type Page } from "@playwright/test";

type UV = [number, number];

async function cursorAt(page: Page, x: number, y: number): Promise<UV> {
  await page.mouse.move(x, y);
  return page.evaluate(
    () =>
      (
        globalThis as {
          __sketchStore: { getState: () => { cursor: UV | null } };
        }
      ).__sketchStore.getState().cursor!,
  );
}

/** Iteratively invert the live screen→sketch-plane projection around the target. */
async function aimAt(
  page: Page,
  box: { x: number; y: number; width: number; height: number },
  target: UV,
) {
  let x = box.x + box.width / 2;
  let y = box.y + box.height / 2;
  const probe = 20;
  let distance = Number.POSITIVE_INFINITY;

  for (let i = 0; i < 8; i++) {
    const here = await cursorAt(page, x, y);
    distance = Math.hypot(target[0] - here[0], target[1] - here[1]);
    if (distance < 6e-4) break;
    const right = await cursorAt(page, x + probe, y);
    const down = await cursorAt(page, x, y + probe);
    const a = (right[0] - here[0]) / probe;
    const b = (down[0] - here[0]) / probe;
    const c = (right[1] - here[1]) / probe;
    const d = (down[1] - here[1]) / probe;
    const det = a * d - b * c;
    expect(Math.abs(det), "sketch plane must be visible, not edge-on").toBeGreaterThan(1e-12);
    const du = target[0] - here[0];
    const dv = target[1] - here[1];
    x += (d * du - b * dv) / det;
    y += (-c * du + a * dv) / det;
  }

  expect(distance, "pointer must converge onto the rendered segment").toBeLessThan(6e-4);
  return { x, y };
}

test("select-then-constrain shows dimension glyphs for hDistance", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("status")).toHaveText("ready", { timeout: 240_000 });
  await page.getByTestId("enter-sketch").click();
  await expect(page.getByTestId("sketcher")).toBeVisible();

  const canvas = page.locator("#viewport-root canvas");
  const box = (await canvas.boundingBox())!;
  const from = { x: box.x + box.width * 0.38, y: box.y + box.height * 0.58 };
  const to = { x: box.x + box.width * 0.63, y: box.y + box.height * 0.45 };

  await page.getByTestId("tool-line").click();
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 6 });
  await page.mouse.move(to.x, to.y, { steps: 6 });
  await page.mouse.up();

  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            globalThis as {
              __sketchStore: {
                getState: () => { model: { entities: { kind: string }[] } };
              };
            }
          ).__sketchStore
            .getState()
            .model.entities.filter((entity) => entity.kind === "line").length,
      ),
    )
    .toBe(1);

  const target = await page.evaluate(() => {
    const model = (
      globalThis as {
        __sketchStore: {
          getState: () => {
            model: {
              points: { id: string; u: number; v: number }[];
              entities: { kind: string; a?: string; b?: string }[];
            };
          };
        };
      }
    ).__sketchStore.getState().model;
    const line = model.entities.find((entity) => entity.kind === "line")!;
    const a = model.points.find((point) => point.id === line.a)!;
    const b = model.points.find((point) => point.id === line.b)!;
    return [(a.u + b.u) / 2, (a.v + b.v) / 2] as UV;
  });

  await page.getByTestId("tool-select").click();
  // In-place sketching deliberately preserves the user's free-orbit camera. Put
  // the plane normal-to through the real user-facing control before numerically
  // inverting screen→plane coordinates; otherwise an edge-on starting view can
  // make the projection singular even though selection itself is healthy.
  await page.getByTestId("sketch-look-at").click();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  const at = await aimAt(page, box, target);
  await page.mouse.click(at.x, at.y);
  await expect(page.getByTestId("dim-hDistance")).toBeEnabled();
  await page.getByTestId("dim-hDistance").click();

  // Glyphs mount after the constraint solve + overlay paint.
  await expect(page.getByTestId("dimension-glyph")).toBeVisible();
  const info = await page.evaluate(() => {
    const state = (
      globalThis as {
        __sketchStore: {
          getState: () => {
            model: { constraints: { kind: string }[] };
            resolvedFrame: unknown;
          };
        };
      }
    ).__sketchStore.getState();
    return {
      constraints: state.model.constraints.map((constraint) => constraint.kind),
      hasFrame: state.resolvedFrame != null,
    };
  });
  expect(info.constraints).toContain("hDistance");
  expect(info.hasFrame).toBe(true);
});
