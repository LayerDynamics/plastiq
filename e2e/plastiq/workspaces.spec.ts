// E2E (no mock): Fusion-style workspaces. The top-left switcher flips Design /
// Assemble / Simulate; each shows its own tabbed ribbon of tools. Verifies the
// switch reconfigures the ribbon + drives real state, that the ribbon fits without
// horizontal scrolling (the fix for the old scrolling toolbar), and that SKETCH is
// a contextual tab present only while sketching.

import { expect, test, type Page } from "@playwright/test";

async function bootReady(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByTestId("status")).toHaveText("ready", { timeout: 240_000 });
  await page.waitForFunction(
    () =>
      (globalThis as { __plastiqViewport?: { builtPart: unknown } }).__plastiqViewport?.builtPart !=
      null,
    undefined,
    { timeout: 240_000 },
  );
}

const instanceCount = (page: Page): Promise<number> =>
  page.evaluate(
    () =>
      (globalThis as { __cadStore?: { getState(): { assembly: { instances: unknown[] } } } })
        .__cadStore?.getState().assembly.instances.length ?? 0,
  );

const simulating = (page: Page): Promise<boolean> =>
  page.evaluate(
    () =>
      (globalThis as { __cadStore?: { getState(): { simulating: boolean } } }).__cadStore?.getState()
        .simulating ?? false,
  );

test("the switcher flips workspaces and reconfigures the ribbon", async ({ page }) => {
  await bootReady(page);

  // Design is the default workspace.
  await expect(page.getByTestId("ribbon-tab-solid")).toBeVisible();
  await expect(page.getByTestId("add-extrude")).toBeVisible();

  // Assemble: the ribbon swaps to the Assemble tab; Insert Instance runs.
  await page.getByTestId("workspace-switcher").selectOption("assemble");
  await expect(page.getByTestId("ribbon-tab-assemble")).toBeVisible();
  await expect(page.getByTestId("ribbon-tab-solid")).toHaveCount(0);
  const before = await instanceCount(page);
  await page.getByTestId("ribbon-insert-instance").click();
  await expect.poll(() => instanceCount(page)).toBe(before + 1);

  // Simulate: switching in starts the sim and shows playback.
  await page.getByTestId("workspace-switcher").selectOption("simulate");
  await expect(page.getByTestId("ribbon-tab-simulate")).toBeVisible();
  await expect.poll(() => simulating(page)).toBe(true);
  await expect(page.getByTestId("ribbon-sim-pause")).toBeVisible();

  // Leaving simulate stops the sim.
  await page.getByTestId("workspace-switcher").selectOption("design");
  await expect.poll(() => simulating(page)).toBe(false);
});

test("the ribbon fits its width without horizontal scrolling", async ({ page }) => {
  await bootReady(page);
  const fits = await page.evaluate(() => {
    const r = document.querySelector('[data-testid="ribbon"]') as HTMLElement | null;
    return r ? r.scrollWidth <= r.clientWidth + 1 : false;
  });
  expect(fits).toBe(true);
});

test("the SKETCH tab is contextual — present only while sketching", async ({ page }) => {
  await bootReady(page);

  // No sketch yet → no SKETCH tab.
  await expect(page.getByTestId("ribbon-tab-sketch")).toHaveCount(0);

  // Enter a sketch → the contextual SKETCH tab appears.
  await expect(page.getByTestId("enter-sketch")).toBeEnabled({ timeout: 240_000 });
  await page.getByTestId("enter-sketch").click();
  await expect(page.getByTestId("sketcher")).toBeVisible();
  await expect(page.getByTestId("ribbon-tab-sketch")).toBeVisible();

  // Leave the sketch → the SKETCH tab clears.
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByTestId("sketcher")).toBeHidden();
  await expect(page.getByTestId("ribbon-tab-sketch")).toHaveCount(0);
});
