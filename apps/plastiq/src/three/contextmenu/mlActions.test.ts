// Unit tests for the mesh→CAD canvas context actions (Task #8). The DI-injected run* fns are driven
// with fake deps (no WebGL / fetch / global stores) so we assert the exact orchestration the live
// action performs: health pre-flight → service call → load the STEP as a parametric doc → leave mesh
// mode with an honest status. Also pins the ML_CONTEXT_ACTIONS gating (visible/enabled iff a MeshDoc
// is open) that makes them appear in BOTH the context menu and the RECM ring.

import { describe, expect, it, vi } from "vitest";
import { ML_CONTEXT_ACTIONS, runFitNurbs, runReconstructBrep, type MlActionDeps } from "./mlActions.js";
import type { ContextTarget } from "./contextSelection.js";
import type { MeshDoc } from "../../store/types.js";
import type { ReconstructResult } from "../../ai/reconstruct.js";
import type { NurbsReport } from "@plastiq/nurbs";
import type { CadDocument } from "../../store/types.js";

const MESH: MeshDoc = { kind: "mesh", name: "Widget", glb: "GLB_BASE64", source: { mode: "img3d", providerId: "local" } };

function reconResult(over: Partial<ReconstructResult["report"]> = {}): ReconstructResult {
  return {
    step: "ISO-10303-21;\nHEADER;\nENDSEC;\nEND-ISO-10303-21;",
    report: { triangles_in: 10, triangles_used: 10, faces_built: 6, planar_faces: 6, is_solid: true, is_valid: true, method: "fitted", ...over },
  };
}

function nurbsReport(over: Partial<NurbsReport> = {}): NurbsReport {
  return {
    patches: 6, fittedPatches: 6, facetedPatches: 0, controlPoints: 256, degreeU: 3, degreeV: 3,
    iters: 200, chamfer: 0.001, scd: 0.002, rmsDeviation: 0.0003, maxDeviation: 0.0008, fidelityTol: 0.01,
    isSolid: true, isValid: true, mode: "closed", ...over,
  };
}

/** Fake deps with spies; overrides tune per-test behaviour. */
function makeDeps(over: Partial<MlActionDeps> = {}): MlActionDeps & {
  loaded: CadDocument[];
  statuses: string[];
  finished: Array<{ name: string; status: string }>;
} {
  const loaded: CadDocument[] = [];
  const statuses: string[] = [];
  const finished: Array<{ name: string; status: string }> = [];
  return {
    mesh: MESH,
    reconstructBaseURL: undefined,
    nurbsBaseURL: undefined,
    checkHealth: vi.fn(async () => true),
    reconstruct: vi.fn(async () => reconResult()),
    fitNurbs: vi.fn(async (_glb, deps) => {
      const doc: CadDocument = { features: [], params: {} };
      deps.load(doc); // fitMeshToCad loads internally; mirror that
      return { doc, report: nurbsReport() };
    }),
    load: (doc) => loaded.push(doc),
    finish: (name, status) => finished.push({ name, status }),
    setStatus: (s) => statuses.push(s),
    loaded,
    statuses,
    finished,
    ...over,
  } as MlActionDeps & { loaded: CadDocument[]; statuses: string[]; finished: Array<{ name: string; status: string }> };
}

describe("runReconstructBrep", () => {
  it("health-checks the default :8000, reconstructs, loads the STEP, finishes with an honest status", async () => {
    const deps = makeDeps();
    await runReconstructBrep(deps);

    expect(deps.checkHealth).toHaveBeenCalledWith("http://localhost:8000");
    expect(deps.reconstruct).toHaveBeenCalledWith("GLB_BASE64", expect.objectContaining({ onState: expect.any(Function) }));
    expect(deps.loaded).toHaveLength(1);
    expect(deps.loaded[0]!.features[0]).toMatchObject({ type: "importStep", name: "Widget" });
    expect(deps.finished).toEqual([{ name: "Widget", status: "reconstructed to CAD — 6 faces, solid" }]);
  });

  it("reports 'shell' (not solid) honestly", async () => {
    const deps = makeDeps({ reconstruct: vi.fn(async () => reconResult({ is_solid: false, faces_built: 3 })) });
    await runReconstructBrep(deps);
    expect(deps.finished[0]!.status).toBe("reconstructed to CAD — 3 faces, shell");
  });

  it("aborts with the 'start it with…' hint when the service is down — no reconstruct/load/finish", async () => {
    const deps = makeDeps({ checkHealth: vi.fn(async () => false) });
    await runReconstructBrep(deps);
    expect(deps.reconstruct).not.toHaveBeenCalled();
    expect(deps.loaded).toHaveLength(0);
    expect(deps.finished).toHaveLength(0);
    expect(deps.statuses.at(-1)).toMatch(/unreachable at http:\/\/localhost:8000/);
  });

  it("routes the health check + reconstruct through a caller baseURL override", async () => {
    const deps = makeDeps({ reconstructBaseURL: "https://recon.example/" });
    await runReconstructBrep(deps);
    expect(deps.checkHealth).toHaveBeenCalledWith("https://recon.example"); // trailing slash trimmed
    expect(deps.reconstruct).toHaveBeenCalledWith("GLB_BASE64", expect.objectContaining({ baseURL: "https://recon.example/" }));
  });
});

describe("runFitNurbs", () => {
  it("health-checks the default :8003, fits, loads via fitMeshToCad, finishes with the fit report", async () => {
    const deps = makeDeps();
    await runFitNurbs(deps);

    expect(deps.checkHealth).toHaveBeenCalledWith("http://localhost:8003");
    expect(deps.fitNurbs).toHaveBeenCalledWith("GLB_BASE64", expect.objectContaining({ load: expect.any(Function) }), expect.any(Object), "Widget");
    expect(deps.loaded).toHaveLength(1);
    expect(deps.finished[0]!.status).toMatch(/^fitted smooth CAD \(NURBS\) — 6 patches, solid/);
  });

  it("aborts with the NURBS 'start it with…' hint when the service is down", async () => {
    const deps = makeDeps({ checkHealth: vi.fn(async () => false) });
    await runFitNurbs(deps);
    expect(deps.fitNurbs).not.toHaveBeenCalled();
    expect(deps.loaded).toHaveLength(0);
    expect(deps.statuses.at(-1)).toMatch(/NURBS fitting service unreachable at http:\/\/localhost:8003/);
  });
});

describe("ML_CONTEXT_ACTIONS gating", () => {
  const withMesh = { activeMeshDoc: MESH } as ContextTarget;
  const noMesh = { activeMeshDoc: null } as ContextTarget;

  it("exposes exactly the two mesh→CAD actions in the 'modify' group", () => {
    expect(ML_CONTEXT_ACTIONS.map((a) => a.id)).toEqual(["ml-reconstruct-brep", "ml-fit-nurbs"]);
    expect(ML_CONTEXT_ACTIONS.every((a) => a.group === "modify")).toBe(true);
  });

  it("is visible + enabled only when a generated mesh document is open", () => {
    for (const a of ML_CONTEXT_ACTIONS) {
      expect(a.visible(withMesh)).toBe(true);
      expect(a.enabled(withMesh)).toBe(true);
      expect(a.visible(noMesh)).toBe(false);
      expect(a.enabled(noMesh)).toBe(false);
    }
  });

  it("labels read for a menu/ring", () => {
    expect(ML_CONTEXT_ACTIONS[0]!.label(withMesh)).toBe("Reconstruct B-rep");
    expect(ML_CONTEXT_ACTIONS[1]!.label(withMesh)).toBe("Fit NURBS surface");
  });
});
