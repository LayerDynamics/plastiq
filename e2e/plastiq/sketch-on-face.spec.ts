// E2E (no mock): pick a model face, then "On Face" opens the sketcher on that
// face — the camera re-orients normal-to it (resolved through the worker, since
// the main thread can't run OCCT) behind the transparent overlay. Drives the real
// pick path → store → Toolbar → sketch store → viewport → SceneController.

import { expect, test } from "@playwright/test";

test("sketch on a picked face opens the sketcher normal-to that face", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#viewport-root canvas")).toBeVisible();
  await expect(page.getByTestId("status")).toHaveText("ready", { timeout: 240_000 });
  await page.waitForFunction(
    () =>
      (globalThis as { __plastiqViewport?: { builtPart: unknown } }).__plastiqViewport?.builtPart != null,
    undefined,
    { timeout: 240_000 },
  );
  // Frame the part so the centre ray lands on a face; let the tween settle.
  await page.evaluate(() =>
    (globalThis as { __plastiqViewport?: { fitToView(): void } }).__plastiqViewport?.fitToView?.(),
  );
  await page.waitForTimeout(700);

  await expect(page.getByTestId("enter-sketch")).toBeEnabled({ timeout: 240_000 });
  // Nothing selected → "On Face" is disabled.
  await expect(page.getByTestId("sketch-on-face")).toBeDisabled();

  // Pick a face via the real pointer path (a centre click on the framed part).
  const canvas = page.locator("#viewport-root canvas");
  const b = (await canvas.boundingBox())!;
  await page.evaluate(
    ([x, y]) => {
      const el = document.querySelector("#viewport-root canvas")!;
      const opts = { clientX: x, clientY: y, bubbles: true } as PointerEventInit;
      el.dispatchEvent(new PointerEvent("pointerdown", opts));
      el.dispatchEvent(new PointerEvent("pointerup", opts));
    },
    [b.x + b.width / 2, b.y + b.height / 2],
  );

  // A face is selected → "On Face" enables.
  await expect(page.getByTestId("sketch-on-face")).toBeEnabled();

  const shot = (): Promise<string> =>
    page.evaluate(
      () => (document.querySelector("#viewport-root canvas") as HTMLCanvasElement).toDataURL(),
    );
  const before = await shot();

  await page.getByTestId("sketch-on-face").click();
  await expect(page.getByTestId("sketcher")).toBeVisible();
  // The worker resolves the face frame (async) and the camera re-orients normal-to
  // it → the canvas render changes.
  await expect.poll(async () => (await shot()) !== before, { timeout: 60_000 }).toBe(true);
  // Transparent overlay → the model shows through (the S2 behaviour, on a face).
  const bg = await page
    .getByTestId("sketcher")
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bg).toBe("rgba(0, 0, 0, 0)");
});
