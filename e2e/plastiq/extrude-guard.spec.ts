// ADR-0014: Extrude/Cut/Revolve without a profile open a feature-driven sketch
// (no longer hard-disabled). With a profile, Extrude still appends a solid feature.

import { expect, test } from "@playwright/test";

test("Extrude without profile opens a feature-driven sketch session", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("status")).toHaveText("ready", { timeout: 240_000 });

  // No sketch yet — Extrude is still enabled (opens sketch), not hard-disabled.
  await expect(page.getByTestId("add-extrude")).toBeEnabled();
  await page.getByTestId("add-extrude").click();
  await expect(page.getByTestId("sketcher")).toBeVisible({ timeout: 30_000 });

  // Cancel leaves no poisoned rebuild.
  await page.getByTestId("sketch-close").click();
  await expect(page.getByTestId("sketcher")).toHaveCount(0);
  await expect(page.getByTestId("status")).toHaveText("ready", { timeout: 240_000 });
});

test("Extrude with a profile rebuilds cleanly", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("status")).toHaveText("ready", { timeout: 240_000 });

  // Quick-add Sketch injects a default rectangle profile without the sketcher.
  await page.getByTestId("feature-menu").getByText("Sketch", { exact: true }).click();
  await page.getByTestId("add-extrude").click();
  await expect(page.getByTestId("status")).toHaveText("ready", { timeout: 240_000 });
});
