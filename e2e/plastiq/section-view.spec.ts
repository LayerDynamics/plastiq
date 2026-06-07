// E2E (no mock): the section view clips the real rendered solid. Enabling the
// cut must visibly change the canvas (a clip plane removes part of the solid);
// disabling it must restore the original render. Drives the full path UI →
// store → viewport subscription → SceneController → three.js renderer.clippingPlanes.

import { expect, test } from "@playwright/test";

test("section view clips the model and restores on toggle off", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("status")).toHaveText("ready", { timeout: 240_000 });
  // Wait until the part is actually built — there must be geometry to clip.
  await page.waitForFunction(
    () =>
      (globalThis as { __plastiqViewport?: { builtPart: unknown } }).__plastiqViewport?.builtPart != null,
    undefined,
    { timeout: 240_000 },
  );

  // Two RAFs so the render loop draws with the latest clip-plane state.
  const settle = (): Promise<void> =>
    page.evaluate(
      () =>
        new Promise<void>((res) =>
          requestAnimationFrame(() => requestAnimationFrame(() => res())),
        ),
    );
  // The drawing buffer is preserved (SceneController), so toDataURL is stable.
  const shot = (): Promise<string> =>
    page.evaluate(() => {
      const c = document.querySelector("#viewport-root canvas") as HTMLCanvasElement;
      return c.toDataURL();
    });

  await settle();
  const before = await shot();

  const sectionGizmo = (): Promise<boolean> =>
    page.evaluate(
      () =>
        (globalThis as { __plastiqViewport?: { gizmos?: Record<string, boolean> } })
          .__plastiqViewport?.gizmos?.sectionAnalysis === true,
    );
  expect(await sectionGizmo()).toBe(false); // no cut yet → no section gizmo

  // Enabling the section defaults to a mid-model cut (axis X, t=0.5), which
  // removes the far half of the solid — the render must change.
  await page.getByTestId("section-toggle").click();
  await expect(page.getByTestId("section-axis")).toBeVisible(); // control expanded
  await settle();
  const cut = await shot();
  expect(cut).not.toBe(before);
  await expect.poll(() => sectionGizmo()).toBe(true); // section-analysis quad shown

  // Disabling restores the full solid — identical render (static camera + geometry).
  await page.getByTestId("section-toggle").click();
  await settle();
  const restored = await shot();
  expect(restored).toBe(before);
  await expect.poll(() => sectionGizmo()).toBe(false); // gizmo cleared
});
