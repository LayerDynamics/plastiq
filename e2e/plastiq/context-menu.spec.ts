// E2E (no mock): the in-canvas right-click context menu, driven through the REAL
// path. Plastiq loads in a real browser, the worker builds the seeded box with
// real OCCT, then the test dispatches a genuine `contextmenu` event on the canvas.
// That fires useCanvasRightClick → Picker raycast → resolveContextTarget →
// buildMenuSections → the drei <Html> dropdown, exactly as a user right-click
// would. We assert the menu's contents match the target and that clicking an item
// runs the real store action (a feature is appended / state changes).

import { expect, test, type Page } from "@playwright/test";

/** Is a named gizmo flagged present on the in-canvas seam? */
const gizmo = (page: Page, name: string): Promise<boolean> =>
  page.evaluate(
    (n) =>
      (globalThis as { __plastiqViewport?: { gizmos?: Record<string, boolean> } }).__plastiqViewport
        ?.gizmos?.[n] === true,
    name,
  );

/** Feature types currently in the document (real store read). */
const featureTypes = (page: Page): Promise<string[]> =>
  page.evaluate(
    () =>
      (globalThis as { __cadStore?: { getState(): { features: { type: string }[] } } }).__cadStore
        ?.getState()
        .features.map((f) => f.type) ?? [],
  );

/** Current 3D picks (real store read). */
const picks = (page: Page): Promise<{ kind: string; id: number }[]> =>
  page.evaluate(
    () =>
      (globalThis as { __cadStore?: { getState(): { picks: { kind: string; id: number }[] } } })
        .__cadStore?.getState()
        .picks ?? [],
  );

/** Dispatch a real right-click (contextmenu) at a client pixel on the canvas. */
async function rightClick(page: Page, x: number, y: number): Promise<void> {
  await page.evaluate(
    ([cx, cy]) => {
      const el = document.querySelector("#viewport-root canvas")!;
      el.dispatchEvent(
        new MouseEvent("contextmenu", { clientX: cx, clientY: cy, bubbles: true, cancelable: true }),
      );
    },
    [x, y],
  );
}

async function bootAndFit(page: Page): Promise<{ x: number; y: number; w: number; h: number }> {
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
  // Frame the part so the canvas centre ray provably lands on a face.
  await page.evaluate(() => {
    (globalThis as { __plastiqViewport?: { fitToView(): void } }).__plastiqViewport?.fitToView();
  });
  await page.waitForTimeout(700);
  const box = (await page.locator("#viewport-root canvas").boundingBox())!;
  return { x: box.x, y: box.y, w: box.width, h: box.height };
}

test("right-clicking a face opens its menu, selects it, and Shell runs", async ({ page }) => {
  const b = await bootAndFit(page);

  // Right-click the centre → a face is under the cursor.
  await rightClick(page, b.x + b.w / 2, b.y + b.h / 2);

  // The menu is shown (DOM + the in-canvas presence seam).
  await expect(page.getByTestId("canvas-context-menu")).toBeVisible();
  await expect.poll(() => gizmo(page, "rightClickDropdown")).toBe(true);

  // Select-then-menu (CAD-standard): the clicked face is now the selection.
  await expect.poll(async () => (await picks(page)).filter((p) => p.kind === "face").length).toBe(1);

  // Face actions are present; edge-only actions are not.
  await expect(page.getByTestId("ctx-sketch-on-face")).toBeVisible();
  await expect(page.getByTestId("ctx-shell")).toBeVisible();
  await expect(page.getByTestId("ctx-fillet")).toHaveCount(0);

  // Click Shell → the real shellFeature is appended to the document.
  await page.getByTestId("ctx-shell").click();
  await expect.poll(() => featureTypes(page)).toContain("shell");
  // Running an action closes the menu.
  await expect(page.getByTestId("canvas-context-menu")).toBeHidden();
});

test("right-clicking empty space shows the global menu and Escape dismisses it", async ({ page }) => {
  const b = await bootAndFit(page);

  // A corner: the part is centred + framed, so the ray misses it → empty context.
  await rightClick(page, b.x + 6, b.y + 6);

  await expect(page.getByTestId("canvas-context-menu")).toBeVisible();
  // Empty-space context: new-sketch entries, no face/edge dress-up.
  await expect(page.getByTestId("ctx-new-sketch-xy")).toBeVisible();
  await expect(page.getByTestId("ctx-shell")).toHaveCount(0);
  await expect(page.getByTestId("ctx-fillet")).toHaveCount(0);
  // Empty space clears any selection.
  await expect.poll(async () => (await picks(page)).length).toBe(0);

  // Escape dismisses the menu.
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("canvas-context-menu")).toBeHidden();
  await expect.poll(() => gizmo(page, "rightClickDropdown")).toBe(false);
});
