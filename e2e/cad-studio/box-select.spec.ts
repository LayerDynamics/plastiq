// SPEC-5 FR-10 — strict E2E (no mocks): rubber-band box select in the real 3D
// viewport. The seeded box renders via real OCCT; a Shift-drag rectangle over
// the part selects multiple faces at once (read back from the live store).

import { expect, test } from "@playwright/test";

async function waitReady(page: import("@playwright/test").Page): Promise<void> {
  await expect(page.getByTestId("status")).toHaveText("ready", { timeout: 240_000 });
}

function pickCount(page: import("@playwright/test").Page): Promise<number> {
  return page.evaluate(
    () =>
      (globalThis as { __cadStore?: { getState(): { picks: unknown[] } } }).__cadStore?.getState()
        .picks.length ?? -1,
  );
}

test("Shift-drag box-selects multiple faces (FR-10)", async ({ page }) => {
  await page.goto("/");
  await waitReady(page);
  expect(await pickCount(page)).toBe(0);

  const canvas = page.locator("canvas").first();
  const box = (await canvas.boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  // Shift-drag a generous rectangle around the part centre.
  await page.mouse.move(cx - box.width * 0.3, cy - box.height * 0.3);
  await page.keyboard.down("Shift");
  await page.mouse.down();
  await page.mouse.move(cx + box.width * 0.3, cy + box.height * 0.3, { steps: 12 });
  await page.mouse.up();
  await page.keyboard.up("Shift");

  // The rubber-band selected more than one face.
  await expect.poll(() => pickCount(page), { timeout: 30_000 }).toBeGreaterThan(1);
});
