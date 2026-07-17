// SPEC-5 NFR-5 — strict E2E (no mocks): accessibility. Asserts the ARIA
// landmarks/roles are present and that the feature tree is operable from the
// keyboard alone (arrow to select, Delete to remove).

import { expect, test } from "@playwright/test";

async function waitReady(page: import("@playwright/test").Page): Promise<void> {
  await expect(page.getByTestId("status")).toHaveText("ready", { timeout: 240_000 });
}

test("ARIA roles + keyboard-operable feature tree (NFR-5)", async ({ page }) => {
  await page.goto("/");
  await waitReady(page);

  // Landmarks / roles are present.
  await expect(page.getByRole("toolbar", { name: "Editor toolbar" })).toBeVisible();
  await expect(page.getByRole("tree", { name: "Feature tree" })).toBeVisible();

  // Add a feature via a one-click ribbon action (Rectangle = the sample-rect
  // profile injector; targeted by testid). This must ADD a feature to the tree,
  // not open the sketcher — "Sketch" now opens the sketcher, which is why the
  // old getByText("Sketch") locator left the tree at one row.
  await page.getByTestId("act-sample-rect").click();
  await expect(page.getByTestId("feature-row")).toHaveCount(2);
  await expect(page.getByRole("treeitem")).toHaveCount(2);

  // Keyboard only: focus the tree, arrow down twice to the 2nd feature, Delete it.
  await page.getByTestId("feature-tree").focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  const second = page.getByTestId("feature-row").nth(1);
  await expect(second).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Delete");
  await expect(page.getByTestId("feature-row")).toHaveCount(1);
});
