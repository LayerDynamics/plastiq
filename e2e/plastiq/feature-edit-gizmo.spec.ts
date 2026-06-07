// E2E (no mock): the interactive feature-edit gizmo previews the real solid LIVE.
// Draw a profile → Extrude → the gizmo's value box appears (store.activeFeatureEdit);
// typing a new height rebuilds the real OCCT solid to that height. We assert the
// *rendered solid's Z extent actually changes*, not merely that the gizmo rendered —
// that's the whole point of a live manipulator. ✓ commits (feature stays); ✕ cancels
// (feature removed, back to the seeded box).
//
// The 3D drag handle itself is not driven here (drei TransformControls drags are
// flaky headless — the documented codebase convention); its position→value write-back
// is unit-tested (featureGizmo.test) and the value-box path is the deterministic E2E.

import { expect, test, type Page } from "@playwright/test";

declare global {
  // eslint-disable-next-line no-var
  var solidHeight: () => number;
  // eslint-disable-next-line no-var
  var faceCount: () => number;
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const vp = (): {
      builtPart: {
        mesh: {
          geometry: { boundingBox: { min: { z: number }; max: { z: number } } | null; computeBoundingBox(): void };
          userData: { faceIds?: number[] };
        };
      } | null;
    } | undefined =>
      (globalThis as { __plastiqViewport?: ReturnType<typeof vp> }).__plastiqViewport;
    (globalThis as { solidHeight?: () => number }).solidHeight = () => {
      const g = vp()?.builtPart?.mesh.geometry;
      if (!g) return 0;
      g.computeBoundingBox();
      return g.boundingBox ? g.boundingBox.max.z - g.boundingBox.min.z : 0;
    };
    (globalThis as { faceCount?: () => number }).faceCount = () =>
      vp()?.builtPart?.mesh.userData.faceIds?.length ?? 0;
  });
});

const editActive = (page: Page): Promise<boolean> =>
  page.evaluate(
    () =>
      (globalThis as { __cadStore?: { getState(): { activeFeatureEdit: unknown } } }).__cadStore!.getState()
        .activeFeatureEdit != null,
  );

const gizmoShown = (page: Page): Promise<boolean> =>
  page.evaluate(
    () =>
      (globalThis as { __plastiqViewport?: { gizmos?: Record<string, boolean> } }).__plastiqViewport?.gizmos
        ?.featureEdit === true,
  );

const extrudeHeight = (page: Page): Promise<number> =>
  page.evaluate(() => {
    const f = (
      globalThis as {
        __cadStore?: { getState(): { features: { type: string; params?: Record<string, number> }[] } };
      }
    )
      .__cadStore!.getState()
      .features.find((x) => x.type === "extrude");
    return f?.params?.height ?? 0;
  });

/** Boot, draw a closed triangle, Finish, and Extrude it — leaving an active edit. */
async function drawTriangleAndExtrude(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByTestId("status")).toHaveText("ready", { timeout: 240_000 });
  await page.getByTestId("enter-sketch").click();
  await expect(page.getByTestId("sketcher")).toBeVisible();
  await page.evaluate(() => {
    const st = () =>
      (
        globalThis as {
          __sketchStore?: {
            getState: () => {
              setTool(t: string): void;
              clickAt(u: number, v: number, o?: { reusePointId?: string }): void;
              model: { points: { id: string }[] };
            };
          };
        }
      ).__sketchStore!.getState();
    st().setTool("line");
    st().clickAt(0, 0);
    const first = st().model.points[0]!.id;
    st().clickAt(0.04, 0);
    st().clickAt(0.02, 0.03);
    st().clickAt(0, 0, { reusePointId: first }); // close the loop
  });
  await expect(page.getByTestId("sketch-finish")).toBeEnabled();
  await page.getByTestId("sketch-finish").click();
  await expect(page.getByTestId("sketcher")).toHaveCount(0);
  await page.getByTestId("feature-menu").getByText("Extrude", { exact: true }).click();
  await page.waitForFunction(() => faceCount() === 5, undefined, { timeout: 240_000 }); // prism built
}

test("typing a new height in the gizmo previews the real solid live", async ({ page }) => {
  await drawTriangleAndExtrude(page);

  // The extrude opened an active edit → the gizmo + its value box are present.
  await expect.poll(() => editActive(page)).toBe(true);
  await expect.poll(() => gizmoShown(page)).toBe(true);
  await expect(page.getByTestId("feature-edit-box")).toBeVisible();

  const h0 = await page.evaluate(() => solidHeight());
  expect(h0).toBeGreaterThan(0.015); // ~20mm default extrude
  expect(h0).toBeLessThan(0.025);

  // Type 50mm → the param updates AND the OCCT solid rebuilds taller (live preview).
  await page.getByTestId("feature-edit-value").fill("50");
  await expect.poll(() => extrudeHeight(page)).toBeCloseTo(0.05, 3);
  await page.waitForFunction(() => solidHeight() > 0.04, undefined, { timeout: 240_000 });
  const h1 = await page.evaluate(() => solidHeight());
  expect(h1).toBeGreaterThan(h0); // the RENDERED solid actually grew
  expect(h1).toBeCloseTo(0.05, 2);

  // ✓ commits: the edit clears, but the feature (and its 50mm height) stays.
  await page.getByTestId("feature-edit-commit").click();
  await expect.poll(() => editActive(page)).toBe(false);
  expect(await extrudeHeight(page)).toBeCloseTo(0.05, 3);
  expect(await page.evaluate(() => faceCount())).toBe(5); // prism still there
});

test("cancel (✕) removes the just-created extrude — back to the seeded box", async ({ page }) => {
  await drawTriangleAndExtrude(page);
  await expect.poll(() => editActive(page)).toBe(true);

  await page.getByTestId("feature-edit-cancel").click();
  await expect.poll(() => editActive(page)).toBe(false);
  // The extrude feature is gone → the build falls back to the seeded box (6 faces).
  await page.waitForFunction(() => faceCount() === 6, undefined, { timeout: 240_000 });
  expect(await extrudeHeight(page)).toBe(0); // no extrude feature remains
});
