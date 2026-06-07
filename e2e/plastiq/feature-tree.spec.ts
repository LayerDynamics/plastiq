// SPEC-5 M2.6 — strict E2E (no mocks): the feature-tree + parametric-feature
// flow. CAD Studio loads in a real browser; the worker builds the seeded box
// with real OCCT; then real toolbar clicks add a Sketch + a Cut, and the tree +
// the rebuilt three.js solid update. We then exercise rollback (suppress
// everything below a point) and suppress on a single feature, asserting the
// kernel re-evaluates each time. Face counts come from the live tagged mesh.

import { expect, test } from "@playwright/test";

declare global {
  // eslint-disable-next-line no-var
  var faceCount: () => number;
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    (globalThis as { faceCount?: () => number }).faceCount = () => {
      const scene = (
        globalThis as {
          __plastiqViewport?: { builtPart: { mesh: { userData: { faceIds?: number[] } } } | null };
        }
      ).__plastiqViewport;
      return scene?.builtPart?.mesh.userData.faceIds?.length ?? 0;
    };
  });
});

async function waitReady(page: import("@playwright/test").Page): Promise<void> {
  await expect(page.getByTestId("status")).toHaveText("ready", { timeout: 240_000 });
}

test("add sketch+cut → pocket; rollback and suppress re-evaluate the kernel", async ({ page }) => {
  await page.goto("/");
  await waitReady(page);
  // The seeded box: 6 faces, one feature row.
  await expect(page.getByTestId("feature-row")).toHaveCount(1);
  expect(await page.evaluate(() => faceCount())).toBe(6);

  // Add a Sketch then a Cut via the real toolbar menu.
  const fm = page.getByTestId("feature-menu");
  await fm.getByText("Sketch", { exact: true }).click();
  await fm.getByText("Cut", { exact: true }).click();

  // Three features now; the cut pockets the box → more than 6 faces.
  await expect(page.getByTestId("feature-row")).toHaveCount(3);
  await waitReady(page);
  await page.waitForFunction(() => faceCount() > 6, undefined, { timeout: 240_000 });
  const pocketFaces = await page.evaluate(() => faceCount());
  expect(pocketFaces).toBeGreaterThan(6);

  // Roll back to before the cut (index 2): the pocket disappears, box is back.
  const cutRow = page.getByTestId("feature-row").nth(2);
  await cutRow.hover();
  await cutRow.getByTitle("Roll back to before this feature").click();
  await waitReady(page);
  await page.waitForFunction(() => faceCount() === 6, undefined, { timeout: 240_000 });
  await expect(page.getByTestId("rollback-resume")).toBeVisible();

  // Resume: the cut re-applies.
  await page.getByTestId("rollback-resume").click();
  await waitReady(page);
  await page.waitForFunction(() => faceCount() > 6, undefined, { timeout: 240_000 });

  // Suppress the cut: the pocket disappears again, tree keeps the (off) feature.
  await cutRow.hover();
  await cutRow.getByTitle("Suppress").click();
  await waitReady(page);
  await page.waitForFunction(() => faceCount() === 6, undefined, { timeout: 240_000 });
  await expect(page.getByTestId("feature-row")).toHaveCount(3);
});

test("right-click context menu: unsuppress then delete a feature (FR-27)", async ({ page }) => {
  await page.goto("/");
  await waitReady(page);
  // Build box → sketch → cut as before.
  const fm = page.getByTestId("feature-menu");
  await fm.getByText("Sketch", { exact: true }).click();
  await fm.getByText("Cut", { exact: true }).click();
  await expect(page.getByTestId("feature-row")).toHaveCount(3);
  await waitReady(page);
  await page.waitForFunction(() => faceCount() > 6, undefined, { timeout: 240_000 });

  const cutRow = page.getByTestId("feature-row").nth(2);
  // Right-click → Suppress via the context menu: pocket disappears.
  await cutRow.click({ button: "right" });
  await expect(page.getByTestId("feature-context-menu")).toBeVisible();
  await page.getByTestId("ctx-suppress").click();
  await waitReady(page);
  await page.waitForFunction(() => faceCount() === 6, undefined, { timeout: 240_000 });
  await expect(page.getByTestId("feature-context-menu")).toHaveCount(0);

  // Right-click → Unsuppress: pocket returns.
  await cutRow.click({ button: "right" });
  await page.getByTestId("ctx-suppress").click(); // label is now "Unsuppress"
  await waitReady(page);
  await page.waitForFunction(() => faceCount() > 6, undefined, { timeout: 240_000 });

  // Right-click → Delete: the cut row is gone, box is back to 6 faces.
  await cutRow.click({ button: "right" });
  await page.getByTestId("ctx-delete").click();
  await waitReady(page);
  await expect(page.getByTestId("feature-row")).toHaveCount(2);
  await page.waitForFunction(() => faceCount() === 6, undefined, { timeout: 240_000 });
});
