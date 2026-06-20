// SPEC-6 R3.1 (T3.1): inspect_geometry against the REAL OCCT kernel — a box must
// enumerate as 6 faces + 12 edges, and the index-aligned refs must re-resolve on the
// same solid (proving the client can write them into a dress-up feature).

import { beforeAll, describe, it, expect } from "vitest";
import { initOcct, tessellateTagged, resolveFaceRef, resolveEdgeRef, type Occt } from "@plastiq/cad";
import { rebuildDocument } from "../../worker/rebuild.js";
import { inspectMesh } from "./inspectGeometry.js";
import type { CadDocument } from "../../store/types.js";

let oc: Occt;
beforeAll(async () => {
  oc = await initOcct();
}, 120_000);

describe("R3.1 inspect_geometry — real OCCT", () => {
  it("enumerates a box's faces + edges, and refs re-resolve on the solid", () => {
    const doc: CadDocument = { features: [{ id: "f1", type: "box", params: { dx: 0.04, dy: 0.02, dz: 0.01 } }], params: {} };
    const solid = rebuildDocument(oc, doc)!;
    try {
      const mesh = tessellateTagged(oc, solid, {});
      const ins = inspectMesh(mesh);

      expect(ins.faces.length).toBe(6);
      expect(ins.edges.length).toBe(12);
      expect(ins.faces.every((f) => f.kind === "planar")).toBe(true);

      // The +Z (top) face: its ref must resolve back to a real face on the solid.
      const topIdx = ins.faces.findIndex((f) => f.normal[2] > 0.99);
      expect(topIdx).toBeGreaterThanOrEqual(0);
      const face = resolveFaceRef(oc, solid, ins.faceRefs[topIdx]!);
      expect(face).not.toBeNull();
      face?.delete();

      const edge = resolveEdgeRef(oc, solid, ins.edgeRefs[0]!);
      expect(edge).not.toBeNull();
      edge?.delete();
    } finally {
      solid.delete();
    }
  }, 120_000);
});
