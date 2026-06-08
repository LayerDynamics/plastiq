// E2E (no mock): R2 gizmos on the r3f viewport.
//  • transform gizmo (FR-11) appears only while something is selected,
//  • view cube / named views (FR-12) reorient the camera (the render changes).
// The transform DRAG write-back (readPlacement→upsertPlacement) is pure and
// unit-covered; dragging a 3D handle in a headless canvas is flaky, so here we
// assert the gizmo's presence (the store-gated visibility) instead.

import { expect, test } from "@playwright/test";

const ready = async (page: import("@playwright/test").Page): Promise<void> => {
  await page.goto("/");
  await expect(page.locator("#viewport-root canvas")).toBeVisible();
  await expect(page.getByTestId("status")).toHaveText("ready", { timeout: 240_000 });
  await page.waitForFunction(
    () =>
      (globalThis as { __plastiqViewport?: { builtPart: unknown } }).__plastiqViewport?.builtPart !=
      null,
    undefined,
    { timeout: 240_000 },
  );
  await page.evaluate(() =>
    (globalThis as { __plastiqViewport?: { fitToView?: () => void } }).__plastiqViewport?.fitToView?.(),
  );
  await page.waitForTimeout(300);
};

const gizmoActive = (page: import("@playwright/test").Page): Promise<boolean> =>
  page.evaluate(
    () =>
      (globalThis as { __plastiqViewport?: { transformGizmoActive?: boolean } }).__plastiqViewport
        ?.transformGizmoActive === true,
  );

test("transform gizmo appears on selection and clears with it (FR-11)", async ({ page }) => {
  await ready(page);
  expect(await gizmoActive(page)).toBe(false); // nothing selected → no gizmo

  // Click the centre face (face mode is the default).
  const b = (await page.locator("#viewport-root canvas").boundingBox())!;
  await page.evaluate(
    ([x, y]) => {
      const el = document.querySelector("#viewport-root canvas")!;
      const o = { clientX: x, clientY: y, bubbles: true } as PointerEventInit;
      el.dispatchEvent(new PointerEvent("pointerdown", o));
      el.dispatchEvent(new PointerEvent("pointerup", o));
    },
    [b.x + b.width / 2, b.y + b.height / 2],
  );
  await expect.poll(() => gizmoActive(page)).toBe(true); // selected → gizmo shown

  // Esc clears the selection (App keyboard shortcut) → the gizmo unmounts.
  await page.keyboard.press("Escape");
  await expect.poll(() => gizmoActive(page)).toBe(false);
});

test("named standard views reorient the camera (FR-12)", async ({ page }) => {
  await ready(page);
  const shot = (): Promise<string> =>
    page.evaluate(
      () => (document.querySelector("#viewport-root canvas") as HTMLCanvasElement).toDataURL(),
    );
  const settle = (): Promise<void> =>
    page.evaluate(
      () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
    );

  // Named views now live in the sidebar's Inspect panel (the floating panel that used
  // to sit over the 3D view cube was removed; the cube itself owns click-to-orient).
  const views = page.getByTestId("named-views");
  await settle();
  const before = await shot();
  await views.getByText("top", { exact: true }).click();
  await settle();
  const top = await shot();
  expect(top).not.toBe(before); // the camera moved to the top view → render changed

  await views.getByText("front", { exact: true }).click();
  await settle();
  expect(await shot()).not.toBe(top);
});
