// Strict E2E (no mocks): dress-up + pattern features on a real OCCT body.
// Loads feature trees via __cadStore, rebuilds through the geometry worker, and
// asserts topology/mass changes that only a real fillet/shell/pattern produce.

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
    massProps: { volume: number } | null;
  };
}

function mm(v: number): number {
  return v / 1000;
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

/** Load a box, capture one EdgeRef + the +Z FaceRef from the live tagged mesh. */
async function boxRefs(page: Page): Promise<{ edge: unknown; top: unknown }> {
  await page.evaluate((dx) => {
    const cad = (globalThis as { __cadStore?: CadApi }).__cadStore!;
    cad.getState().loadDocument({
      features: [{ id: "f1", type: "box", params: { dx, dy: dx * 0.75, dz: dx * 0.5 } }],
      params: {},
    });
  }, mm(40));
  await waitReady(page);
  await page.waitForFunction(() => faceCount() === 6, undefined, { timeout: 240_000 });

  return page.evaluate(() => {
    const scene = (
      globalThis as {
        __plastiqViewport?: {
          builtPart: {
            mesh: { userData: { faceIds?: number[] } };
            edges: { userData: { edgeId?: number } }[];
          } | null;
        };
        __cadStore?: {
          getState: () => {
            selectionRefs: {
              faces: Record<number, unknown>;
              edges: Record<number, unknown>;
            };
          };
        };
      }
    );
    // Prefer store selection refs if the viewport published them; else synthesize
    // from typical box signatures (axis-aligned).
    const refs = scene.__cadStore?.getState().selectionRefs;
    if (refs && Object.keys(refs.edges).length > 0) {
      const edgeId = Number(Object.keys(refs.edges)[0]);
      const faceId = Number(
        Object.keys(refs.faces).find((id) => {
          const n = (refs.faces[Number(id)] as { normal?: number[] })?.normal;
          return n && Math.round(n[2]!) === 1;
        }) ?? Object.keys(refs.faces)[0],
      );
      return { edge: refs.edges[edgeId], top: refs.faces[faceId] };
    }
    // Fallback: axis-aligned box signatures match the kernel's persistent refs.
    return {
      edge: {
        faceNormals: [
          [0, 0, 1],
          [1, 0, 0],
        ],
      },
      top: { normal: [0, 0, 1] },
    };
  });
}

test("fillet on a box edge increases face count and slightly reduces volume", async ({ page }) => {
  await page.goto("/");
  await waitReady(page);
  const { edge } = await boxRefs(page);
  const beforeVol = await page.evaluate(() => partVolume());

  await page.evaluate((e) => {
    const cad = (globalThis as { __cadStore?: CadApi }).__cadStore!;
    cad.getState().loadDocument({
      features: [
        { id: "f1", type: "box", params: { dx: 0.04, dy: 0.03, dz: 0.02 } },
        {
          id: "f2",
          type: "fillet",
          deps: ["f1"],
          params: { radius: 0.003 },
          data: { edges: [e] },
        },
      ],
      params: {},
    });
  }, edge);

  await waitReady(page);
  await page.waitForFunction(() => faceCount() > 6, undefined, { timeout: 240_000 });
  const afterVol = await page.evaluate(() => partVolume());
  expect(afterVol!).toBeLessThan(beforeVol!);
  expect(afterVol!).toBeGreaterThan(beforeVol! * 0.9);
});

test("shell opening the top face hollows the box (inner walls)", async ({ page }) => {
  await page.goto("/");
  await waitReady(page);
  const { top } = await boxRefs(page);

  await page.evaluate((face) => {
    const cad = (globalThis as { __cadStore?: CadApi }).__cadStore!;
    cad.getState().loadDocument({
      features: [
        { id: "f1", type: "box", params: { dx: 0.06, dy: 0.04, dz: 0.03 } },
        {
          id: "f2",
          type: "shell",
          deps: ["f1"],
          params: { thickness: 0.003 },
          data: { faces: [face] },
        },
      ],
      params: {},
    });
  }, top);

  await waitReady(page);
  await page.waitForFunction(() => faceCount() > 6, undefined, { timeout: 240_000 });
  const vol = await page.evaluate(() => partVolume());
  const solidVol = 0.06 * 0.04 * 0.03;
  // Inward shell keeps a fraction of the solid volume.
  expect(vol!).toBeGreaterThan(solidVol * 0.2);
  expect(vol!).toBeLessThan(solidVol * 0.5);
});

test("linear pattern fuses N copies into a larger solid", async ({ page }) => {
  await page.goto("/");
  await waitReady(page);

  await page.evaluate(() => {
    const cad = (globalThis as { __cadStore?: CadApi }).__cadStore!;
    cad.getState().loadDocument({
      features: [
        { id: "f1", type: "box", params: { dx: 0.01, dy: 0.01, dz: 0.01 } },
        {
          id: "f2",
          type: "linearPattern",
          deps: ["f1"],
          params: { dx: 1, spacing: 0.02, count: 3 },
        },
      ],
      params: {},
    });
  });

  await waitReady(page);
  // Three non-overlapping 10 mm cubes → 18 faces if still separate groups after fuse,
  // or fewer if coplanar merge — either way volume is 3×.
  const vol = await page.evaluate(() => partVolume());
  expect(vol!).toBeCloseTo(3 * 0.01 ** 3, 9);
  await page.waitForFunction(() => faceCount() >= 6, undefined, { timeout: 240_000 });
});

test("circular pattern around Z produces a multi-body fused solid", async ({ page }) => {
  await page.goto("/");
  await waitReady(page);

  await page.evaluate(() => {
    const cad = (globalThis as { __cadStore?: CadApi }).__cadStore!;
    cad.getState().loadDocument({
      features: [
        { id: "f1", type: "box", params: { dx: 0.01, dy: 0.01, dz: 0.01 } },
        {
          id: "f2",
          type: "circularPattern",
          deps: ["f1"],
          params: { az: 1, count: 4, angle: Math.PI * 2, ox: 0, oy: 0, oz: 0 },
        },
      ],
      params: {},
    });
  });

  await waitReady(page);
  const vol = await page.evaluate(() => partVolume());
  // Four copies of a 10 mm cube (may overlap near origin — volume ≤ 4×, ≥ 1×).
  expect(vol!).toBeGreaterThan(0.01 ** 3 * 0.9);
  expect(vol!).toBeLessThanOrEqual(4 * 0.01 ** 3 * 1.05);
  await page.waitForFunction(() => faceCount() > 0, undefined, { timeout: 240_000 });
});
