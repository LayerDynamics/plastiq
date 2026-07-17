// E2E (no mock): the interactive feature-edit gizmo previews the real solid LIVE.
// Draw a profile → Extrude → the gizmo's value box appears (store.activeFeatureEdit);
// typing a new height rebuilds the real OCCT solid to that height. We assert the
// *rendered solid's Z extent actually changes*, not merely that the gizmo rendered —
// that's the whole point of a live manipulator. ✓ commits (feature stays); ✕ cancels
// (feature removed, back to the seeded box).
//
// The 3D drag handle itself is not driven here (drei TransformControls drags are
// flaky headless — the documented codebase convention); its position→value write-back
// is unit-tested (featureGizmo.test) and the value-box path is the deterministic E2E.

import { expect, test, type Page } from "@playwright/test";

declare global {
  // eslint-disable-next-line no-var
  var solidHeight: () => number;
  // eslint-disable-next-line no-var
  var faceCount: () => number;
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const vp = (): {
      builtPart: {
        mesh: {
          geometry: { boundingBox: { min: { z: number }; max: { z: number } } | null; computeBoundingBox(): void };
          userData: { faceIds?: number[] };
        };
      } | null;
    } | undefined =>
      (globalThis as { __plastiqViewport?: ReturnType<typeof vp> }).__plastiqViewport;
    (globalThis as { solidHeight?: () => number }).solidHeight = () => {
      const g = vp()?.builtPart?.mesh.geometry;
      if (!g) return 0;
      g.computeBoundingBox();
      return g.boundingBox ? g.boundingBox.max.z - g.boundingBox.min.z : 0;
    };
    (globalThis as { faceCount?: () => number }).faceCount = () =>
      vp()?.builtPart?.mesh.userData.faceIds?.length ?? 0;
  });
});

const editActive = (page: Page): Promise<boolean> =>
  page.evaluate(
    () =>
      (globalThis as { __cadStore?: { getState(): { activeFeatureEdit: unknown } } }).__cadStore!.getState()
        .activeFeatureEdit != null,
  );

const gizmoShown = (page: Page): Promise<boolean> =>
  page.evaluate(
    () =>
      (globalThis as { __plastiqViewport?: { gizmos?: Record<string, boolean> } }).__plastiqViewport?.gizmos
        ?.featureEdit === true,
  );

const extrudeHeight = (page: Page): Promise<number> =>
  page.evaluate(() => {
    const f = (
      globalThis as {
        __cadStore?: { getState(): { features: { type: string; params?: Record<string, number> }[] } };
      }
    )
      .__cadStore!.getState()
      .features.find((x) => x.type === "extrude");
    return f?.params?.height ?? 0;
  });

/** The current build's volume (mass-properties readout the worker publishes). */
const volume = (page: Page): Promise<number> =>
  page.evaluate(
    () =>
      (globalThis as { __cadStore?: { getState(): { massProps: { volume: number } | null } } }).__cadStore!
        .getState()
        .massProps?.volume ?? 0,
  );

/** The world drag-arrow's unit axis (null for value-box-only ops). */
const gizmoAxis = (page: Page): Promise<number[] | null> =>
  page.evaluate(
    () =>
      (globalThis as { __plastiqViewport?: { featureGizmoAxis?: number[] | null } }).__plastiqViewport
        ?.featureGizmoAxis ?? null,
  );

/** A feature's numeric param by type — e.g. the cut's depth or the fillet's radius. */
const paramOf = (page: Page, type: string, param: string): Promise<number> =>
  page.evaluate(
    ([t, p]) => {
      const f = (
        globalThis as {
          __cadStore?: { getState(): { features: { type: string; params?: Record<string, number> }[] } };
        }
      )
        .__cadStore!.getState()
        .features.find((x) => x.type === t);
      return f?.params?.[p] ?? 0;
    },
    [type, param] as const,
  );

/** Switch to edge mode and click the first projectable edge (the candidatePx seam),
 * so a dress-up that needs an edge selection has one. */
async function selectFirstEdge(page: Page): Promise<void> {
  await page.evaluate(() =>
    (globalThis as { __cadStore?: { getState(): { setSelMode(m: string): void } } }).__cadStore!
      .getState()
      .setSelMode("edge"),
  );
  const px = await page.evaluate(
    () =>
      (
        globalThis as {
          __plastiqViewport?: { candidatePx?: (m: string) => { x: number; y: number } | null };
        }
      ).__plastiqViewport?.candidatePx?.("edge") ?? null,
  );
  if (!px) throw new Error("no edge candidate on screen");
  await page.evaluate(
    ([x, y]) => {
      const el = document.querySelector("#viewport-root canvas")!;
      const o = { clientX: x, clientY: y, button: 0, bubbles: true } as PointerEventInit;
      el.dispatchEvent(new PointerEvent("pointerdown", o));
      el.dispatchEvent(new PointerEvent("pointerup", o));
    },
    [px.x, px.y],
  );
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (globalThis as { __cadStore?: { getState(): { picks: { kind: string }[] } } }).__cadStore!
            .getState()
            .picks.filter((p) => p.kind === "edge").length,
      ),
    )
    .toBeGreaterThan(0);
}

/** Boot, draw a closed triangle, Finish, and Extrude it — leaving an active edit. */
async function drawTriangleAndExtrude(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByTestId("status")).toHaveText("ready", { timeout: 240_000 });
  // Empty document so the extrude yields the prism ALONE (5 faces). The seeded
  // box would otherwise swallow a z=0 triangle via join-by-default (§2.4/C1) —
  // the union stays the box and faceCount never reaches 5.
  await page.evaluate(() =>
    (globalThis as { __cadStore?: { getState: () => { loadDocument: (d: unknown) => void } } })
      .__cadStore!.getState()
      .loadDocument({ features: [], params: {} }),
  );
  await page.getByTestId("enter-sketch").click();
  await expect(page.getByTestId("sketcher")).toBeVisible();
  await page.evaluate(() => {
    const st = () =>
      (
        globalThis as {
          __sketchStore?: {
            getState: () => {
              setTool(t: string): void;
              clickAt(u: number, v: number, o?: { reusePointId?: string }): void;
              model: { points: { id: string }[] };
            };
          };
        }
      ).__sketchStore!.getState();
    st().setTool("line");
    st().clickAt(0, 0);
    const first = st().model.points[0]!.id;
    st().clickAt(0.04, 0);
    st().clickAt(0.02, 0.03);
    st().clickAt(0, 0, { reusePointId: first }); // close the loop
  });
  await expect(page.getByTestId("sketch-finish")).toBeEnabled();
  await page.getByTestId("sketch-finish").click();
  await expect(page.getByTestId("sketcher")).toHaveCount(0);
  await page.getByTestId("feature-menu").getByText("Extrude", { exact: true }).click();
  await page.waitForFunction(() => faceCount() === 5, undefined, { timeout: 240_000 }); // prism built
}

test("typing a new height in the gizmo previews the real solid live", async ({ page }) => {
  await drawTriangleAndExtrude(page);

  // The extrude opened an active edit → the gizmo + its value box are present.
  await expect.poll(() => editActive(page)).toBe(true);
  await expect.poll(() => gizmoShown(page)).toBe(true);
  await expect(page.getByTestId("feature-edit-box")).toBeVisible();

  const h0 = await page.evaluate(() => solidHeight());
  expect(h0).toBeGreaterThan(0.015); // ~20mm default extrude
  expect(h0).toBeLessThan(0.025);

  // Type 50mm → the param updates AND the OCCT solid rebuilds taller (live preview).
  await page.getByTestId("feature-edit-value").fill("50");
  await expect.poll(() => extrudeHeight(page)).toBeCloseTo(0.05, 3);
  await page.waitForFunction(() => solidHeight() > 0.04, undefined, { timeout: 240_000 });
  const h1 = await page.evaluate(() => solidHeight());
  expect(h1).toBeGreaterThan(h0); // the RENDERED solid actually grew
  expect(h1).toBeCloseTo(0.05, 2);

  // ✓ commits: the edit clears, but the feature (and its 50mm height) stays.
  await page.getByTestId("feature-edit-commit").click();
  await expect.poll(() => editActive(page)).toBe(false);
  expect(await extrudeHeight(page)).toBeCloseTo(0.05, 3);
  expect(await page.evaluate(() => faceCount())).toBe(5); // prism still there
});

test("cancel (✕) removes the just-created extrude — back to the bare sketch", async ({ page }) => {
  // drawTriangleAndExtrude starts from an EMPTY document (so the prism is
  // isolated at 5 faces), so cancelling the extrude leaves ONLY the sketch —
  // which builds no solid (faceCount 0), not the old seeded box.
  await drawTriangleAndExtrude(page);
  await expect.poll(() => editActive(page)).toBe(true);

  await page.getByTestId("feature-edit-cancel").click();
  await expect.poll(() => editActive(page)).toBe(false);
  // The extrude feature is gone → only the profile sketch remains → no solid.
  await page.waitForFunction(() => faceCount() === 0, undefined, { timeout: 240_000 });
  expect(await extrudeHeight(page)).toBe(0); // no extrude feature remains
});

test("editing cut depth in the gizmo previews the real solid live (linear, world arrow)", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByTestId("status")).toHaveText("ready", { timeout: 240_000 });

  // Draw a rectangle inside the seeded box footprint, Finish, then Cut it.
  await page.getByTestId("enter-sketch").click();
  await expect(page.getByTestId("sketcher")).toBeVisible();
  await page.evaluate(() => {
    const st = () =>
      (
        globalThis as {
          __sketchStore?: {
            getState: () => {
              setTool(t: string): void;
              clickAt(u: number, v: number, o?: { reusePointId?: string }): void;
              model: { points: { id: string }[] };
            };
          };
        }
      ).__sketchStore!.getState();
    st().setTool("line");
    st().clickAt(0.02, 0.015);
    const first = st().model.points[0]!.id;
    st().clickAt(0.04, 0.015);
    st().clickAt(0.04, 0.025);
    st().clickAt(0.02, 0.025);
    st().clickAt(0.02, 0.015, { reusePointId: first }); // close the rectangle
  });
  await page.getByTestId("sketch-finish").click();
  await expect(page.getByTestId("sketcher")).toHaveCount(0);
  await page.getByTestId("add-cut").click();

  await expect.poll(() => editActive(page)).toBe(true);

  // The arrow must point the way the cut actually removes material. The profile is on
  // the XY plane (z=0); the box sits on the +Z side, and the kernel cut sweeps +normal
  // — so the drag arrow has to read +Z (into the body), NOT the opposite. (This is the
  // claim I earlier hand-waved as "cosmetic"; here it's asserted.)
  await expect.poll(() => gizmoAxis(page)).toEqual([0, 0, 1]);

  await page.waitForFunction(
    () => (globalThis as { __cadStore?: { getState(): { massProps: unknown } } }).__cadStore!.getState().massProps != null,
    undefined,
    { timeout: 240_000 },
  );
  const v0 = await volume(page); // default 50mm depth → cuts through

  // 5mm depth removes far less material → the rebuilt solid has MORE volume.
  await page.getByTestId("feature-edit-value").fill("5");
  await expect.poll(() => paramOf(page, "cut", "depth")).toBeCloseTo(0.005, 3);
  await page.waitForFunction((v) => {
    const m = (globalThis as { __cadStore?: { getState(): { massProps: { volume: number } | null } } })
      .__cadStore!.getState().massProps;
    return m != null && m.volume > (v as number);
  }, v0, { timeout: 240_000 });
  expect(await volume(page)).toBeGreaterThan(v0); // the rendered solid actually changed
});

test("editing fillet radius in the gizmo previews the real solid live (scalar, value box)", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByTestId("status")).toHaveText("ready", { timeout: 240_000 });
  await page.waitForFunction(
    () => (globalThis as { __plastiqViewport?: { builtPart: unknown } }).__plastiqViewport?.builtPart != null,
    undefined,
    { timeout: 240_000 },
  );
  await page.evaluate(() =>
    (globalThis as { __plastiqViewport?: { fitToView?: () => void } }).__plastiqViewport?.fitToView?.(),
  );
  await page.waitForTimeout(400);
  const vBox = await volume(page); // the plain seeded box

  await selectFirstEdge(page);
  await page.getByTestId("act-fillet").click();

  await expect.poll(() => editActive(page)).toBe(true);
  // Dress-up has no natural world axis → value box only (no drag arrow), units mm.
  await expect(page.getByTestId("feature-edit-box")).toBeVisible();
  await page.waitForFunction((v) => {
    const m = (globalThis as { __cadStore?: { getState(): { massProps: { volume: number } | null } } })
      .__cadStore!.getState().massProps;
    return m != null && m.volume < (v as number);
  }, vBox, { timeout: 240_000 }); // a fillet rounds the edge → removes a sliver
  const v0 = await volume(page);
  expect(v0).toBeLessThan(vBox);

  // A bigger radius removes more material → less volume (live preview).
  await page.getByTestId("feature-edit-value").fill("6");
  await expect.poll(() => paramOf(page, "fillet", "radius")).toBeCloseTo(0.006, 3);
  await page.waitForFunction((v) => {
    const m = (globalThis as { __cadStore?: { getState(): { massProps: { volume: number } | null } } })
      .__cadStore!.getState().massProps;
    return m != null && m.volume < (v as number);
  }, v0, { timeout: 240_000 });
  expect(await volume(page)).toBeLessThan(v0);

  // A value that fails the OCCT rebuild (radius ≫ the box) must NOT make the gizmo
  // vanish — the part holds at last-good, so the user can still correct the value.
  await page.getByTestId("feature-edit-value").fill("999");
  await expect.poll(() => paramOf(page, "fillet", "radius")).toBeCloseTo(0.999, 2);
  await expect.poll(() => editActive(page)).toBe(true); // edit survives the failed build
  await expect(page.getByTestId("feature-edit-box")).toBeVisible();
});

test("dragging the scrub grip changes the value and rebuilds the solid live", async ({ page }) => {
  await drawTriangleAndExtrude(page); // opens an extrude edit (value box + scrub grip)
  await expect.poll(() => editActive(page)).toBe(true);

  const before = await extrudeHeight(page); // ~20mm default
  const h0 = await page.evaluate(() => solidHeight());
  const grip = page.getByTestId("feature-edit-scrub");
  await expect(grip).toBeVisible();
  const gb = (await grip.boundingBox())!;

  // A real DOM pointer-drag of the grip to the RIGHT → larger value (scrubToSI). This
  // also exercises pointer-capture surviving the per-move setSI re-render.
  await page.mouse.move(gb.x + gb.width / 2, gb.y + gb.height / 2);
  await page.mouse.down();
  await page.mouse.move(gb.x + gb.width / 2 + 80, gb.y + gb.height / 2, { steps: 12 });
  await page.mouse.up();

  await expect.poll(() => extrudeHeight(page)).toBeGreaterThan(before); // value scrubbed up
  await page.waitForFunction((h) => solidHeight() > (h as number), h0, { timeout: 240_000 });
  expect(await page.evaluate(() => solidHeight())).toBeGreaterThan(h0); // solid rebuilt taller
});
