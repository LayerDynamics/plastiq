// Regression (no mock): Extrude/Cut/Revolve are gated on an upstream sketch
// profile. Before, clicking Extrude on the seeded box (no sketch) appended a
// feature that hard-failed the whole rebuild ("no sketch profile upstream") and
// poisoned every later rebuild — the app looked permanently broken. Now the
// buttons are disabled until a profile exists, and enabled they build cleanly.

import { expect, test } from "@playwright/test";

test("Extrude/Cut/Revolve are disabled with no sketch, enabled + working with one", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByTestId("status")).toHaveText("ready", { timeout: 240_000 });

  // Seeded box only → no sketch profile → the profile-consuming features are off.
  await expect(page.getByTestId("add-extrude")).toBeDisabled();
  await expect(page.getByTestId("add-cut")).toBeDisabled();
  await expect(page.getByTestId("add-revolve")).toBeDisabled();

  // Add a sketch profile (the quick-add Sketch uses a default rectangle).
  await page.getByTestId("feature-menu").getByText("Sketch", { exact: true }).click();

  // Now the buttons enable.
  await expect(page.getByTestId("add-extrude")).toBeEnabled();
  await expect(page.getByTestId("add-cut")).toBeEnabled();
  await expect(page.getByTestId("add-revolve")).toBeEnabled();

  // Extruding the profile rebuilds cleanly — status returns to "ready", never the
  // "rebuild failed: … no sketch profile upstream" that the old ungated click hit.
  await page.getByTestId("add-extrude").click();
  await expect(page.getByTestId("status")).toHaveText("ready", { timeout: 240_000 });
});
