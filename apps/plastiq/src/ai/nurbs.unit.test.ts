// SPEC-12 U9.3 — the app-side NURBS fit adapter: fitMeshToCad resolves the service base URL +
// API key from the persisted settings (nurbsBaseURL/nurbsApiKey, SPEC-12 §6.1 auth model), calls
// @plastiq/nurbs's fitNurbs (mocked here — the client's own HTTP contract is tested in
// packages/nurbs), wraps the returned STEP via the existing stepToImportDocument path into a
// CadDocument, hands it to deps.load, and surfaces the FR-9 report for honest UX labeling
// (isSolid/facetedPatches — NFR-5).

import { beforeEach, describe, expect, it, vi } from "vitest";
import { cancelJob, fitNurbs, type NurbsReport } from "@plastiq/nurbs";
import {
  cancelFit,
  fitMeshToCad,
  nurbsFitStatusMessage,
  nurbsUnreachableMessage,
  NURBS_DEFAULT_BASE_URL,
} from "./nurbs.js";
import { useAiStore } from "./aiStore.js";
import type { AiSettings } from "./settings.js";
import type { BuildProbe } from "./tools/buildPart.js";
import type { CadDocument } from "../store/types.js";

vi.mock("@plastiq/nurbs", () => ({ fitNurbs: vi.fn(), cancelJob: vi.fn() }));
const fitNurbsMock = vi.mocked(fitNurbs);
const cancelJobMock = vi.mocked(cancelJob);

/** A build probe that accepts the fitted STEP — the §2.12.2 validate-then-commit
 * gate runs on every fit, so the wiring tests need one that passes. */
const okProbe: BuildProbe = async () => ({ ok: true });

/** Minimal valid settings (the resolution tests spread nurbs fields on top). */
const BASE_SETTINGS: AiSettings = { providerKey: "anthropic", providerId: "anthropic", model: "m", apiKeys: {} };

/** A complete FR-9 report — tests override the fields they exercise. */
function report(overrides: Partial<NurbsReport> = {}): NurbsReport {
  return {
    patches: 1,
    fittedPatches: 1,
    facetedPatches: 0,
    controlPoints: 256,
    degreeU: 3,
    degreeV: 3,
    iters: 200,
    chamfer: 0.001,
    scd: 0.002,
    rmsDeviation: 0.0003,
    maxDeviation: 0.0008,
    fidelityTol: 0.01,
    isSolid: false,
    isValid: true,
    mode: "open",
    ...overrides,
  };
}

const STEP = "ISO-10303-21;\nDATA;\nENDSEC;\nEND-ISO-10303-21;";

beforeEach(() => {
  // The adapter reads the live store for settings resolution — start every test clean.
  useAiStore.setState({ settings: null, loaded: false });
  fitNurbsMock.mockReset();
  fitNurbsMock.mockResolvedValue({ step: STEP, surfaces: [], report: report() });
  cancelJobMock.mockReset();
  cancelJobMock.mockResolvedValue(undefined as never);
});

describe("fitMeshToCad — STEP → CadDocument wiring (FR-8)", () => {
  it("calls fitNurbs with the GLB, wraps the STEP via stepToImportDocument, loads it, returns the report", async () => {
    let loaded: CadDocument | null = null;
    const res = await fitMeshToCad("R0xCYWFh", { load: (d) => (loaded = d), probe: okProbe }, {}, "My mesh");

    expect(fitNurbsMock).toHaveBeenCalledTimes(1);
    expect(fitNurbsMock.mock.calls[0]![0]).toEqual({ glbBase64: "R0xCYWFh" });

    // The same one-importStep-feature document shape stepToImportDocument produces (reconstruct.ts).
    expect(loaded).not.toBeNull();
    const doc = loaded as unknown as CadDocument;
    expect(doc.features).toHaveLength(1);
    expect(doc.features[0]).toMatchObject({ type: "importStep", name: "My mesh", data: { step: STEP } });
    expect(res.doc).toBe(loaded);
    expect(res.report.mode).toBe("open");
    expect(res.report.maxDeviation).toBeCloseTo(0.0008);
  });

  it("propagates a failed fit as a throw (nothing loaded)", async () => {
    fitNurbsMock.mockRejectedValue(new Error("nurbs fit failed: genus >= 1"));
    let loaded = false;
    await expect(fitMeshToCad("R0xC", { load: () => (loaded = true), probe: okProbe })).rejects.toThrow(/genus/);
    expect(loaded).toBe(false);
  });

  it("§2.12.2: STEP that does not build is NEVER committed — it throws instead", async () => {
    // The service returns 200 with unusable STEP: the probe (a real kernel build
    // in the app) rejects it, so the document is not replaced.
    const failing: BuildProbe = async () => ({ ok: false, error: "importStep: invalid entity" });
    let loaded = false;
    await expect(
      fitMeshToCad("R0xC", { load: () => (loaded = true), probe: failing }),
    ).rejects.toThrow(/does not build: importStep: invalid entity.*original mesh is kept/s);
    expect(loaded).toBe(false); // nothing was committed — no empty viewport, no lost mesh
  });
});

describe("fitMeshToCad — settings resolution (nurbsBaseURL/nurbsApiKey, SPEC-12 §6.1)", () => {
  const deps = { load: (): void => {}, probe: okProbe };

  it("threads the persisted nurbsBaseURL into fitNurbs; absent ⇒ no baseURL (client default)", async () => {
    await fitMeshToCad("R0xC", deps);
    expect(fitNurbsMock.mock.calls[0]![1]?.baseURL).toBeUndefined();

    useAiStore.setState({ settings: { ...BASE_SETTINGS, nurbsBaseURL: "https://nurbs.example" }, loaded: true });
    await fitMeshToCad("R0xC", deps);
    expect(fitNurbsMock.mock.calls[1]![1]?.baseURL).toBe("https://nurbs.example");
  });

  it("a caller-supplied opts.baseURL wins over the persisted setting", async () => {
    useAiStore.setState({ settings: { ...BASE_SETTINGS, nurbsBaseURL: "https://from-settings" }, loaded: true });
    await fitMeshToCad("R0xC", deps, { baseURL: "https://explicit" });
    expect(fitNurbsMock.mock.calls[0]![1]?.baseURL).toBe("https://explicit");
  });

  it("threads the persisted nurbsApiKey; a caller-supplied opts.apiKey wins; neither ⇒ absent", async () => {
    await fitMeshToCad("R0xC", deps);
    expect(fitNurbsMock.mock.calls[0]![1]?.apiKey).toBeUndefined();

    useAiStore.setState({ settings: { ...BASE_SETTINGS, nurbsApiKey: "nurbs-secret" }, loaded: true });
    await fitMeshToCad("R0xC", deps);
    expect(fitNurbsMock.mock.calls[1]![1]?.apiKey).toBe("nurbs-secret");

    await fitMeshToCad("R0xC", deps, { apiKey: "explicit-key" });
    expect(fitNurbsMock.mock.calls[2]![1]?.apiKey).toBe("explicit-key");
  });

  it("passes the remaining options (signal/onState/onJob/…) through to fitNurbs", async () => {
    const onState = (): void => {};
    const onJob = (): void => {};
    await fitMeshToCad("R0xC", deps, { onState, onJob, pollIntervalMs: 5 });
    expect(fitNurbsMock.mock.calls[0]![1]?.onState).toBe(onState);
    expect(fitNurbsMock.mock.calls[0]![1]?.onJob).toBe(onJob);
    expect(fitNurbsMock.mock.calls[0]![1]?.pollIntervalMs).toBe(5);
  });
});

describe("cancelFit — server-side job cancel (M4b)", () => {
  it("threads settings and DELETEs the job", async () => {
    useAiStore.setState({ settings: { ...BASE_SETTINGS, nurbsApiKey: "nurbs-secret" }, loaded: true });
    await cancelFit("job-9");
    expect(cancelJobMock).toHaveBeenCalledTimes(1);
    expect(cancelJobMock.mock.calls[0]![0]).toBe("job-9");
    expect(cancelJobMock.mock.calls[0]![1]?.apiKey).toBe("nurbs-secret");
  });

  it("a caller-supplied opts.apiKey wins over the persisted setting", async () => {
    useAiStore.setState({ settings: { ...BASE_SETTINGS, nurbsApiKey: "from-settings" }, loaded: true });
    await cancelFit("job-9", { apiKey: "explicit-key" });
    expect(cancelJobMock.mock.calls[0]![1]?.apiKey).toBe("explicit-key");
  });
});

describe("nurbsFitStatusMessage — honest FR-9/NFR-5 labeling", () => {
  it("labels a validated solid with good fidelity cleanly", () => {
    const msg = nurbsFitStatusMessage(report({ patches: 6, fittedPatches: 6, isSolid: true, mode: "closed" }));
    expect(msg).toContain("fitted smooth CAD (NURBS)");
    expect(msg).toContain("6 patches");
    expect(msg).toContain("solid");
    expect(msg).toContain("fidelity good");
    expect(msg).not.toContain("not a solid");
    expect(msg).not.toContain("faceted");
  });

  it("labels a non-solid result honestly (isSolid === false ⇒ shell)", () => {
    const msg = nurbsFitStatusMessage(report({ isSolid: false }));
    expect(msg).toContain("shell (not a solid)");
  });

  it("surfaces faceted fallback patches (facetedPatches > 0)", () => {
    const msg = nurbsFitStatusMessage(report({ patches: 6, fittedPatches: 4, facetedPatches: 2, isSolid: true }));
    expect(msg).toContain("2 of 6 faceted (fallback)");
  });

  it("labels fidelity coarse when max deviation exceeds the tolerance", () => {
    const msg = nurbsFitStatusMessage(report({ maxDeviation: 0.5, fidelityTol: 0.01 }));
    expect(msg).toContain("fidelity coarse");
    expect(msg).toContain("Δ0.5000");
  });

  it("reports the deviation without a verdict when fidelityTol is null (the service default path, M2)", () => {
    // fitMeshToCad never sends fidelityTol, so the service reports fidelity_tol: null. The old
    // `maxDeviation <= null` was always false, mislabeling every default fit "coarse".
    const msg = nurbsFitStatusMessage(report({ maxDeviation: 0.0008, fidelityTol: null }));
    expect(msg).toContain("fidelity Δ0.0008 (no tolerance set)");
    expect(msg).not.toContain("coarse");
    expect(msg).not.toContain("fidelity good");
  });

  it("surfaces closed-mode watertightness (free_edges = 0) and volume when present (M4)", () => {
    const msg = nurbsFitStatusMessage(
      report({ patches: 6, isSolid: true, mode: "closed", freeEdges: 0, volume: 1.25e-6 }),
    );
    expect(msg).toContain("watertight (0 free edges)");
    expect(msg).toContain("volume 1250 mm³"); // 1.25e-6 m³ → 1250 mm³
  });

  it("reports open free edges honestly when the closed solid did not seal (free_edges > 0)", () => {
    const msg = nurbsFitStatusMessage(report({ isSolid: false, mode: "closed", freeEdges: 3 }));
    expect(msg).toContain("3 free edges");
    expect(msg).toContain("shell (not a solid)");
  });
});

describe("service constants — the panel's health pre-check surface", () => {
  it("NURBS_DEFAULT_BASE_URL matches the @plastiq/nurbs client default (:8003)", () => {
    expect(NURBS_DEFAULT_BASE_URL).toBe("http://localhost:8003");
  });

  it("nurbsUnreachableMessage names the URL and the documented start command", () => {
    const msg = nurbsUnreachableMessage("http://localhost:8003");
    expect(msg).toContain("unreachable at http://localhost:8003");
    expect(msg).toContain("start it with");
    expect(msg).toContain("plastiq-nurbs");
    expect(msg).toContain("8003");
  });
});
