// SPEC-5 FR-40 — strict E2E (no mocks): crash recovery from the last autosave.
// Edit an untitled document (never saved to a named project), reload the page
// (simulating a crash), and the app offers to recover the unsaved work; clicking
// Recover restores the edited feature tree.

import { expect, test } from "@playwright/test";

async function waitReady(page: import("@playwright/test").Page): Promise<void> {
  await expect(page.getByTestId("status")).toHaveText("ready", { timeout: 240_000 });
}

test("recovers an unsaved (untitled) document after a reload (FR-40)", async ({ page }) => {
  await page.goto("/");
  await waitReady(page);
  const before = await page.getByTestId("feature-row").count();

  // Edit the untitled document: add a feature → the recovery snapshot is written.
  // "Rectangle" (sample-rect) adds a sketch feature in one click without opening
  // the sketcher; targeted by testid. The old getByText("Sketch") opened the
  // sketcher instead, adding no feature.
  await page.getByTestId("act-sample-rect").click();
  await expect(page.getByTestId("feature-row")).toHaveCount(before + 1);

  // The recovery snapshot is debounced — wait until it has actually been written
  // before simulating the crash.
  await page.waitForFunction(
    () => localStorage.getItem("plastiq:recovery") !== null,
    undefined,
    {
      timeout: 5000,
    },
  );

  // Simulate a crash: reload before any named save. The recovery banner appears.
  await page.reload();
  await waitReady(page);
  await expect(page.getByTestId("recovery-banner")).toBeVisible({ timeout: 30_000 });
  // A fresh session starts from the seeded default (the edit isn't applied yet).
  await expect(page.getByTestId("feature-row")).toHaveCount(before);

  // Recover → the edited tree (with the extra feature) is restored.
  await page.getByTestId("recovery-restore").click();
  await expect(page.getByTestId("feature-row")).toHaveCount(before + 1);
  await expect(page.getByTestId("recovery-banner")).toHaveCount(0);
});
