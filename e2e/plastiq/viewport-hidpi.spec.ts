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

test("the layout never overflows horizontally and the viewport fits its panel", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("status")).toHaveText("ready", { timeout: 240_000 });
  await page.waitForFunction(
    () =>
      (globalThis as { __plastiqScene?: { builtPart: unknown } }).__plastiqScene?.builtPart != null,
    undefined,
    { timeout: 240_000 },
  );

  const m = await page.evaluate(() => {
    const main = document.querySelector("#viewport-root") as HTMLElement;
    const r = main.getBoundingClientRect();
    return {
      innerW: window.innerWidth,
      bodyScrollW: document.body.scrollWidth,
      mainW: r.width,
      mainH: r.height,
    };
  });

  // No horizontal page overflow. Regression guard for two layout bugs:
  //  - the App grid had an implicit `auto` column that sized to its content, so
  //    the viewport ballooned to ~2× the window (aspect ~3) and the scene rendered
  //    off-screen — fixed with grid-cols-1 + min-w-0 on the flex row/main;
  //  - the dense toolbar row then widened the page — contained with overflow-x-auto.
  expect(m.bodyScrollW).toBeLessThanOrEqual(m.innerW + 1);
  // The viewport panel fits inside the window with a sane aspect (the bug was ~3.1).
  expect(m.mainW).toBeLessThan(m.innerW);
  expect(m.mainW / m.mainH).toBeLessThan(2.2);
});
