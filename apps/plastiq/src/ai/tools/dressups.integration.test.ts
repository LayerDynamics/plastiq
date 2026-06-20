// SPEC-6 R3.3 — AI dress-ups via BOTH selection paths, end-to-end through build_part
// and the real OCCT rebuild: (a) a selector predicate in feature data, and (b) concrete
// FaceRef/EdgeRef obtained from inspect_geometry. Authoring units are mm; selection refs
// pass through to SI unchanged (they are geometry artifacts), so a ref inspected from the
// SI solid resolves on the rebuilt part.

import { beforeAll, describe, it, expect } from "vitest";
import { initOcct, tessellateTagged, type Occt } from "@plastiq/cad";
import { rebuildDocument } from "../../worker/rebuild.js";
import { buildPart, type BuildProbe } from "./buildPart.js";
import { inspectMesh } from "./inspectGeometry.js";
import type { CadDocument } from "../../store/types.js";

let oc: Occt;
beforeAll(async () => {
  oc = await initOcct();
}, 120_000);

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

describe("R3.3 AI dress-ups via both selection paths", () => {
  it("fillets the vertical edges via a selector predicate", async () => {
    const res = await buildPart(
      {
        features: [
          { id: "f1", type: "box", params: { dx: 40, dy: 20, dz: 10 } },
          { id: "f2", type: "fillet", params: { radius: 2 }, data: { selector: { kind: "verticalEdges" } } },
        ],
        params: {},
      },
      { probe: ocProbe(), apply: () => {} },
    );
    expect(res.status).toBe("ok");
  });

  it("shells open the top face via a selector predicate", async () => {
    const res = await buildPart(
      {
        features: [
          { id: "f1", type: "box", params: { dx: 40, dy: 20, dz: 10 } },
          { id: "f2", type: "shell", params: { thickness: 1.5 }, data: { selector: { kind: "topFace" } } },
        ],
        params: {},
      },
      { probe: ocProbe(), apply: () => {} },
    );
    expect(res.status).toBe("ok");
  });

  it("chamfers a concrete edge ref obtained from inspect_geometry", async () => {
    // Inspect the SI box to get a real EdgeRef, then author a chamfer that references it.
    const boxSi: CadDocument = { features: [{ id: "f1", type: "box", params: { dx: 0.04, dy: 0.02, dz: 0.01 } }], params: {} };
    const solid = rebuildDocument(oc, boxSi)!;
    let edgeRef;
    try {
      edgeRef = inspectMesh(tessellateTagged(oc, solid, {})).edgeRefs[0]!;
    } finally {
      solid.delete();
    }

    const res = await buildPart(
      {
        features: [
          { id: "f1", type: "box", params: { dx: 40, dy: 20, dz: 10 } },
          { id: "f2", type: "chamfer", params: { distance: 1 }, data: { edges: [edgeRef] } },
        ],
        params: {},
      },
      { probe: ocProbe(), apply: () => {} },
    );
    expect(res.status).toBe("ok");
  });

  it("reports a clear error when a fillet selects no edges", async () => {
    const res = await buildPart(
      {
        features: [
          { id: "f1", type: "box", params: { dx: 40, dy: 20, dz: 10 } },
          // faceByNormal yields FACES, not edges → fillet finds no edges.
          { id: "f2", type: "fillet", params: { radius: 1 }, data: { selector: { kind: "faceByNormal", normal: [0, 0, 1] } } },
        ],
        params: {},
      },
      { probe: ocProbe(), apply: () => {} },
    );
    expect(res.status).toBe("error");
    expect(res.errors).toContain("fillet");
  });
});
