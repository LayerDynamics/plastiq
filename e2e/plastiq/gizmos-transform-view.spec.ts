// E2E (no mock): R2 gizmos on the r3f viewport.
//  • transform gizmo (FR-11) appears only while something is selected,
//  • view cube (the first-party SVG overlay, viewport/ViewCube) / named views
//    (FR-12) reorient the camera (the render changes).
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

test("the view cube is unobstructed and reorients the camera on click (FR-12)", async ({
  page,
}) => {
  await ready(page);
  const canvas = page.locator("#viewport-root canvas");
  const box = (await canvas.boundingBox())!;

  // The view cube is now the first-party SVG overlay (viewport/ViewCube), pinned
  // over the canvas's top-right corner — same spot the retired drei gizmo occupied.
  const cube = page.getByTestId("view-cube");
  await expect(cube).toBeVisible();
  const cb = (await cube.boundingBox())!;
  expect(cb.x).toBeGreaterThan(box.x + box.width / 2); // right side…
  expect(cb.y - box.y).toBeLessThan(120); // …near the top

  // 1) Deterministic: the only thing with pointer-events over the cube's corner is
  //    the cube itself — the element at a face's centre is inside the view-cube svg,
  //    and a point beside the cube falls through to the CANVAS (the overlay is
  //    pointer-transparent outside its painted shapes, so orbit still works there).
  //    Which faces exist depends on where the camera is — the cube now draws only
  //    the faces pointing at you (FR-12) — so this probes whichever face is
  //    currently visible rather than assuming a fixed one.
  const [onFace, besideCube] = await page.evaluate(() => {
    const svg = document.querySelector('[data-testid="view-cube"]')!;
    const f = document.querySelector('[data-testid^="cube-face-"]')!.getBoundingClientRect();
    const el = document.elementFromPoint(f.left + f.width / 2, f.top + f.height / 2);
    const c = document.querySelector("#viewport-root canvas")!.getBoundingClientRect();
    const beside = document.elementFromPoint(c.right - 150, c.top + 60);
    return [svg.contains(el), beside?.tagName ?? "null"] as const;
  });
  expect(onFace).toBe(true);
  expect(besideCube).toBe("CANVAS");

  // 2) Real interaction: clicking the Front face snaps the main camera to the front
  //    view (render changes), and the near-corner spot snaps to iso (changes again).
  //    Snaps are instant via the setView seam — same as the named-view buttons.
  const shot = (): Promise<string> =>
    page.evaluate(
      () => (document.querySelector("#viewport-root canvas") as HTMLCanvasElement).toDataURL(),
    );
  const settle = (): Promise<void> =>
    page.evaluate(
      () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
    );
  const neutral: [number, number] = [box.x + 8, box.y + box.height - 8];
  await page.mouse.move(...neutral);
  await settle();
  const before = await shot();

  // Click a face the camera can currently see; it snaps to that ortho view.
  await page.locator('[data-testid^="cube-face-"]').first().click();
  await page.mouse.move(...neutral); // clear the cube hover-highlight
  await settle();
  const ortho = await shot();
  expect(ortho).not.toBe(before); // the camera moved to that face's view

  // Now a corner spot — three non-zero axes — snaps to an iso view. Picked from
  // whatever the cube shows AFTER the first snap, since the visible set changed.
  const corner = page.locator('[data-testid^="cube-spot-"]').last();
  await expect(corner).toBeVisible();
  await corner.click();
  await page.mouse.move(...neutral);
  await settle();
  expect(await shot()).not.toBe(ortho); // …and again
});
