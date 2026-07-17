// Strict E2E (no mocks): parametric CAD feature ops through the real stack —
// Zustand document → geometry worker → OCCT WASM rebuild → tagged mesh in the
// r3f viewport. Exercises the G2–G7 authoring paths end-to-end by loading
// feature trees via the live store (same mechanism save/reload and AI use),
// then asserting face counts and mass properties from the rebuilt solid.

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
    features: { type: string }[];
    massProps: { volume: number; com: [number, number, number] } | null;
    status: string;
  };
}

function mm(v: number): number {
  return v / 1000;
}

function loopProfile(pts: [number, number][]) {
  const [start, ...rest] = pts;
  return { kind: "loop" as const, start: start!, segments: rest.map((to) => ({ kind: "line" as const, to })) };
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

async function loadDoc(
  page: Page,
  features: Record<string, unknown>[],
): Promise<void> {
  await page.evaluate((fs) => {
    const cad = (globalThis as { __cadStore?: CadApi }).__cadStore!;
    cad.getState().loadDocument({ features: fs, params: {} });
  }, features);
  await waitReady(page);
  await page.waitForFunction(() => faceCount() > 0, undefined, { timeout: 240_000 });
}

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
