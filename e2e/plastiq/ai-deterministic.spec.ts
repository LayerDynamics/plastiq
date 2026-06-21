// SPEC-6 R2.6/R5.2 — deterministic AI-pipeline E2E (NO MODEL, always on, no mocks).
//
// Drives the REAL agent tool handlers via the __plastiqAi seam — build_part validates the
// mm/deg authoring doc, converts to SI, builds it off-thread in the OCCT worker, and
// applies it atomically; inspect_geometry enumerates the built faces/edges. Every layer
// below the LLM runs for real (validation → worker → render); only the model is skipped.
//
// This is the model-free baseline E2E (CI-safe, no network). It is NOT the AI E2E — that
// requires a live model in the loop (ai-ollama.spec.ts).

import { expect, test } from "@playwright/test";

declare global {
  // eslint-disable-next-line no-var
  var faceCount: () => number;
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    (globalThis as { faceCount?: () => number }).faceCount = () => {
      const vp = (
        globalThis as { __plastiqViewport?: { builtPart: { mesh: { userData: { faceIds?: number[] } } } | null } }
      ).__plastiqViewport;
      return vp?.builtPart?.mesh.userData.faceIds?.length ?? 0;
    };
  });
});

test("build_part + inspect_geometry drive the real pipeline without a model", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("status")).toHaveText("ready", { timeout: 240_000 });

  // CREATE — a 40×20×10 mm box through the real build_part handler (mm→SI→OCCT→render).
  const created = await page.evaluate(async () => {
    const ai = (
      globalThis as { __plastiqAi?: { runTool: (n: string, a: unknown) => Promise<{ result: string; isError?: boolean }> } }
    ).__plastiqAi!;
    return ai.runTool("build_part", {
      document: { features: [{ id: "f1", type: "box", params: { dx: 40, dy: 20, dz: 10 } }], params: {} },
    });
  });
  expect(created.isError ?? false).toBe(false);
  // A box solid has exactly 6 faces — the real OCCT build, rendered.
  await page.waitForFunction(() => faceCount() === 6, undefined, { timeout: 240_000 });

  // INSPECT — the real inspect_geometry handler enumerates the built faces/edges (mm).
  const inspected = await page.evaluate(async () => {
    const ai = (
      globalThis as { __plastiqAi?: { runTool: (n: string, a: unknown) => Promise<{ result: string; isError?: boolean }> } }
    ).__plastiqAi!;
    return ai.runTool("inspect_geometry", {});
  });
  expect(inspected.isError ?? false).toBe(false);
  expect(inspected.result.toLowerCase()).toContain("face");

  // EDIT — replace the box with a sketch→extrude cylinder (the full modified document, per
  // the build_part contract). A cylinder solid has 3 faces (top, bottom, lateral): 6 → 3
  // proves the edit really re-ran the pipeline and re-rendered.
  const edited = await page.evaluate(async () => {
    const ai = (
      globalThis as { __plastiqAi?: { runTool: (n: string, a: unknown) => Promise<{ result: string; isError?: boolean }> } }
    ).__plastiqAi!;
    return ai.runTool("build_part", {
      document: {
        features: [
          { id: "s1", type: "sketch", data: { profile: { kind: "circle", center: [0, 0], radius: 10 }, plane: { base: "XY", offset: 0 } } },
          { id: "e1", type: "extrude", params: { height: 20 } },
        ],
        params: {},
      },
    });
  });
  expect(edited.isError ?? false).toBe(false);
  await page.waitForFunction(() => faceCount() === 3, undefined, { timeout: 240_000 });
});
