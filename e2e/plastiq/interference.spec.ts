// E2E (no mock): the interference check runs the real bounding-box clash test on
// the actual instance geometry and reports a verdict. Drives the full path:
// insert instances → Check button → store nonce → viewport → SceneController world
// AABBs → store result → verdict UI. The two default instances are 80mm apart
// (60mm boxes), so the honest result is "No interference"; positive clash detection
// is covered by interference.test.ts (the findClashes algorithm).

import { expect, test } from "@playwright/test";

test("interference check reports clearance for the default (non-overlapping) instances", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByTestId("status")).toHaveText("ready", { timeout: 240_000 });
  await page.waitForFunction(
    () =>
      (globalThis as { __plastiqScene?: { builtPart: unknown } }).__plastiqScene?.builtPart != null,
    undefined,
    { timeout: 240_000 },
  );

  await page.getByTestId("insert-instance").click();
  await page.getByTestId("insert-instance").click();
  await expect(page.getByTestId("instance-row")).toHaveCount(2);
  await expect(page.getByTestId("clearance-control")).toBeVisible();

  // No verdict until the user runs a check.
  await expect(page.getByTestId("interference-verdict")).toHaveCount(0);

  await page.getByTestId("check-interference").click();
  // Real geometry: 60mm boxes 80mm apart on +X → no overlap.
  await expect(page.getByTestId("interference-verdict")).toHaveText("No interference");
});
