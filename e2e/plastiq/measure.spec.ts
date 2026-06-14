// SPEC-5 FR-13 — strict E2E (no mocks): the measure tool, end to end. CAD Studio
// loads in a real browser, the worker builds the seeded box with real OCCT, then
// the test enables Measure through the real ribbon button and clicks two points on
// the part with genuine mouse input. Each click drives Picking's pointer handler →
// Picker.pickPoint raycast → measure state machine → store → the on-screen readout,
// exactly as a user would. We assert the readout advances from its prompt to a real
// millimetre measurement (regression guard: the tool was wired to the UI but no
// code ever collected the clicks).

import { expect, test } from "@playwright/test";

declare global {
  // eslint-disable-next-line no-var
  var __plastiqGpuPick: ((ndcX: number, ndcY: number) => number | null) | undefined;
}

async function waitReady(page: import("@playwright/test").Page): Promise<void> {
  await expect(page.locator("#viewport-root canvas")).toBeVisible();
  await expect(page.getByTestId("status")).toHaveText("ready", { timeout: 240_000 });
  await page.waitForFunction(
    () =>
      (globalThis as { __plastiqViewport?: { builtPart: unknown } }).__plastiqViewport?.builtPart !=
      null,
    undefined,
    { timeout: 240_000 },
  );
}

test("Measure collects two clicks and reports the distance (FR-13)", async ({ page }) => {
  await page.goto("/");
  await waitReady(page);

  // Frame the part so clicks near the canvas centre provably land on it, then let
  // the camera tween settle.
  await page.evaluate(() => {
    (globalThis as { __plastiqViewport?: { fitToView(): void } }).__plastiqViewport?.fitToView();
  });
  await page.waitForTimeout(700);

  // Enable the tool through the real ribbon button; the readout appears with its
  // two-point prompt.
  await page.getByTestId("act-measure").first().click();
  const readout = page.getByTestId("measure-readout");
  await expect(readout).toHaveText("Click two points to measure");

  // Find two screen points provably on the part by probing the real GPU-id pick
  // along the box's mid-height (where its silhouette is widest). A non-null faceId
  // means the mesh is under that pixel, so the measure raycast will hit it too. We
  // take points inset from the silhouette edges (≈25%/75% through the hit span) for
  // a clear separation without flirting with the anti-aliased rim.
  const [p1, p2] = await page.evaluate(() => {
    const el = document.querySelector("#viewport-root canvas")!;
    const r = el.getBoundingClientRect();
    const pick = globalThis.__plastiqGpuPick!;
    const toClient = (ndcX: number): { x: number; y: number } => ({
      x: r.left + ((ndcX + 1) / 2) * r.width,
      y: r.top + r.height / 2,
    });
    const hits: number[] = [];
    for (let ndcX = -0.95; ndcX <= 0.95; ndcX += 0.02) {
      if (pick(ndcX, 0) != null) hits.push(ndcX);
    }
    const lo = hits[Math.floor(hits.length * 0.25)]!;
    const hi = hits[Math.floor(hits.length * 0.75)]!;
    return [toClient(lo), toClient(hi)];
  });
  expect(p1.x).not.toBeCloseTo(p2.x, 0); // two genuinely distinct points

  // First click banks a point on the part and the readout asks for the second.
  await page.mouse.click(p1.x, p1.y);
  await expect(readout).toHaveText("Click second point");

  // Second click on a different part point resolves the distance + axis deltas.
  await page.mouse.click(p2.x, p2.y);
  await expect(readout).toHaveText(/^\d+\.\d{2} mm\s+\(Δ .* mm · .* mm · .* mm\)$/);
});
