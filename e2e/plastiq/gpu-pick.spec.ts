// SPEC-5 NFR-4 — strict E2E (no mocks): the GPU colour-id face pick. The seeded
// box renders via real OCCT; we render the id buffer in a real WebGL context and
// read back the faceId under the centre (hit) and a far corner (miss). This is
// the verification the codec unit test can't give — it proves the render pass +
// byte-exact readback are correct end-to-end.

import { expect, test } from "@playwright/test";

declare global {
  // eslint-disable-next-line no-var
  var __plastiqGpuPick: ((ndcX: number, ndcY: number) => number | null) | undefined;
}

async function waitReady(page: import("@playwright/test").Page): Promise<void> {
  await expect(page.getByTestId("status")).toHaveText("ready", { timeout: 240_000 });
}

test("GPU colour-id pick resolves a face at centre and misses off-part (NFR-4)", async ({
  page,
}) => {
  await page.goto("/");
  await waitReady(page);

  // Centre of the viewport is over the box → a real faceId (≥ 0).
  const hit = await page.evaluate(() => globalThis.__plastiqGpuPick?.(0, 0) ?? null);
  expect(hit).not.toBeNull();
  expect(hit).toBeGreaterThanOrEqual(0);

  // A far corner of NDC is off the part → the cleared buffer → null (a miss).
  const miss = await page.evaluate(() => globalThis.__plastiqGpuPick?.(-0.98, -0.98) ?? null);
  expect(miss).toBeNull();
});
