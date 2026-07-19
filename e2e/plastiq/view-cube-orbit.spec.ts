// FR-12 — the view cube must show where the camera IS, not just set where it
// goes. Orbits with a real left-drag on the canvas and asserts the cube's
// visible faces change: the previous cube was a fixed isometric drawing that
// looked identical from every angle.

import { expect, test } from "@playwright/test";
test("view cube follows a real orbit", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("status")).toHaveText("ready", { timeout: 240_000 });
  await expect(page.getByTestId("view-cube")).toBeVisible();
  const faces = async (): Promise<string[]> =>
    page.$$eval("[data-testid^='cube-face-']", (els) =>
      els.map((e) => `${e.getAttribute("data-testid")}:${e.getAttribute("points")}`),
    );
  const before = await faces();
  // Orbit with a real left-drag on the canvas.
  const b = (await page.locator("#viewport-root canvas").boundingBox())!;
  await page.mouse.move(b.x + b.width * 0.5, b.y + b.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width * 0.8, b.y + b.height * 0.35, { steps: 12 });
  await page.mouse.up();
  await expect
    .poll(async () => JSON.stringify(await faces()) !== JSON.stringify(before))
    .toBe(true);

  // Not merely redrawn — a DIFFERENT set of faces is now toward the viewer.
  const names = (fs: string[]): string[] => fs.map((f) => f.split(":")[0]!).sort();
  expect(names(await faces())).not.toEqual(names(before));
  // …and it is still a cube: three faces face you from any general direction.
  expect((await faces()).length).toBe(3);
});
