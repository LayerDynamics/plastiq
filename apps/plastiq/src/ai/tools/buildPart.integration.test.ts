// SPEC-6 R2.1 (T2.1): build_part against the REAL OCCT kernel (no mocks). The probe
// builds through rebuildDocument (the same evaluator the worker runs), so this
// exercises the full validate → mm→SI → real build → atomic apply path, including
// the per-feature error that a real build throws.

import { beforeAll, describe, it, expect } from "vitest";
import { initOcct, type Occt } from "@plastiq/cad";
import { rebuildDocument } from "../../worker/rebuild.js";
import { buildPart, type BuildProbe } from "./buildPart.js";
import type { CadDocument } from "../../store/types.js";

let oc: Occt;
beforeAll(async () => {
  oc = await initOcct();
}, 120_000);

/** Real-OCCT build probe: build + dispose; surface the thrown per-feature error. */
function ocProbe(): BuildProbe {
  return async (doc: CadDocument) => {
    try {
      const solid = rebuildDocument(oc, doc);
      solid?.delete();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  };
}

describe("R2.1 build_part — real OCCT", () => {
  it("builds + applies a 40mm box, stored in SI", async () => {
    let applied: CadDocument | null = null;
    const res = await buildPart(
      { features: [{ id: "f1", type: "box", params: { dx: 40, dy: 20, dz: 10 } }], params: {} },
      { probe: ocProbe(), apply: (d) => { applied = d; } },
    );
    expect(res.status).toBe("ok");
    expect(applied!.features[0]!.params!.dx).toBeCloseTo(0.04, 12);
  });

  it("builds a sketch→extrude part (circle profile)", async () => {
    const res = await buildPart(
      {
        features: [
          { id: "f1", type: "sketch", data: { profile: { kind: "circle", center: [0, 0], radius: 10 }, plane: { base: "XY", offset: 0 } } },
          { id: "f2", type: "extrude", params: { height: 20 } },
        ],
        params: {},
      },
      { probe: ocProbe(), apply: () => {} },
    );
    expect(res.status).toBe("ok");
  });

  it("does NOT apply when a real feature build fails (atomic)", async () => {
    let applied = false;
    const res = await buildPart(
      // extrude with no upstream sketch → rebuildDocument throws a per-feature error.
      { features: [{ id: "f1", type: "extrude", params: { height: 5 } }], params: {} },
      { probe: ocProbe(), apply: () => { applied = true; } },
    );
    expect(res.status).toBe("error");
    expect(res.errors).toContain("extrude");
    expect(applied).toBe(false);
  });
});
