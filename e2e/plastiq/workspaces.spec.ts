// E2E (no mock): Fusion-style workspaces with the tools in the LEFT SIDEBAR. The
// top-left switcher flips Design / Assemble / Simulate; the slim top strip holds
// only global controls, and the active workspace's TOOLS live in the sidebar
// (WorkspacePanel) as collapsible groups. Verifies the switch reconfigures the
// sidebar, that tools are in the sidebar (not the top strip), that the top strip
// stays slim (no horizontal scroll), and the contextual Sketch group + commit.

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

const numField = (page: Page, field: "simulating" | "simTicks" | "explodeFactor" | "mateMode") =>
  page.evaluate(
    (f) =>
      (globalThis as { __cadStore?: { getState(): Record<string, unknown> } }).__cadStore!.getState()[
        f
      ],
    field,
  );

const panel = (page: Page) => page.getByTestId("workspace-panel");
const topbar = (page: Page) => page.getByTestId("topbar");

test("the switcher swaps the sidebar's tools per workspace", async ({ page }) => {
  await bootReady(page);

  // Design: modelling tools in the sidebar (Create group open by default).
  await expect(panel(page).getByTestId("add-extrude")).toBeVisible();

  // Assemble: insert-instance appears; modelling tools gone.
  await page.getByTestId("workspace-switcher").selectOption("assemble");
  await expect(panel(page).getByTestId("act-insert-instance")).toBeVisible();
  await expect(page.getByTestId("add-extrude")).toHaveCount(0);

  // Simulate: playback appears + the sim starts; modelling gone.
  await page.getByTestId("workspace-switcher").selectOption("simulate");
  await expect(panel(page).getByTestId("act-sim-pause")).toBeVisible();
  await expect.poll(() => numField(page, "simulating")).toBe(true);

  // Back to Design.
  await page.getByTestId("workspace-switcher").selectOption("design");
  await expect.poll(() => numField(page, "simulating")).toBe(false);
  await expect(panel(page).getByTestId("add-extrude")).toBeVisible();
});

test("tools live in the sidebar, not the slim top strip", async ({ page }) => {
  await bootReady(page);
  // The modelling tools are in the sidebar panel, NOT the top strip.
  await expect(panel(page).getByTestId("add-extrude")).toBeVisible();
  await expect(topbar(page).getByTestId("add-extrude")).toHaveCount(0);
  // The top strip stays slim — it does not scroll horizontally.
  const fits = await page.evaluate(() => {
    const t = document.querySelector('[data-testid="topbar"]') as HTMLElement | null;
    return t ? t.scrollWidth <= t.clientWidth + 1 : false;
  });
  expect(fits).toBe(true);
});

test("Assemble: insert instances + enter mate mode from the sidebar", async ({ page }) => {
  await bootReady(page);
  await page.getByTestId("workspace-switcher").selectOption("assemble");

  await page.getByTestId("act-insert-instance").click();
  await page.getByTestId("act-insert-instance").click();
  await expect.poll(() => instanceCount(page)).toBe(2);

  // Groups are expanded by default → Mate mode is visible in the Relationships group.
  await page.getByTestId("act-mate-mode").click();
  await expect.poll(() => numField(page, "mateMode")).toBe(true);
});

test("Simulate: playback + elapsed readout in the sidebar", async ({ page }) => {
  await bootReady(page);
  await page.getByTestId("workspace-switcher").selectOption("simulate");
  await expect.poll(() => numField(page, "simulating")).toBe(true);
  await expect(page.getByTestId("sim-time")).toBeVisible();

  // Pause, then step one frame → elapsed sim time advances.
  await page.getByTestId("act-sim-pause").click();
  const t0 = (await numField(page, "simTicks")) as number;
  await page.getByTestId("act-sim-step").click();
  await expect.poll(() => numField(page, "simTicks") as Promise<number>).toBeGreaterThan(t0);
});

test("the Sketch group is contextual — present only while sketching", async ({ page }) => {
  await bootReady(page);
  // Not sketching → no Finish.
  await expect(page.getByTestId("act-sk-finish")).toHaveCount(0);

  await expect(page.getByTestId("enter-sketch")).toBeEnabled({ timeout: 240_000 });
  await page.getByTestId("enter-sketch").click();
  await expect(page.getByTestId("sketcher")).toBeVisible();
  await expect(panel(page).getByTestId("act-sk-finish")).toBeVisible();

  // Cancel via the sketcher overlay → the Sketch group clears.
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByTestId("sketcher")).toBeHidden();
  await expect(page.getByTestId("act-sk-finish")).toHaveCount(0);
});

test("the Sketch group's Finish commits the sketch (no data loss)", async ({ page }) => {
  await bootReady(page);
  const sketchCount = (): Promise<number> =>
    page.evaluate(
      () =>
        (globalThis as { __cadStore?: { getState(): { features: { type: string }[] } } }).__cadStore!
          .getState()
          .features.filter((f) => f.type === "sketch").length,
    );
  const before = await sketchCount(page);

  await expect(page.getByTestId("enter-sketch")).toBeEnabled({ timeout: 240_000 });
  await page.getByTestId("enter-sketch").click();
  await expect(page.getByTestId("sketcher")).toBeVisible();
  await page.evaluate(() => {
    const st = () =>
      (
        globalThis as {
          __sketchStore?: {
            getState(): {
              setTool(t: string): void;
              clickAt(u: number, v: number, o?: { reusePointId?: string }): void;
              model: { points: { id: string }[] };
            };
          };
        }
      ).__sketchStore!.getState();
    st().setTool("line");
    st().clickAt(0, 0);
    const firstId = st().model.points[0]!.id;
    st().clickAt(0.03, 0);
    st().clickAt(0.015, 0.02);
    st().clickAt(0, 0, { reusePointId: firstId });
  });

  await expect(panel(page).getByTestId("act-sk-finish")).toBeEnabled();
  await panel(page).getByTestId("act-sk-finish").click();
  await expect(page.getByTestId("sketcher")).toBeHidden();
  await expect.poll(() => sketchCount(page)).toBe(before + 1);
});
