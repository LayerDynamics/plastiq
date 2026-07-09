// SPEC-6 §10 / R2.6 / R5.2 — deterministic AI-pipeline E2E (NO MODEL, always on, no mocks).
//
// Drives the REAL agent tool handlers via the __plastiqAi seam — build_part validates the
// mm/deg authoring doc, converts to SI, builds it off-thread in the OCCT worker, and
// applies it atomically; inspect_geometry enumerates the built faces/edges. Every layer
// below the LLM runs for real (validation → worker → render); only the model is skipped.
//
// Coverage (SPEC-6 §10):
//   1. create → inspect → edit through build_part / inspect_geometry;
//   2. dress-up via a SELECTOR PREDICATE ({ kind: "convexEdges" } fillet, R3.2/FR-13);
//   3. a MESH document from a real GLB fixture, rendered by the mesh path (R4.2);
//   4. timeline + autosave — generated features land in the feature tree and persist to
//      the real SQLite store WITHOUT a manual save, surviving a page reload (FR-40).
//
// This is the model-free baseline E2E (CI-safe, no network). It is NOT the AI E2E — that
// requires a live model in the loop (ai-ollama.spec.ts).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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

// ── Seam shapes the extended coverage drives (module-scope like save-reload.spec.ts;
//    types are erased, so referencing them inside page.evaluate is safe) ─────────────

/** The __plastiqAi seam (apps/plastiq/src/ai/testSeam.ts) — dispatches the exact
 * production tool handlers over the live worker/store; only the model is skipped. */
interface AiSeam {
  runTool: (name: string, args: unknown) => Promise<{ result: string; isError?: boolean }>;
}
interface ProjectsApi {
  setState: (s: unknown) => void;
  getState: () => {
    init: () => Promise<void>;
    saveAs: (name: string) => Promise<void>;
    open: (id: string) => Promise<void>;
    list: { id: string; name: string }[];
    currentId: string | null;
    store: { load: (id: string) => Promise<{ doc: unknown } | null> } | null;
  };
}
interface DocApi {
  getState: () => { toDocument: () => unknown };
}

test("dress-up via selector predicate: a convexEdges fillet rounds the real built box", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("status")).toHaveText("ready", { timeout: 240_000 });

  // Baseline — the plain 40×20×10 mm box through the real build_part handler: 6 faces.
  const plain = await page.evaluate(async () => {
    const ai = (globalThis as { __plastiqAi?: AiSeam }).__plastiqAi!;
    return ai.runTool("build_part", {
      document: { features: [{ id: "b1", type: "box", params: { dx: 40, dy: 20, dz: 10 } }], params: {} },
    });
  });
  expect(plain.isError ?? false).toBe(false);
  await page.waitForFunction(() => faceCount() === 6, undefined, { timeout: 240_000 });

  // DRESS-UP — the same box plus a fillet whose edges come from a SELECTOR PREDICATE
  // ({ kind: "convexEdges" }, packages/cad/src/select/predicates.ts), not captured
  // refs: worker/rebuild.ts (dressEdges) resolves it against the freshly built solid
  // (R3.2/FR-13). Rounding the box's convex edges yields strictly MORE than the 6
  // planar faces — rendered-geometry proof the predicate reached real OCCT.
  const dressed = await page.evaluate(async () => {
    const ai = (globalThis as { __plastiqAi?: AiSeam }).__plastiqAi!;
    return ai.runTool("build_part", {
      document: {
        features: [
          { id: "b1", type: "box", params: { dx: 40, dy: 20, dz: 10 } },
          { id: "f2", type: "fillet", params: { radius: 2 }, data: { selector: { kind: "convexEdges" } } },
        ],
        params: {},
      },
    });
  });
  expect(dressed.isError ?? false).toBe(false);
  await page.waitForFunction(() => faceCount() > 6, undefined, { timeout: 240_000 });
});

test("mesh-document flow: a real GLB fixture renders through the mesh path", async ({ page }) => {
  // A REAL binary glTF from the reconstruct service's fixtures (the same cylinder its
  // E2E converts) — decoded and imported by the app's importGltf → buildMeshBody path.
  const glb = readFileSync(
    fileURLToPath(new URL("../../services/reconstruct/tests/fixtures/cylinder.glb", import.meta.url)),
  ).toString("base64");

  await page.goto("/");
  await expect(page.getByTestId("status")).toHaveText("ready", { timeout: 240_000 });

  // Open it as a generated MESH document (SPEC-6 decision 20) exactly where the app
  // holds one: projectsStore.activeMeshDoc — the create_mesh / open() landing state.
  await page.evaluate((glbB64) => {
    const projects = (globalThis as { __projectsStore?: ProjectsApi }).__projectsStore!;
    projects.setState({
      activeMeshDoc: { kind: "mesh", name: "E2E Cylinder", glb: glbB64, source: { mode: "text3d", providerId: "fal:tripo" } },
    });
  }, glb);

  // The viewport re-derives geometry from the GLB and swaps the scene to the mesh
  // branch, publishing the rendered body count (three/Scene.tsx, R4.2).
  await page.waitForFunction(
    () =>
      ((globalThis as { __plastiqViewport?: { meshBodyCount?: number } }).__plastiqViewport?.meshBodyCount ?? 0) > 0,
    undefined,
    { timeout: 240_000 },
  );

  // The GenerationPanel recognises the open mesh document and offers Convert-to-CAD.
  // (Actually RUNNING the conversion needs the reconstruction service — that whole-stack
  // path is reconstruct.spec.ts, gated on the service being up.)
  await expect(page.getByTestId("mesh-convert-run")).toBeVisible();
});

test("timeline + autosave: generated features land in the tree and persist across reload", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("status")).toHaveText("ready", { timeout: 240_000 });
  await expect(page.getByTestId("feature-row")).toHaveCount(1); // the seeded box

  // Name the project FIRST — this saveAs persists only the seeded box. Everything after
  // this line persists via the debounced AUTOSAVE alone (the test never saves again), so
  // finding the generated features in storage below proves autosave (FR-40), not saveAs.
  await page.evaluate(async () => {
    const projects = (globalThis as { __projectsStore?: ProjectsApi }).__projectsStore!;
    await projects.getState().init();
    await projects.getState().saveAs("AI Autosave E2E");
  });

  // GENERATION — box + selector-predicate fillet through the real build_part handler.
  const generated = await page.evaluate(async () => {
    const ai = (globalThis as { __plastiqAi?: AiSeam }).__plastiqAi!;
    return ai.runTool("build_part", {
      document: {
        features: [
          { id: "gen-box", type: "box", name: "AI Box", params: { dx: 40, dy: 20, dz: 10 } },
          { id: "gen-fillet", type: "fillet", name: "AI Fillet", params: { radius: 2 }, data: { selector: { kind: "convexEdges" } } },
        ],
        params: {},
      },
    });
  });
  expect(generated.isError ?? false).toBe(false);
  await page.waitForFunction(() => faceCount() > 6, undefined, { timeout: 240_000 });

  // TIMELINE — the applied document IS the ordinary parametric timeline (R2.3): the
  // feature tree shows exactly the two generated features, by type + given name.
  await expect(page.getByTestId("feature-row")).toHaveCount(2);
  await expect(page.getByTestId("feature-row").nth(0)).toHaveAttribute("aria-label", "box AI Box");
  await expect(page.getByTestId("feature-row").nth(1)).toHaveAttribute("aria-label", "fillet AI Fillet");

  // AUTOSAVE — poll the REAL IndexedDB-backed project store until the debounced
  // autosave (projectsStore, 1.5 s after the loadDocument edit) has persisted the
  // generated doc. expect.poll + page.evaluate so the async IDB read is truly awaited
  // (a waitForFunction predicate that returns a Promise would pass on the Promise
  // object itself, letting the reload race ahead of the autosave).
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const projects = (globalThis as { __projectsStore?: ProjectsApi }).__projectsStore!;
          const st = projects.getState();
          if (!st.store || !st.currentId) return false;
          const saved = await st.store.load(st.currentId);
          return saved != null && JSON.stringify(saved.doc).includes("gen-fillet");
        }),
      { timeout: 240_000 },
    )
    .toBe(true);
  // …and until the autosave's CLEAN recovery snapshot has landed (clean AND carrying the
  // generated doc — saveAs's earlier clean snapshot holds only the seeded box), so the
  // reload below takes the plain startup path (no crash-recovery banner over the UI).
  await page.waitForFunction(
    () => {
      const raw = localStorage.getItem("plastiq:recovery");
      if (!raw || !raw.includes("gen-fillet")) return false;
      try {
        return (JSON.parse(raw) as { dirty?: boolean }).dirty === false;
      } catch {
        return false;
      }
    },
    undefined,
    { timeout: 240_000 },
  );

  // RELOAD — IndexedDB (the SQLite image) survives; reopen the autosaved project and the
  // generated part is still there (save-reload.spec.ts's pattern).
  await page.reload();
  await expect(page.getByTestId("status")).toHaveText("ready", { timeout: 240_000 });
  const reloadedDoc = await page.evaluate(async () => {
    const projects = (globalThis as { __projectsStore?: ProjectsApi }).__projectsStore!;
    await projects.getState().init();
    const found = projects.getState().list.find((p) => p.name === "AI Autosave E2E");
    if (!found) throw new Error("autosaved project not found after reload");
    await projects.getState().open(found.id);
    const doc = (globalThis as { __cadStore?: DocApi }).__cadStore!;
    return JSON.stringify(doc.getState().toDocument());
  });
  expect(reloadedDoc).toContain("gen-fillet");
  await expect(page.getByTestId("feature-row")).toHaveCount(2);
  await page.waitForFunction(() => faceCount() > 6, undefined, { timeout: 240_000 });
});
