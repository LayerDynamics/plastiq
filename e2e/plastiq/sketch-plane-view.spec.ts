// E2E (no mock): opening a sketch on a non-XY plane renders the scene "normal to"
// that plane (a different camera → the canvas changes) and the overlay is now
// transparent (the model shows through), instead of the old opaque flat panel.
// Exiting restores the perspective view. Drives UI → sketch store → viewport →
// SceneController ortho camera.

import { expect, test } from "@playwright/test";

test("sketching on XZ renders normal-to the plane through a transparent overlay", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByTestId("status")).toHaveText("ready", { timeout: 240_000 });
  await page.waitForFunction(
    () =>
      (globalThis as { __plastiqViewport?: { builtPart: unknown } }).__plastiqViewport?.builtPart != null,
    undefined,
    { timeout: 240_000 },
  );

  const settle = (): Promise<void> =>
    page.evaluate(
      () =>
        new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
    );
  const shot = (): Promise<string> =>
    page.evaluate(
      () => (document.querySelector("#viewport-root canvas") as HTMLCanvasElement).toDataURL(),
    );

  await settle();
  const perspective = await shot();

  // New Sketch on XZ (the picker defaults to XY); enabled once planegcs loads.
  await expect(page.getByTestId("enter-sketch")).toBeEnabled({ timeout: 240_000 });
  await page.getByTestId("sketch-plane").selectOption("XZ");
  await page.getByTestId("enter-sketch").click();
  await expect(page.getByTestId("sketcher")).toBeVisible();
  await settle();

  // The scene now renders through the XZ-normal ortho camera → the canvas changed.
  expect(await shot()).not.toBe(perspective);
  // The overlay no longer hides the model — its background is transparent.
  const bg = await page
    .getByTestId("sketcher")
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bg).toBe("rgba(0, 0, 0, 0)");

  // Exit the sketch → back to the perspective view (camera untouched while sketching).
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByTestId("sketcher")).toBeHidden();
  await settle();
  expect(await shot()).toBe(perspective);
});
