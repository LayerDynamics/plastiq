// Regression (HiDPI): on a devicePixelRatio=2 display the viewport canvas must
// DISPLAY at its host's CSS size (the WebGL drawing buffer is 2x for crispness).
// A prior bug called renderer.setSize(w, h, false) with no canvas CSS, so the
// canvas displayed at the 2x buffer size, overflowed the host, and rendered the
// scene off the visible viewport — a blank canvas on Retina. The default Desktop
// Chrome project runs at dpr=1, so only this spec exercises the HiDPI path.

import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1000, height: 700 }, deviceScaleFactor: 2 });

// Tolerances for the layout assertions, named so the intent of each bound is clear.
const LAYOUT = {
  // Browsers report fractional CSS pixels; under dpr=2 a panel can land a hair over
  // the window from rounding alone, with no real overflow. Allow 1px of slack.
  OVERFLOW_TOLERANCE_PX: 1,
  // The viewport sits between two fixed side rails, so its healthy aspect here is
  // ~0.7 (taller than wide). The layout bug stretched it to ~3.1. 2.2 is a ceiling
  // that flags that regression with wide margin while tolerating window-size drift.
  MAX_VIEWPORT_ASPECT: 2.2,
} as const;

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
  // Readiness via the public status signal (testid="status" → "ready"), not an
  // internal global: the layout is fixed by the grid/flex shell, which is in place
  // long before geometry finishes building, so the built part is irrelevant here.
  await expect(page.getByTestId("status")).toHaveText("ready", { timeout: 240_000 });

  // Address the viewport through its accessible landmark (<main aria-label="3D
  // viewport">) rather than a CSS id, so the check survives className/id refactors.
  const box = await page.getByRole("main", { name: "3D viewport" }).boundingBox();
  if (!box) throw new Error("viewport <main> reported no bounding box");
  const { innerW, bodyScrollW } = await page.evaluate(() => ({
    innerW: window.innerWidth,
    bodyScrollW: document.body.scrollWidth,
  }));

  // No horizontal page overflow. Regression guard for two layout bugs:
  //  - the App grid had an implicit `auto` column that sized to its content, so
  //    the viewport ballooned to ~2× the window (aspect ~3) and the scene rendered
  //    off-screen — fixed with grid-cols-1 + min-w-0 on the flex row/main;
  //  - the dense toolbar row then widened the page — contained with overflow-x-auto.
  expect(bodyScrollW).toBeLessThanOrEqual(innerW + LAYOUT.OVERFLOW_TOLERANCE_PX);
  // The viewport panel fits inside the window (≤, allowing sub-pixel slack) ...
  expect(box.width).toBeLessThanOrEqual(innerW + LAYOUT.OVERFLOW_TOLERANCE_PX);
  // ... with a sane aspect — the bug stretched it to ~3.1.
  expect(box.width / box.height).toBeLessThan(LAYOUT.MAX_VIEWPORT_ASPECT);
});
