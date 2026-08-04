// Strict browser E2E: rendered Text Commands UI → shared action/store APIs →
// geometry worker → real OCCT rebuild → rendered editor state. No mocks.

import { expect, test } from "@playwright/test";

test("docked Text Commands executes CAD actions and preserves Fusion-style shell behavior", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByTestId("status")).toHaveText("ready", { timeout: 240_000 });

  const panel = page.getByTestId("text-commands");
  const input = page.getByTestId("text-commands-input");
  await expect(panel).toHaveCount(0);
  await page.getByTestId("text-commands-toggle").click();
  await expect(panel).toBeVisible();

  await input.fill("cylinder");
  await input.press("Enter");
  await expect(page.getByTestId("feature-row")).toHaveCount(2);
  await expect(page.getByTestId("status")).toHaveText("ready", { timeout: 240_000 });
  await expect(page.getByTestId("text-commands-log")).toContainText("Ran Cylinder (cylinder)");
  await expect(page.getByTestId("text-commands-log")).toContainText("building");

  await input.fill("param set shellWidth 20mm; parameters");
  await input.press("Enter");
  await expect(page.getByTestId("text-commands-log")).toContainText("shellWidth = 0.02");

  await input.press("ArrowUp");
  await expect(input).toHaveValue("param set shellWidth 20mm; parameters");
  await input.press("Escape");
  await expect(input).toHaveValue("");

  await page.getByLabel("Hide Text Commands").click();
  await expect(panel).toHaveCount(0);
  await page.getByTestId("text-commands-toggle").click();
  await expect(panel).toBeVisible();
  await expect(input).toBeFocused();
});
