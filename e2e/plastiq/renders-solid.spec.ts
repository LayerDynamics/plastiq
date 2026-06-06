// SPEC-5 M0.6 — strict E2E (no mocks): CAD Studio loads in a REAL browser, the
// geometry Web Worker rebuilds the seeded document through real opencascade.js
// (OCCT WASM), and the three.js viewport renders the resulting tagged solid —
// one render group per B-rep face plus per-edge lines. Every layer the editor
// would touch in production runs: React shell → Zustand document → worker RPC →
// OCCT rebuild + tagged tessellation → three.js BufferGeometry.

import { expect, test } from "@playwright/test";

interface SceneStats {
  faceIds: number[];
  edgeCount: number;
  triangleIndexCount: number;
  hasNormals: boolean;
  materialSlots: number;
}

test("CAD Studio renders the seeded box as a tagged three.js solid", async ({ page }) => {
  await page.goto("/");

  // A WebGL canvas mounts immediately…
  await expect(page.locator("#viewport-root canvas")).toBeVisible();

  // …then the worker finishes the real OCCT rebuild (status flips to "ready").
  // Real in-browser OCCT can take tens of seconds to fetch + compile the WASM.
  await expect(page.getByTestId("status")).toHaveText("ready", { timeout: 240_000 });

  // The SceneController must actually hold a rendered part, not just report ready.
  await page.waitForFunction(
    () =>
      (globalThis as { __plastiqScene?: { builtPart: unknown } }).__plastiqScene?.builtPart !=
      null,
    undefined,
    { timeout: 240_000 },
  );

  // Inspect the live three.js part the SceneController is rendering.
  const stats = await page.evaluate<SceneStats | null>(() => {
    const scene = (
      globalThis as {
        __plastiqScene?: {
          builtPart: {
            mesh: {
              userData: { faceIds?: number[] };
              material: unknown[];
              geometry: {
                getIndex(): { count: number } | null;
                getAttribute(name: string): unknown;
              };
            };
            edges: unknown[];
          } | null;
        };
      }
    ).__plastiqScene;
    const part = scene?.builtPart;
    if (!part) return null;
    const idx = part.mesh.geometry.getIndex();
    return {
      faceIds: part.mesh.userData.faceIds ?? [],
      edgeCount: part.edges.length,
      triangleIndexCount: idx ? idx.count : 0,
      hasNormals: part.mesh.geometry.getAttribute("normal") != null,
      materialSlots: part.mesh.material.length,
    };
  });

  expect(stats, "the scene must hold a built part").not.toBeNull();
  // A box has 6 faces and 12 edges — each tagged with its own B-rep id.
  expect(stats!.faceIds.length).toBe(6);
  expect(stats!.edgeCount).toBe(12);
  // 6 faces × 2 triangles × 3 indices = 36.
  expect(stats!.triangleIndexCount).toBe(36);
  expect(stats!.hasNormals).toBe(true);
  // base / hover / selected material slots for face highlighting (M1).
  expect(stats!.materialSlots).toBe(3);
});
