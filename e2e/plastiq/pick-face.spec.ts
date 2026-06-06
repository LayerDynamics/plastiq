// SPEC-5 M1.6 — strict E2E (no mocks): the headline M1 flow, "pick a face, it
// highlights", driven through the REAL pick path. CAD Studio loads in a real
// browser, the worker builds the seeded box with real OCCT, then the test fits
// the view and dispatches a genuine pointer click at the canvas centre. That
// fires SceneController's pointer handler → Picker raycast → faceId → store
// pick → highlight, exactly as a user click would. We assert a B-rep face's
// render group flipped to the selected material slot (FACE_MATERIAL.selected).
//
// No pixel-guessing against the projection: fit-to-view centres the part so the
// centre ray provably hits a face (advisor guidance for a deterministic M1 E2E).

import { expect, test } from "@playwright/test";

const SELECTED_SLOT = 2; // FACE_MATERIAL.selected

test("clicking a face selects it and highlights its render group", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#viewport-root canvas")).toBeVisible();
  await expect(page.getByTestId("status")).toHaveText("ready", { timeout: 240_000 });
  await page.waitForFunction(
    () =>
      (globalThis as { __cadStudioScene?: { builtPart: unknown } }).__cadStudioScene?.builtPart !=
      null,
    undefined,
    { timeout: 240_000 },
  );

  // Frame the part so the canvas centre ray lands on it, then let the camera
  // tween settle.
  await page.evaluate(() => {
    (globalThis as { __cadStudioScene?: { fitToView(): void } }).__cadStudioScene?.fitToView();
  });
  await page.waitForTimeout(700);

  // No face is highlighted yet.
  const selectedBefore = await page.evaluate(() => countSelectedGroups());
  expect(selectedBefore).toBe(0);

  // Dispatch a real click at the canvas centre (NDC 0,0).
  const canvas = page.locator("#viewport-root canvas");
  const box = (await canvas.boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.evaluate(
    ([x, y]) => {
      const el = document.querySelector("#viewport-root canvas")!;
      const opts = { clientX: x, clientY: y, bubbles: true } as PointerEventInit;
      el.dispatchEvent(new PointerEvent("pointerdown", opts));
      el.dispatchEvent(new PointerEvent("pointerup", opts));
    },
    [cx, cy],
  );

  // Exactly one face's group flipped to the selected material slot.
  const selectedAfter = await page.evaluate(() => countSelectedGroups());
  expect(selectedAfter).toBe(1);
});

// Helper injected into the page: count mesh groups in the selected slot.
declare global {
  // eslint-disable-next-line no-var
  var countSelectedGroups: () => number;
}
test.beforeEach(async ({ page }) => {
  await page.addInitScript((slot: number) => {
    (globalThis as { countSelectedGroups?: () => number }).countSelectedGroups = () => {
      const scene = (
        globalThis as {
          __cadStudioScene?: {
            builtPart: { mesh: { geometry: { groups: { materialIndex: number }[] } } } | null;
          };
        }
      ).__cadStudioScene;
      const groups = scene?.builtPart?.mesh.geometry.groups ?? [];
      return groups.filter((g) => g.materialIndex === slot).length;
    };
  }, SELECTED_SLOT);
});
