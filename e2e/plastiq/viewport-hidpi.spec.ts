// Regression (HiDPI): on a devicePixelRatio=2 display the viewport canvas must
// DISPLAY at its host's CSS size (the WebGL drawing buffer is 2x for crispness).
// A prior bug called renderer.setSize(w, h, false) with no canvas CSS, so the
// canvas displayed at the 2x buffer size, overflowed the host, and rendered the
// scene off the visible viewport — a blank canvas on Retina. The default Desktop
// Chrome project runs at dpr=1, so only this spec exercises the HiDPI path.

import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1000, height: 700 }, deviceScaleFactor: 2 });

test("the viewport canvas fits its host on a HiDPI (dpr=2) display", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("status")).toHaveText("ready", { timeout: 240_000 });
  await page.waitForFunction(
    () =>
      (globalThis as { __plastiqScene?: { builtPart: unknown } }).__plastiqScene?.builtPart !=
      null,
    undefined,
    { timeout: 240_000 },
  );

  const m = await page.evaluate(() => {
    const host = document.querySelector("#viewport-root > div") as HTMLElement;
    const canvas = host.querySelector("canvas") as HTMLCanvasElement;
    const hr = host.getBoundingClientRect();
    const cr = canvas.getBoundingClientRect();
    return {
      dpr: globalThis.devicePixelRatio,
      hostW: hr.width,
      hostH: hr.height,
      dispW: cr.width,
      dispH: cr.height,
      bufW: canvas.width,
    };
  });

  expect(m.dpr).toBe(2);
  // The canvas DISPLAYS at the host's CSS size (the bug made it ~2x → off-screen).
  expect(Math.abs(m.dispW - m.hostW)).toBeLessThan(2);
  expect(Math.abs(m.dispH - m.hostH)).toBeLessThan(2);
  // The backing buffer is dpr-scaled (crisp), i.e. ~2x the displayed width.
  expect(Math.abs(m.bufW - m.hostW * m.dpr)).toBeLessThan(3);
});
