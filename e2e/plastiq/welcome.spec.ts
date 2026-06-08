// E2E (no mock): the first-run welcome / how-to overlay. The rest of the suite runs
// with the "welcome dismissed" flag pre-seeded (playwright.config storageState), so
// this spec OVERRIDES storageState to empty to exercise the real first-run flow:
// the overlay shows, teaches the workflow, dismisses, and only persists "don't show
// again" when the box is ticked; the top-bar "?" reopens it.

import { expect, test } from "@playwright/test";

// Empty state → no welcomeHidden flag → the overlay shows on load.
test.use({ storageState: { cookies: [], origins: [] } });

test("shows on first load with the get-started guide", async ({ page }) => {
  await page.goto("/");
  const welcome = page.getByTestId("welcome");
  await expect(welcome).toBeVisible();
  await expect(welcome).toContainText("Welcome to Plastiq");
  await expect(welcome).toContainText("Get started in 3 steps");
  await expect(welcome).toContainText("Pick a workspace");
  await expect(welcome).toContainText("Sketch a profile");
  await expect(welcome).toContainText("Turn it into a solid");
  await expect(welcome).toContainText("Keyboard"); // the cheat-sheet section
});

test("dismissing without the checkbox shows it again next load", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("welcome")).toBeVisible();
  await page.getByTestId("welcome-dismiss").click();
  await expect(page.getByTestId("welcome")).toBeHidden();
  await page.reload();
  await expect(page.getByTestId("welcome")).toBeVisible(); // not persisted → shows again
});

test("'Don't show this again' persists across reloads", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("welcome")).toBeVisible();
  await page.getByTestId("welcome-dont-show").check();
  await page.getByTestId("welcome-dismiss").click();
  await expect(page.getByTestId("welcome")).toBeHidden();
  await page.reload();
  await expect(page.getByTestId("welcome")).toBeHidden(); // stays dismissed
});

test("the top-bar ? button reopens the guide after it's been closed", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("welcome-dont-show").check();
  await page.getByTestId("welcome-dismiss").click();
  await expect(page.getByTestId("welcome")).toBeHidden();
  await page.getByTestId("welcome-help").click();
  await expect(page.getByTestId("welcome")).toBeVisible(); // reopened on demand
});
