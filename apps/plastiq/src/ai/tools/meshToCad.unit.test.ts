// Unit tests for the mesh→CAD agent tools (Task #10). Both handlers are driven with fake deps (no
// service, no stores) to pin the create_mesh-style contract: validate args → require an open mesh →
// call the local service → land the STEP via loadDocument → leave mesh mode → return a STRUCTURED
// result (never throw). Failures come back as { status:"error", errors } the model can self-correct.

import { describe, expect, it, vi } from "vitest";
import { fitNurbs, reconstructBrep, type MeshToCadDeps } from "./meshToCad.js";
import type { CadDocument, MeshDoc } from "../../store/types.js";
import type { ReconstructResult } from "../reconstruct.js";
import type { NurbsReport } from "@plastiq/nurbs";

const MESH: MeshDoc = { kind: "mesh", name: "Widget", glb: "GLB64", source: { mode: "img3d", providerId: "local" } };

function reconResult(over: Partial<ReconstructResult["report"]> = {}): ReconstructResult {
  return {
    step: "ISO-10303-21;\nHEADER;\nENDSEC;\nEND-ISO-10303-21;",
    report: { triangles_in: 12, triangles_used: 12, faces_built: 6, planar_faces: 6, is_solid: true, is_valid: true, method: "fitted", ...over },
  };
}

function nurbsReport(over: Partial<NurbsReport> = {}): NurbsReport {
  return {
    patches: 6, fittedPatches: 6, facetedPatches: 0, controlPoints: 256, degreeU: 3, degreeV: 3,
    iters: 200, chamfer: 0.001, scd: 0.002, rmsDeviation: 0.0003, maxDeviation: 0.0008, fidelityTol: 0.01,
    isSolid: true, isValid: true, mode: "closed", ...over,
  };
}

function makeDeps(over: Partial<MeshToCadDeps> = {}): MeshToCadDeps & { loaded: CadDocument[]; converted: string[] } {
  const loaded: CadDocument[] = [];
  const converted: string[] = [];
  const base: MeshToCadDeps = {
    mesh: () => MESH,
    reconstruct: vi.fn(async () => reconResult()),
    fitNurbs: vi.fn(async (_glb, deps) => {
      const doc: CadDocument = { features: [], params: {} };
      deps.load(doc); // fitMeshToCad lands the doc itself; mirror that
      return { doc, report: nurbsReport() };
    }),
    stepToDoc: vi.fn((step: string, name?: string): CadDocument => ({
      features: [{ id: "f1", type: "importStep", name: name ?? "x", data: { step } }],
      params: {},
    })),
    load: (doc) => loaded.push(doc),
    onConverted: (name) => converted.push(name),
    ...over,
  };
  return Object.assign(base, { loaded, converted });
}

describe("reconstruct_brep tool", () => {
  it("reconstructs the open mesh, loads the STEP, leaves mesh mode, reports faces + solidity", async () => {
    const deps = makeDeps();
    const r = await reconstructBrep({}, deps);

    expect(deps.reconstruct).toHaveBeenCalledWith("GLB64", expect.any(Object));
    expect(deps.stepToDoc).toHaveBeenCalledWith(expect.stringContaining("ISO-10303-21"), "Widget");
    expect(deps.loaded).toHaveLength(1);
    expect(deps.converted).toEqual(["Widget"]);
    expect(r).toMatchObject({ status: "ok" });
    expect(r.message).toMatch(/Reconstructed 'Widget'.*6 faces, solid/);
  });

  it("forwards the requested method to the service", async () => {
    const deps = makeDeps();
    await reconstructBrep({ method: "faceted" }, deps);
    expect(deps.reconstruct).toHaveBeenCalledWith("GLB64", expect.objectContaining({ method: "faceted" }));
  });

  it("reports 'shell' when the reconstruction is not a solid", async () => {
    const deps = makeDeps({ reconstruct: vi.fn(async () => reconResult({ is_solid: false, faces_built: 4 })) });
    const r = await reconstructBrep({}, deps);
    expect(r.message).toMatch(/4 faces, shell/);
  });

  it("errors (no throw, nothing loaded) when no mesh document is open", async () => {
    const deps = makeDeps({ mesh: () => null });
    const r = await reconstructBrep({}, deps);
    expect(r.status).toBe("error");
    expect(r.message).toMatch(/No mesh document is open/);
    expect(deps.loaded).toHaveLength(0);
    expect(deps.converted).toHaveLength(0);
  });

  it("returns a structured error (not a throw) when the service fails", async () => {
    const deps = makeDeps({ reconstruct: vi.fn(async () => { throw new Error("connection refused"); }) });
    const r = await reconstructBrep({}, deps);
    expect(r).toMatchObject({ status: "error" });
    expect(r.errors).toBe("connection refused");
    expect(deps.loaded).toHaveLength(0);
  });

  it("rejects invalid args with a validation error (no mesh touched)", async () => {
    const deps = makeDeps();
    const r = await reconstructBrep({ method: "nonsense" }, deps);
    expect(r.status).toBe("error");
    expect(r.message).toMatch(/did not validate/);
    expect(deps.reconstruct).not.toHaveBeenCalled();
  });
});

describe("fit_nurbs tool", () => {
  it("fits the open mesh, loads via fitMeshToCad, leaves mesh mode, reports patches + solidity", async () => {
    const deps = makeDeps();
    const r = await fitNurbs({}, deps);

    expect(deps.fitNurbs).toHaveBeenCalledWith("GLB64", expect.objectContaining({ load: expect.any(Function) }), expect.any(Object), "Widget");
    expect(deps.loaded).toHaveLength(1);
    expect(deps.converted).toEqual(["Widget"]);
    expect(r).toMatchObject({ status: "ok" });
    expect(r.message).toMatch(/Fitted smooth NURBS.*6 patches, solid/);
  });

  it("errors (no throw) when no mesh document is open", async () => {
    const deps = makeDeps({ mesh: () => null });
    const r = await fitNurbs({}, deps);
    expect(r.status).toBe("error");
    expect(deps.fitNurbs).not.toHaveBeenCalled();
  });

  it("returns a structured error when the NURBS service fails", async () => {
    const deps = makeDeps({ fitNurbs: vi.fn(async () => { throw new Error("service down"); }) });
    const r = await fitNurbs({}, deps);
    expect(r).toMatchObject({ status: "error", errors: "service down" });
    expect(deps.converted).toHaveLength(0);
  });
});
