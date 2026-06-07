// Strict E2E (no mocks): Plastiq loads in a REAL browser, the geometry Web Worker
// rebuilds the seeded document through real opencascade.js (OCCT WASM), and the
// r3f viewport renders the resulting tagged solid — one render group per B-rep
// face plus per-edge lines. Every layer runs: React shell → Zustand document →
// worker RPC → OCCT rebuild + tagged tessellation → three.js BufferGeometry → r3f.
//
// Seams: the r3f viewport publishes the built part on __plastiqViewport.builtPart
// (same BuiltPart shape buildMesh produces) and fitToView() to frame it.

import { expect, test } from "@playwright/test";

interface SceneStats {
  faceIds: number[];
  edgeCount: number;
  triangleIndexCount: number;
  hasNormals: boolean;
  materialSlots: number;
}

test("Plastiq renders the seeded box as a tagged three.js solid (r3f)", async ({ page }) => {
  await page.goto("/");

  // A WebGL canvas mounts immediately…
  await expect(page.locator("#viewport-root canvas")).toBeVisible();

  // …then the worker finishes the real OCCT rebuild (status flips to "ready").
  await expect(page.getByTestId("status")).toHaveText("ready", { timeout: 240_000 });

  // The viewport must actually hold a rendered part, not just report ready.
  await page.waitForFunction(
    () =>
      (globalThis as { __plastiqViewport?: { builtPart: unknown } }).__plastiqViewport?.builtPart !=
      null,
    undefined,
    { timeout: 240_000 },
  );

  // Inspect the live three.js part the r3f viewport is rendering.
  const stats = await page.evaluate<SceneStats | null>(() => {
    const part = (
      globalThis as {
        __plastiqViewport?: {
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
    ).__plastiqViewport?.builtPart;
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

  expect(stats, "the viewport must hold a built part").not.toBeNull();
  // A box has 6 faces and 12 edges — each tagged with its own B-rep id.
  expect(stats!.faceIds.length).toBe(6);
  expect(stats!.edgeCount).toBe(12);
  expect(stats!.triangleIndexCount).toBe(36); // 6 faces × 2 tris × 3 indices
  expect(stats!.hasNormals).toBe(true);
  expect(stats!.materialSlots).toBe(3); // base / hover / selected face slots

  // …and it is ACTUALLY drawn: frame the part, then sample the canvas — a real
  // share of pixels must differ from the dark background (the box is on screen).
  await page.evaluate(() =>
    (globalThis as { __plastiqViewport?: { fitToView?: () => void } }).__plastiqViewport?.fitToView?.(),
  );
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );
  const nonBackgroundFraction = await page.evaluate(() => {
    const src = document.querySelector("#viewport-root canvas") as HTMLCanvasElement;
    const c = document.createElement("canvas");
    c.width = src.width;
    c.height = src.height;
    const ctx = c.getContext("2d")!;
    ctx.drawImage(src, 0, 0);
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    // Background is ~#0b0d12 (11,13,18). Count pixels clearly brighter than it.
    let lit = 0;
    const total = data.length / 4;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i]! > 40 || data[i + 1]! > 40 || data[i + 2]! > 45) lit++;
    }
    return lit / total;
  });
  expect(nonBackgroundFraction).toBeGreaterThan(0.02); // the box fills real screen area
});
