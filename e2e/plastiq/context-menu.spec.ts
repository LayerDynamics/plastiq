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

/** Dispatch a real right-click at a client pixel on the canvas: the full RIGHT-button
 * pointer sequence (down/up) followed by `contextmenu`, exactly as a browser fires it
 * — so the test exercises the same path real users do (regression guard for the
 * OrbitControls-right-pan / close-on-pointerdown conflict). */
async function rightClick(page: Page, x: number, y: number): Promise<void> {
  await page.evaluate(
    ([cx, cy]) => {
      const el = document.querySelector("#viewport-root canvas")!;
      const opts = { clientX: cx, clientY: cy, button: 2, buttons: 2, bubbles: true, cancelable: true };
      el.dispatchEvent(new PointerEvent("pointerdown", opts as PointerEventInit));
      el.dispatchEvent(new PointerEvent("pointerup", opts as PointerEventInit));
      el.dispatchEvent(new MouseEvent("contextmenu", opts));
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

test("right-clicking in the sketcher offers the applicable constraints", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("status")).toHaveText("ready", { timeout: 240_000 });

  // Enter a sketch and draw + select a line through the store seam (real solver).
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
              clickAt(u: number, v: number): void;
              cancelGesture(): void;
              setSelection(ids: string[]): void;
              model: { entities: { id: string; kind: string }[]; constraints: unknown[] };
            };
          };
        }
      ).__sketchStore!.getState();
    st().setTool("line");
    st().clickAt(0, 0);
    st().clickAt(0.03, 0);
    st().cancelGesture();
    const line = st().model.entities.find((e) => e.kind === "line")!;
    st().setSelection([line.id]);
  });

  // Right-click the sketch surface → sketch context menu with line constraints.
  const svg = page.getByTestId("sketch-svg");
  const box = (await svg.boundingBox())!;
  await page.evaluate(
    ([x, y]) => {
      document
        .querySelector('[data-testid="sketch-svg"]')!
        .dispatchEvent(
          new MouseEvent("contextmenu", { clientX: x, clientY: y, bubbles: true, cancelable: true }),
        );
    },
    [box.x + box.width / 2, box.y + box.height / 2],
  );

  await expect(page.getByTestId("sketch-context-menu")).toBeVisible();
  await expect(page.getByTestId("ctx-sk-constraint-horizontal")).toBeVisible();
  await expect(page.getByTestId("ctx-sk-finish")).toBeVisible();

  // Apply Horizontal → a constraint is added to the live model.
  const constraintsBefore = await page.evaluate(
    () =>
      (globalThis as { __sketchStore?: { getState(): { model: { constraints: unknown[] } } } })
        .__sketchStore!.getState().model.constraints.length,
  );
  await page.getByTestId("ctx-sk-constraint-horizontal").click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (globalThis as { __sketchStore?: { getState(): { model: { constraints: unknown[] } } } })
            .__sketchStore!.getState().model.constraints.length,
      ),
    )
    .toBe(constraintsBefore + 1);
});

test("right-clicking an assembly instance offers instance actions", async ({ page }) => {
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

  // Insert a component instance; the assembly layer renders it (base part hides).
  await page.evaluate(() =>
    (globalThis as { __cadStore?: { getState(): { addInstance(): string } } }).__cadStore!
      .getState()
      .addInstance(),
  );
  await page.waitForFunction(
    () =>
      ((globalThis as { __plastiqViewport?: { instanceGroups?: unknown[] } }).__plastiqViewport
        ?.instanceGroups?.length ?? 0) > 0,
    undefined,
    { timeout: 240_000 },
  );
  await page.evaluate(() => {
    (globalThis as { __plastiqViewport?: { fitToView(): void } }).__plastiqViewport?.fitToView();
  });
  await page.waitForTimeout(700);

  const box = (await page.locator("#viewport-root canvas").boundingBox())!;
  await rightClick(page, box.x + box.width / 2, box.y + box.height / 2);

  await expect(page.getByTestId("canvas-context-menu")).toBeVisible();
  await expect(page.getByTestId("ctx-instance-fixed")).toBeVisible();
  await expect(page.getByTestId("ctx-explode")).toBeVisible();
  await expect(page.getByTestId("ctx-shell")).toHaveCount(0); // not a base-part face context

  // Toggle the instance's ground flag via the menu.
  const fixedOf = (): Promise<boolean> =>
    page.evaluate(
      () =>
        (globalThis as { __cadStore?: { getState(): { assembly: { instances: { fixed: boolean }[] } } } })
          .__cadStore!.getState().assembly.instances[0]!.fixed,
    );
  const before = await fixedOf();
  await page.getByTestId("ctx-instance-fixed").click();
  await expect.poll(fixedOf).toBe(!before);
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
