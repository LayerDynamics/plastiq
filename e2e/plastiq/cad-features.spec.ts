// Real-browser CAD acceptance through the production geometry stack: Zustand
// document → geometry worker → OCCT WASM rebuild → tagged mesh in the r3f
// viewport. Most geometry cases below intentionally inject precise documents as
// integration fixtures; the R6 parameter-authoring and R9 profile-operation
// cases drive complete user-facing workflows through rendered controls and are
// strict E2E tests.

import { expect, test, type Page } from "@playwright/test";

declare global {
  // eslint-disable-next-line no-var
  var faceCount: () => number;
  // eslint-disable-next-line no-var
  var partVolume: () => number | null;
}

interface CadApi {
  getState: () => {
    loadDocument: (doc: {
      features: Record<string, unknown>[];
      params: Record<string, number>;
    }) => void;
    features: {
      id: string;
      type: string;
      params?: Record<string, number>;
      exprs?: Record<string, string>;
      data?: Record<string, unknown>;
    }[];
    params: Record<string, number>;
    massProps: { volume: number; com: [number, number, number] } | null;
    featureErrors: Record<string, string>;
    status: string;
  };
}

function mm(v: number): number {
  return v / 1000;
}

type UV = [number, number];

async function sketchCursorAt(page: Page, x: number, y: number): Promise<UV> {
  await page.mouse.move(x, y);
  return page.evaluate(
    () =>
      (
        globalThis as { __sketchStore: { getState: () => { cursor: UV | null } } }
      ).__sketchStore.getState().cursor!,
  );
}

async function aimAtSketchUv(
  page: Page,
  box: { x: number; y: number; width: number; height: number },
  target: UV,
): Promise<{ x: number; y: number }> {
  let x = box.x + box.width / 2;
  let y = box.y + box.height / 2;
  const probe = 20;
  let distance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < 8; i++) {
    const here = await sketchCursorAt(page, x, y);
    distance = Math.hypot(target[0] - here[0], target[1] - here[1]);
    if (distance < 6e-4) break;
    const right = await sketchCursorAt(page, x + probe, y);
    const down = await sketchCursorAt(page, x, y + probe);
    const a = (right[0] - here[0]) / probe;
    const b = (down[0] - here[0]) / probe;
    const c = (right[1] - here[1]) / probe;
    const d = (down[1] - here[1]) / probe;
    const det = a * d - b * c;
    expect(Math.abs(det), "sketch plane must be visible, not edge-on").toBeGreaterThan(1e-12);
    const du = target[0] - here[0];
    const dv = target[1] - here[1];
    x += (d * du - b * dv) / det;
    y += (-c * du + a * dv) / det;
  }
  expect(distance, "pointer must converge inside the box footprint").toBeLessThan(6e-4);
  return { x, y };
}

function loopProfile(pts: [number, number][]) {
  const [start, ...rest] = pts;
  return {
    kind: "loop" as const,
    start: start!,
    segments: rest.map((to) => ({ kind: "line" as const, to })),
  };
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    (globalThis as { faceCount?: () => number }).faceCount = () => {
      const scene = (
        globalThis as {
          __plastiqViewport?: { builtPart: { mesh: { userData: { faceIds?: number[] } } } | null };
        }
      ).__plastiqViewport;
      return scene?.builtPart?.mesh.userData.faceIds?.length ?? 0;
    };
    (globalThis as { partVolume?: () => number | null }).partVolume = () => {
      const store = (globalThis as { __cadStore?: CadApi }).__cadStore;
      return store?.getState().massProps?.volume ?? null;
    };
  });
});

async function waitReady(page: Page): Promise<void> {
  await expect(page.getByTestId("status")).toHaveText("ready", { timeout: 240_000 });
}

async function loadDoc(page: Page, features: Record<string, unknown>[]): Promise<void> {
  await page.evaluate((fs) => {
    const cad = (globalThis as { __cadStore?: CadApi }).__cadStore!;
    cad.getState().loadDocument({ features: fs, params: {} });
  }, features);
  await waitReady(page);
  await page.waitForFunction(() => faceCount() > 0, undefined, { timeout: 240_000 });
}

test("global parameter authoring drives two real OCCT features across edit, rename, and unbind (R6)", async ({
  page,
}) => {
  await page.goto("/");
  await waitReady(page);

  // Author a global dimension entirely through the Parameters panel.
  await page.getByTestId("param-add-name").fill("size");
  await page.getByTestId("param-add-value").fill("0.02");
  await page.getByTestId("param-add-btn").click();
  await expect(page.getByTestId("param-row-size")).toBeVisible();

  // Bind the seeded box width, then create and bind a second real primitive.
  await page.getByTestId("feature-row").nth(0).click();
  await page.getByTestId("feature-expr-dx").fill("size");
  await page.getByTestId("feature-expr-dx").press("Enter");
  await page.getByTestId("act-cylinder").click();
  await expect(page.getByTestId("feature-row")).toHaveCount(2);
  await page.getByTestId("feature-expr-radius").fill("size / 4");
  await page.getByTestId("feature-expr-radius").press("Enter");
  await expect(page.getByTestId("param-usedby-size")).toContainText("used by 2");

  await page.waitForFunction(
    () => {
      const state = (globalThis as { __cadStore?: CadApi }).__cadStore!.getState();
      return (
        state.status === "ready" &&
        state.massProps !== null &&
        state.features[0]?.exprs?.dx === "size" &&
        state.features[1]?.exprs?.radius === "size / 4" &&
        Object.keys(state.featureErrors).length === 0
      );
    },
    undefined,
    { timeout: 240_000 },
  );
  const firstBoundVolume = await page.evaluate(() => partVolume());
  expect(firstBoundVolume).not.toBeNull();

  // One global edit must rebuild both bound dimensions through the real worker.
  await page.getByTestId("param-value-size").fill("0.03");
  await page.getByTestId("param-value-size").press("Enter");
  await page.waitForFunction(
    (before) => {
      const state = (globalThis as { __cadStore?: CadApi }).__cadStore!.getState();
      const volume = state.massProps?.volume;
      return (
        state.status === "ready" &&
        state.params.size === 0.03 &&
        volume !== undefined &&
        Math.abs(volume - before) > 1e-9 &&
        Object.keys(state.featureErrors).length === 0
      );
    },
    firstBoundVolume,
    { timeout: 240_000 },
  );
  await expect(
    page.getByTestId("feature-param-radius").locator('input[type="number"]'),
  ).toHaveValue("7.5");

  // Rename is dependency-safe: both expressions change atomically and geometry
  // remains valid without a transient missing-name rebuild.
  const volumeBeforeRename = await page.evaluate(() => partVolume());
  await page.getByTestId("param-name-size").fill("span");
  await page.getByTestId("param-name-size").press("Enter");
  await expect(page.getByTestId("param-row-span")).toBeVisible();
  await expect(page.getByTestId("param-usedby-span")).toContainText("used by 2");
  await page.waitForFunction(
    (before) => {
      const state = (globalThis as { __cadStore?: CadApi }).__cadStore!.getState();
      return (
        state.status === "ready" &&
        state.features[0]?.exprs?.dx === "span" &&
        state.features[1]?.exprs?.radius === "span / 4" &&
        state.massProps !== null &&
        Math.abs(state.massProps.volume - before) < 1e-12 &&
        Object.keys(state.featureErrors).length === 0
      );
    },
    volumeBeforeRename,
    { timeout: 240_000 },
  );

  // A literal numeric edit explicitly unbinds only that field; the other feature
  // stays expression-driven and the used-by count falls from two to one.
  await page.getByTestId("feature-row").nth(0).click();
  const boxDx = page.getByTestId("feature-param-dx").locator('input[type="number"]');
  await boxDx.fill("35");
  await boxDx.press("Enter");
  await expect(page.getByTestId("feature-expr-dx")).toHaveValue("");
  await expect(page.getByTestId("param-usedby-span")).toContainText("used by 1");
  await page.waitForFunction(
    () => {
      const state = (globalThis as { __cadStore?: CadApi }).__cadStore!.getState();
      return (
        state.status === "ready" &&
        state.features[0]?.params?.dx === 0.035 &&
        state.features[0]?.exprs?.dx === undefined &&
        state.features[1]?.exprs?.radius === "span / 4" &&
        Object.keys(state.featureErrors).length === 0
      );
    },
    undefined,
    { timeout: 240_000 },
  );
});

test("Properties drives profile join / cut / intersect through the real OCCT worker (R9)", async ({
  page,
}) => {
  await page.goto("/");
  await waitReady(page);
  const baseVolume = await page.evaluate(() => partVolume());
  expect(baseVolume).not.toBeNull();

  // Author the tool profile using the real sketch toolbar and pointer path.
  await page.getByTestId("enter-sketch").click();
  await expect(page.getByTestId("sketcher")).toBeVisible();
  const box = (await page.locator("#viewport-root canvas").boundingBox())!;
  const center = await aimAtSketchUv(page, box, [mm(30), mm(20)]);
  await page.getByTestId("tool-circle").click();
  await page.mouse.move(center.x, center.y);
  await page.mouse.down();
  await page.mouse.move(center.x + 45, center.y, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByTestId("sketch-finish")).toBeEnabled();
  await page.getByTestId("sketch-finish").click();
  await expect(page.getByTestId("sketcher")).toHaveCount(0);
  const authoredProfile = await page.evaluate(() => {
    const sketch = (globalThis as { __cadStore?: CadApi }).__cadStore!.getState().features.at(-1)!;
    return {
      profile: sketch.data?.profile as { kind: string; center: UV; radius: number },
      plane: sketch.data?.plane,
    };
  });
  expect(authoredProfile.profile.kind).toBe("circle");
  expect(authoredProfile.profile.center[0]).toBeCloseTo(mm(30), 3);
  expect(authoredProfile.profile.center[1]).toBeCloseTo(mm(20), 3);
  expect(authoredProfile.profile.radius).toBeGreaterThan(mm(1));

  await page.getByTestId("feature-menu").getByText("Extrude", { exact: true }).click();
  await waitReady(page);
  await expect(page.getByTestId("feature-row")).toHaveCount(3);
  await page.getByTestId("feature-row").last().click();

  // The default sketch is on the selected top face, so extend the tool back into
  // the box through the visible two-sided field before exercising booleans.
  const back = page.getByTestId("feature-param-back").locator('input[type="number"]');
  await back.fill("20");
  await back.press("Enter");
  await page.waitForFunction(
    () => {
      const state = (globalThis as { __cadStore?: CadApi }).__cadStore!.getState();
      return state.status === "ready" && state.features.at(-1)?.params?.back === 0.02;
    },
    undefined,
    { timeout: 240_000 },
  );

  const op = page.getByTestId("feature-op");
  await expect(op).toHaveValue("join");
  const joinedVolume = await page.evaluate(() => partVolume());
  expect(joinedVolume!).toBeGreaterThan(baseVolume!);

  await op.selectOption("cut");
  await page.waitForFunction(
    (before) => {
      const state = (globalThis as { __cadStore?: CadApi }).__cadStore!.getState();
      return (
        state.status === "ready" &&
        state.features.at(-1)?.data?.op === "cut" &&
        state.massProps !== null &&
        state.massProps.volume < before
      );
    },
    joinedVolume,
    { timeout: 240_000 },
  );
  const cutVolume = await page.evaluate(() => partVolume());

  await op.selectOption("intersect");
  await page.waitForFunction(
    (before) => {
      const state = (globalThis as { __cadStore?: CadApi }).__cadStore!.getState();
      return (
        state.status === "ready" &&
        state.features.at(-1)?.data?.op === "intersect" &&
        state.massProps !== null &&
        Math.abs(state.massProps.volume - before) > 1e-10
      );
    },
    cutVolume,
    { timeout: 240_000 },
  );
  const intersectVolume = await page.evaluate(() => partVolume());
  expect(intersectVolume).not.toBeNull();
  expect(
    intersectVolume!,
    `profile=${JSON.stringify(authoredProfile)} base=${baseVolume} join=${joinedVolume} cut=${cutVolume}`,
  ).toBeGreaterThan(0);
  expect(cutVolume! + intersectVolume!).toBeCloseTo(baseVolume!, 8);
});

test("ellipse sketch extrudes as an exact OCCT conic through the real worker (§13.3)", async ({
  page,
}) => {
  await page.goto("/");
  await waitReady(page);
  const baseVolume = await page.evaluate(() => partVolume());
  expect(baseVolume).not.toBeNull();

  await page.getByTestId("enter-sketch").click();
  await expect(page.getByTestId("sketcher")).toBeVisible();
  const box = (await page.locator("#viewport-root canvas").boundingBox())!;
  await page.getByTestId("tool-ellipse").click();

  // Three rendered pointer clicks author centre, major-axis endpoint, and
  // minor radius. The persisted model converts that endpoint to a true focus,
  // and the worker lowers it to gp_Elips rather than a sampled polygon.
  for (const uv of [
    [mm(30), mm(20)],
    [mm(40), mm(20)],
    [mm(30), mm(25)],
  ] as UV[]) {
    const point = await aimAtSketchUv(page, box, uv);
    await page.mouse.click(point.x, point.y);
  }

  await expect(page.getByTestId("sketch-finish")).toBeEnabled();
  await page.getByTestId("sketch-finish").click();
  const profile = await page.evaluate(() => {
    const state = (globalThis as { __cadStore?: CadApi }).__cadStore!.getState();
    return state.features.at(-1)!.data?.profile as {
      kind: string;
      center: UV;
      focus1: UV;
      minorRadius: number;
    };
  });
  expect(profile.kind).toBe("ellipse");
  const focalDistance = Math.hypot(
    profile.focus1[0] - profile.center[0],
    profile.focus1[1] - profile.center[1],
  );
  const majorRadius = Math.hypot(focalDistance, profile.minorRadius);
  expect(majorRadius).toBeCloseTo(mm(10), 3);
  expect(profile.minorRadius).toBeCloseTo(mm(5), 3);

  await page.getByTestId("feature-menu").getByText("Extrude", { exact: true }).click();
  await waitReady(page);
  await page.waitForFunction(
    (before) => {
      const state = (globalThis as { __cadStore?: CadApi }).__cadStore!.getState();
      return (
        state.status === "ready" &&
        state.features.at(-1)?.type === "extrude" &&
        state.massProps !== null &&
        state.massProps.volume > before &&
        Object.keys(state.featureErrors).length === 0
      );
    },
    baseVolume,
    { timeout: 240_000 },
  );

  const finalVolume = await page.evaluate(() => partVolume());
  expect(finalVolume).not.toBeNull();
  expect(finalVolume! - baseVolume!).toBeCloseTo(
    Math.PI * majorRadius * profile.minorRadius * mm(20),
    8,
  );
  await page.waitForFunction(() => faceCount() > 6, undefined, { timeout: 240_000 });
});

test("Rectangle → Rib builds a native linear form through the real OCCT worker", async ({
  page,
}) => {
  await page.goto("/");
  await waitReady(page);
  const baseVolume = await page.evaluate(() => partVolume());
  expect(baseVolume).not.toBeNull();

  // Drive both product actions from the rendered ribbon. Rectangle resolves the
  // seeded body's live top FaceRef; Rib persists a dependent feature and the
  // geometry worker rebuilds it with OCCT LocOpe_LinearForm.
  await page.getByTestId("act-sample-rect").click();
  await expect(page.getByTestId("feature-row")).toHaveCount(2);
  await page.getByTestId("act-rib").click();
  await expect(page.getByTestId("feature-row")).toHaveCount(3);
  await waitReady(page);

  await page.waitForFunction(
    (before) => {
      const state = (globalThis as { __cadStore?: CadApi }).__cadStore!.getState();
      return (
        state.status === "ready" &&
        state.features.at(-1)?.type === "rib" &&
        state.massProps !== null &&
        state.massProps.volume > before &&
        Object.keys(state.featureErrors).length === 0
      );
    },
    baseVolume,
    { timeout: 240_000 },
  );

  const result = await page.evaluate(() => {
    const state = (globalThis as { __cadStore?: CadApi }).__cadStore!.getState();
    const rib = state.features.at(-1)!;
    return {
      sketchId: state.features.at(-2)!.id,
      type: rib.type,
      length: rib.params?.length,
      op: rib.data?.op,
      volume: state.massProps!.volume,
    };
  });
  expect(result.type).toBe("rib");
  expect(result.length).toBeCloseTo(mm(10), 12);
  expect(result.op).toBe("join");
  // 30×20 mm profile × 10 mm native linear form, fused onto the top face.
  expect(result.volume - baseVolume!).toBeCloseTo(mm(30) * mm(20) * mm(10), 8);
  await page.waitForFunction(() => faceCount() > 6, undefined, { timeout: 240_000 });
});

test("sketch → revolve rebuilds a solid of revolution with real OCCT", async ({ page }) => {
  await page.goto("/");
  await waitReady(page);

  await loadDoc(page, [
    {
      id: "f1",
      type: "sketch",
      data: {
        profile: loopProfile([
          [mm(10), mm(0)],
          [mm(20), mm(0)],
          [mm(20), mm(10)],
          [mm(10), mm(10)],
        ]),
      },
    },
    { id: "f2", type: "revolve", deps: ["f1"], params: { angle: Math.PI * 2, ay: 1 } },
  ]);

  // A full revolve is not a 6-faced box — expect a multi-face ring/disk solid.
  await page.waitForFunction(() => faceCount() >= 3, undefined, { timeout: 240_000 });
  const vol = await page.evaluate(() => partVolume());
  expect(vol).not.toBeNull();
  expect(vol!).toBeGreaterThan(0);
});

test("revolve with offset origin (ox) produces a different solid than world origin (G2)", async ({
  page,
}) => {
  await page.goto("/");
  await waitReady(page);

  const profile = loopProfile([
    [mm(10), mm(0)],
    [mm(20), mm(0)],
    [mm(20), mm(10)],
    [mm(10), mm(10)],
  ]);

  await loadDoc(page, [
    { id: "f1", type: "sketch", data: { profile } },
    {
      id: "f2",
      type: "revolve",
      deps: ["f1"],
      params: { angle: Math.PI * 2, ay: 1, ox: mm(5) },
    },
  ]);
  const offsetVol = await page.evaluate(() => partVolume());

  await loadDoc(page, [
    { id: "f1", type: "sketch", data: { profile } },
    { id: "f2", type: "revolve", deps: ["f1"], params: { angle: Math.PI * 2, ay: 1 } },
  ]);
  const originVol = await page.evaluate(() => partVolume());

  expect(offsetVol).not.toBeNull();
  expect(originVol).not.toBeNull();
  // Distinct axis origins must yield distinct Pappus volumes.
  expect(Math.abs(offsetVol! - originVol!)).toBeGreaterThan(1e-9);
});

test("loft through two stacked sections rebuilds a frustum (FR-32)", async ({ page }) => {
  await page.goto("/");
  await waitReady(page);

  await loadDoc(page, [
    {
      id: "f1",
      type: "loft",
      data: {
        ruled: true,
        sections: [
          {
            z: 0,
            profile: loopProfile([
              [mm(-20), mm(-15)],
              [mm(20), mm(-15)],
              [mm(20), mm(15)],
              [mm(-20), mm(15)],
            ]),
          },
          {
            z: mm(60),
            profile: loopProfile([
              [mm(-10), mm(-7.5)],
              [mm(10), mm(-7.5)],
              [mm(10), mm(7.5)],
              [mm(-10), mm(7.5)],
            ]),
          },
        ],
      },
    },
  ]);

  await page.waitForFunction(() => faceCount() >= 5, undefined, { timeout: 240_000 });
  const vol = await page.evaluate(() => partVolume());
  // Between small- and large-section prism volumes.
  expect(vol!).toBeGreaterThan(mm(20) * mm(15) * mm(60));
  expect(vol!).toBeLessThan(mm(40) * mm(30) * mm(60));
});

test("sweep along a cornered polyline rebuilds a multi-segment pipe (FR-32)", async ({ page }) => {
  await page.goto("/");
  await waitReady(page);

  await loadDoc(page, [
    {
      id: "f1",
      type: "sweep",
      data: {
        profile: loopProfile([
          [mm(-5), mm(-5)],
          [mm(5), mm(-5)],
          [mm(5), mm(5)],
          [mm(-5), mm(5)],
        ]),
        path: {
          kind: "polyline",
          points: [
            [0, 0, 0],
            [0, 0, mm(40)],
            [mm(30), 0, mm(70)],
          ],
        },
      },
    },
  ]);

  await page.waitForFunction(() => faceCount() > 0, undefined, { timeout: 240_000 });
  const vol = await page.evaluate(() => partVolume());
  // Must sweep BOTH edges: first segment alone would be ~10×10×40 mm³.
  expect(vol!).toBeGreaterThan(mm(10) * mm(10) * mm(40) * 1.5);
});

test("extrude join fuses a boss onto an existing body (G7)", async ({ page }) => {
  await page.goto("/");
  await waitReady(page);

  await loadDoc(page, [
    { id: "f1", type: "box", params: { dx: mm(40), dy: mm(40), dz: mm(10) } },
    {
      id: "f2",
      type: "sketch",
      data: {
        profile: loopProfile([
          [mm(10), mm(10)],
          [mm(30), mm(10)],
          [mm(30), mm(30)],
          [mm(10), mm(30)],
        ]),
        plane: { base: "XY", offset: mm(10) },
      },
    },
    {
      id: "f3",
      type: "extrude",
      deps: ["f2"],
      params: { height: mm(15) },
      data: { op: "join" },
    },
  ]);

  const vol = await page.evaluate(() => partVolume());
  const expected = mm(40) * mm(40) * mm(10) + mm(20) * mm(20) * mm(15);
  expect(vol!).toBeCloseTo(expected, 7);
  // Joined body has more faces than a plain box.
  await page.waitForFunction(() => faceCount() > 6, undefined, { timeout: 240_000 });
});

test("two-sided cut pockets the seeded-style box (G5 back)", async ({ page }) => {
  await page.goto("/");
  await waitReady(page);

  await loadDoc(page, [
    { id: "f1", type: "box", params: { dx: mm(60), dy: mm(40), dz: mm(30) } },
    {
      id: "f2",
      type: "sketch",
      data: {
        profile: loopProfile([
          [mm(20), mm(10)],
          [mm(40), mm(10)],
          [mm(40), mm(30)],
          [mm(20), mm(30)],
        ]),
        plane: { base: "XY", offset: mm(15) },
      },
    },
    { id: "f3", type: "cut", deps: ["f2"], params: { depth: mm(20), back: mm(20) } },
  ]);

  await page.waitForFunction(() => faceCount() > 6, undefined, { timeout: 240_000 });
  const vol = await page.evaluate(() => partVolume());
  const full = mm(60) * mm(40) * mm(30);
  const pocket = mm(20) * mm(20) * mm(30);
  expect(vol!).toBeCloseTo(full - pocket, 7);
});

test("ribbon loft + sweep build from real sketch profiles and rebuild cleanly (G10)", async ({
  page,
}) => {
  await page.goto("/");
  await waitReady(page);

  // C4 REMOVED the demo loft/sweep injectors: the ribbon Loft is disabled until
  // ≥2 finished sketch profiles exist, and Sweep until ≥1 (registry `enabled`).
  // This spec used to click those buttons expecting demo geometry — the button
  // was simply disabled, and the click waited out its 240 s timeout (W3). Seed
  // the REAL preconditions instead: two rectangle profiles on parallel planes at
  // different offsets (coplanar sections would loft to zero volume).
  await page.evaluate(() => {
    const rect = (o: number) => ({
      id: `s${o}`,
      type: "sketch",
      data: {
        profile: {
          kind: "loop",
          start: [0.01, 0.01],
          segments: [
            { kind: "line", to: [0.04, 0.01] },
            { kind: "line", to: [0.04, 0.03] },
            { kind: "line", to: [0.01, 0.03] },
          ],
        },
        plane: { base: "XY", offset: o },
      },
    });
    (globalThis as { __cadStore?: CadApi }).__cadStore!.getState().loadDocument({
      features: [rect(0), rect(0.05)],
      params: {},
    });
  });

  await page.getByTestId("feature-menu").getByText("Loft", { exact: true }).click();
  await waitReady(page);
  await page.waitForFunction(
    () => {
      const cad = (globalThis as { __cadStore?: CadApi }).__cadStore!;
      return cad.getState().features.some((f) => f.type === "loft");
    },
    undefined,
    { timeout: 30_000 },
  );
  await page.waitForFunction(() => faceCount() > 0, undefined, { timeout: 240_000 });

  await page.getByTestId("feature-menu").getByText("Sweep", { exact: true }).click();
  await waitReady(page);
  await page.waitForFunction(
    () => {
      const cad = (globalThis as { __cadStore?: CadApi }).__cadStore!;
      return cad.getState().features.some((f) => f.type === "sweep");
    },
    undefined,
    { timeout: 30_000 },
  );
  await page.waitForFunction(() => faceCount() > 0, undefined, { timeout: 240_000 });

  const types = await page.evaluate(() => {
    const cad = (globalThis as { __cadStore?: CadApi }).__cadStore!;
    return cad.getState().features.map((f) => f.type);
  });
  expect(types).toContain("loft");
  expect(types).toContain("sweep");
  // Demo loft/sweep produce positive volume solids through the real worker.
  const vol = await page.evaluate(() => partVolume());
  expect(vol!).toBeGreaterThan(0);
});
