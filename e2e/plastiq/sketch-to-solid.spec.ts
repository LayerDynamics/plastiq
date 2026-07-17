// SPEC-5 M3.7 — strict E2E (no mocks): the whole sketcher spine. In a real
// browser: enter sketch mode, draw a closed triangular profile through the real
// sketch slice (constraint solve on the main thread), Finish → a `sketch`
// feature, then Extrude → the worker rebuilds a real OCCT solid. We assert the
// extruded triangular prism has 5 faces (≠ the seeded box's 6), proving the
// drawn profile drove the kernel geometry end-to-end.
//
// The draw is driven through the sketch store (the advisor's endorsed approach —
// the sketch slice, not pixel-hunting on the SVG); Finish/Extrude are real UI.

import { expect, test } from "@playwright/test";

declare global {
  // eslint-disable-next-line no-var
  var faceCount: () => number;
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    (globalThis as { faceCount?: () => number }).faceCount = () => {
      const scene = (
        globalThis as {
          __plastiqViewport?: { builtPart: { mesh: { userData: { faceIds?: number[] } } } | null };
        }
      ).__plastiqViewport;
      return scene?.builtPart?.mesh.userData.faceIds?.length ?? 0;
    };
  });
});

test("draw a triangle → Finish → Extrude → a 5-faced prism", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("status")).toHaveText("ready", { timeout: 240_000 });
  expect(await page.evaluate(() => faceCount())).toBe(6); // seeded box

  // Start from an EMPTY document so the extrude produces the prism in isolation.
  // The default session seeds a starter box; because extrude now joins the
  // current body by default (§2.4/C1), a triangle drawn at z=0 extrudes UP into
  // the box and merges invisibly — the union is still the box (faceCount stays 6,
  // the prism vanishes). Removing the incidental seed makes this test the
  // "user's first feature" flow it is named for. (The join-onto-seed behaviour
  // itself is tracked in FablesFindings under §2.4.)
  await page.evaluate(() =>
    (globalThis as { __cadStore?: { getState: () => { loadDocument: (d: unknown) => void } } })
      .__cadStore!.getState()
      .loadDocument({ features: [], params: {} }),
  );
  // An empty document builds no solid → the status reads "empty", not "ready".
  await expect(page.getByTestId("status")).toHaveText("empty", { timeout: 240_000 });
  expect(await page.evaluate(() => faceCount())).toBe(0);

  // Enter sketch mode via the real toolbar button.
  await page.getByTestId("enter-sketch").click();
  await expect(page.getByTestId("sketcher")).toBeVisible();

  // Draw a closed triangle through the sketch slice (world coords, metres),
  // closing the loop by reusing the first point.
  await page.evaluate(() => {
    const store = (globalThis as { __sketchStore?: { getState: () => Record<string, unknown> } })
      .__sketchStore!;
    const st = () =>
      store.getState() as {
        setTool: (t: string) => void;
        clickAt: (u: number, v: number, o?: { reusePointId?: string }) => void;
        model: { points: { id: string }[] };
      };
    st().setTool("line");
    st().clickAt(0, 0);
    const firstId = st().model.points[0]!.id;
    st().clickAt(0.04, 0);
    st().clickAt(0.02, 0.03);
    st().clickAt(0, 0, { reusePointId: firstId }); // close the loop
  });

  // Finish commits the profile into a sketch feature and leaves the editor.
  await expect(page.getByTestId("sketch-finish")).toBeEnabled();
  await page.getByTestId("sketch-finish").click();
  await expect(page.getByTestId("sketcher")).toHaveCount(0);
  await expect(page.getByTestId("feature-row")).toHaveCount(1); // just the sketch (empty doc)

  // Extrude the active profile → a triangular prism.
  await page.getByTestId("feature-menu").getByText("Extrude", { exact: true }).click();
  await expect(page.getByTestId("status")).toHaveText("ready", { timeout: 240_000 });
  await page.waitForFunction(() => faceCount() === 5, undefined, { timeout: 240_000 });
  expect(await page.evaluate(() => faceCount())).toBe(5); // 2 caps + 3 sides
});
