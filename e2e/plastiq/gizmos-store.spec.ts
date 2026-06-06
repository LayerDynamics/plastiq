// E2E (no mock): R3 store-backed gizmos render from store state.
//  • origin triad — always present,
//  • object-center marker — present when the build has mass properties,
//  • datum-plane quad — present only while sketching on a datum.
// Presence is read off __plastiqViewport.gizmos (the gizmos live in the canvas).

import { expect, test } from "@playwright/test";

const gizmo = (page: import("@playwright/test").Page, name: string): Promise<boolean> =>
  page.evaluate(
    (n) =>
      (globalThis as { __plastiqViewport?: { gizmos?: Record<string, boolean> } }).__plastiqViewport
        ?.gizmos?.[n] === true,
    name,
  );

test("origin + object-center always present; plane only while sketching", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("status")).toHaveText("ready", { timeout: 240_000 });
  await page.waitForFunction(
    () =>
      (globalThis as { __plastiqViewport?: { builtPart: unknown } }).__plastiqViewport?.builtPart !=
      null,
    undefined,
    { timeout: 240_000 },
  );

  // Origin triad is a constant reference; object-center reads massProps.com, which
  // the seeded box always produces.
  await expect.poll(() => gizmo(page, "origin")).toBe(true);
  await expect.poll(() => gizmo(page, "objectCenter")).toBe(true);

  // No sketch yet → no plane quad.
  expect(await gizmo(page, "plane")).toBe(false);

  // Enter a datum sketch → the plane quad appears.
  await expect(page.getByTestId("enter-sketch")).toBeEnabled({ timeout: 240_000 });
  await page.getByTestId("enter-sketch").click();
  await expect(page.getByTestId("sketcher")).toBeVisible();
  await expect.poll(() => gizmo(page, "plane")).toBe(true);

  // Exit → the plane quad clears.
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByTestId("sketcher")).toBeHidden();
  await expect.poll(() => gizmo(page, "plane")).toBe(false);
});

test("construction-geometry gizmo appears once a construction line is drawn", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("status")).toHaveText("ready", { timeout: 240_000 });
  await expect(page.getByTestId("enter-sketch")).toBeEnabled({ timeout: 240_000 });
  await page.getByTestId("enter-sketch").click();
  await expect(page.getByTestId("sketcher")).toBeVisible();

  // No construction geometry yet.
  expect(await gizmo(page, "constructionGeometry")).toBe(false);

  // Draw a construction line through the sketch slice.
  await page.evaluate(() => {
    const st = () =>
      (
        globalThis as {
          __sketchStore?: {
            getState: () => {
              setConstruction: (b: boolean) => void;
              setTool: (t: string) => void;
              clickAt: (u: number, v: number) => void;
            };
          };
        }
      ).__sketchStore!.getState();
    st().setConstruction(true);
    st().setTool("line");
    st().clickAt(0, 0);
    st().clickAt(0.03, 0.01);
  });
  await expect.poll(() => gizmo(page, "constructionGeometry")).toBe(true);
});
