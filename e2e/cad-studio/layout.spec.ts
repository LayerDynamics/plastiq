// SPEC-5 FR-4 — strict E2E (no mocks): resizable/collapsible panels. Collapsing
// a side panel hides it and leaves a re-open tab; expanding restores it. (The
// resize splitter is a draggable separator; its presence is asserted here.)

import { expect, test } from "@playwright/test";

async function waitReady(page: import("@playwright/test").Page): Promise<void> {
  await expect(page.getByTestId("status")).toHaveText("ready", { timeout: 240_000 });
}

test("side panels collapse and expand; splitters present (FR-4)", async ({ page }) => {
  await page.goto("/");
  await waitReady(page);

  // Both panels visible, with resize splitters between them and the viewport.
  await expect(page.getByTestId("feature-tree")).toBeVisible();
  await expect(page.getByRole("complementary", { name: "Properties" })).toBeVisible();
  await expect(page.getByTestId("panel-splitter")).toHaveCount(2);

  // Collapse the feature panel → its tree is gone, a re-open tab appears.
  await page.getByLabel("Collapse feature panel").click();
  await expect(page.getByTestId("feature-tree")).toHaveCount(0);
  await expect(page.getByTestId("expand-left")).toBeVisible();
  await expect(page.getByTestId("panel-splitter")).toHaveCount(1); // only the right one left

  // Expand it again → the tree is back.
  await page.getByTestId("expand-left").click();
  await expect(page.getByTestId("feature-tree")).toBeVisible();

  // Collapse the properties panel likewise.
  await page.getByLabel("Collapse properties panel").click();
  await expect(page.getByRole("complementary", { name: "Properties" })).toHaveCount(0);
  await expect(page.getByTestId("expand-right")).toBeVisible();
});
