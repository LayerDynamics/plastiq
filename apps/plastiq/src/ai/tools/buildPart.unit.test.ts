// SPEC-6 R2.1 (T2.1): build_part orchestration — validation, mm→SI conversion, the
// atomic apply-only-on-success contract, and structured error feedback. Uses a fake
// build probe (no OCCT) for fast, deterministic coverage; the real-OCCT path is in
// buildPart.integration.test.ts.

import { describe, it, expect, vi } from "vitest";
import { buildPart, geometryClientProbe, type BuildProbe } from "./buildPart.js";
import type { CadDocument } from "../../store/types.js";
import type { TransferMesh } from "../../worker/protocol.js";

const okProbe: BuildProbe = async () => ({ ok: true });
const failProbe: BuildProbe = async () => ({ ok: false, error: "feature 'f1' (extrude): no sketch profile upstream" });

const validBox = { features: [{ id: "f1", type: "box", params: { dx: 40, dy: 20, dz: 10 } }], params: {} };

describe("R2.1 build_part — success path", () => {
  it("validates, converts to SI, builds, and applies", async () => {
    let applied: CadDocument | null = null;
    const res = await buildPart(validBox, { probe: okProbe, apply: (d) => { applied = d; } });
    expect(res.status).toBe("ok");
    expect(applied).not.toBeNull();
    expect(applied!.features[0]!.params!.dx).toBeCloseTo(0.04, 12); // mm→SI applied
  });
});

describe("R2.1 build_part — atomic failure paths (never apply)", () => {
  it("rejects a schema-invalid doc and does not probe or apply", async () => {
    const probe = vi.fn(okProbe);
    const apply = vi.fn();
    const res = await buildPart(
      { features: [{ id: "f1", type: "box", params: { dx: 40, dy: 20 } }], params: {} }, // missing dz
      { probe, apply },
    );
    expect(res.status).toBe("error");
    expect(res.errors).toBeTruthy();
    expect(probe).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });

  it("rejects features dumped under 'assembly' (silent-loss guard), and does not apply", async () => {
    const probe = vi.fn(okProbe);
    const apply = vi.fn();
    const res = await buildPart(
      {
        features: [{ id: "f1", type: "box", params: { dx: 40, dy: 20, dz: 10 } }],
        params: {},
        assembly: { features: [{ id: "f2", type: "cut", params: { depth: 5 } }] },
      },
      { probe, apply },
    );
    expect(res.status).toBe("error");
    expect(res.message).toMatch(/assembly/i);
    expect(probe).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });

  it("feeds the probe's build error back and does not apply", async () => {
    const apply = vi.fn();
    const res = await buildPart(validBox, { probe: failProbe, apply });
    expect(res.status).toBe("error");
    expect(res.errors).toContain("extrude");
    expect(apply).not.toHaveBeenCalled();
  });

  it("rejects a non-object input", async () => {
    const apply = vi.fn();
    const res = await buildPart("not a document", { probe: okProbe, apply });
    expect(res.status).toBe("error");
    expect(apply).not.toHaveBeenCalled();
  });
});

describe("R2.1 geometryClientProbe — the app probe over the worker's build (the __plastiqBuild seam)", () => {
  const emptyDoc: CadDocument = { features: [], params: {} };
  // The probe checks the mesh AND the per-feature statuses, so a minimal
  // stand-in suffices (no worker in unit tests).
  const someMesh = {} as TransferMesh;

  it("maps a returned mesh with no failed features to ok", async () => {
    const probe = geometryClientProbe({ build: async () => ({ mesh: someMesh, statuses: [] }) });
    expect(await probe(emptyDoc)).toEqual({ ok: true });
  });

  it("reports the no-geometry error on a null mesh (the worker's failed-build signal)", async () => {
    const probe = geometryClientProbe({ build: async () => ({ mesh: null, statuses: [] }) });
    const r = await probe(emptyDoc);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no geometry/);
  });

  it("REJECTS a document whose feature errored even though geometry survived", async () => {
    // The rebuild isolates per-feature failures, so a broken document can still
    // hand back a mesh. A probe that only looked at the mesh would green-light
    // it and let the agent apply half-built geometry.
    const probe = geometryClientProbe({
      build: async () => ({
        mesh: someMesh,
        statuses: [
          { featureId: "f1", status: "ok" as const },
          { featureId: "f2", status: "error" as const, message: "feature 'f2' (fillet): radius too large" },
        ],
      }),
    });
    const r = await probe(emptyDoc);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/f2.*radius too large/);
  });

  it("maps a thrown build error to a structured probe error (never a throw to the agent loop)", async () => {
    const probe = geometryClientProbe({
      build: async () => {
        throw new Error("worker exploded");
      },
    });
    expect(await probe(emptyDoc)).toEqual({ ok: false, error: "worker exploded" });
  });
});
