// SPEC-6 R3.2 — selector predicates against the REAL OCCT kernel (no mocks). A box
// is the canonical fixture: 6 faces, 12 edges, known normals/areas. Resolved refs
// must re-resolve on the solid, and a predicate must pick the corresponding entity
// on a rescaled box (parameter-change survival, FR-14).

import { beforeAll, describe, it, expect } from "vitest";
import { initOcct, type Occt } from "../oc/init.js";
import { makeBox, makeCylinder } from "../solid/primitives.js";
import { subtract } from "../action/boolean.js";
import { fillet } from "../action/dressup.js";
import { tessellateTagged } from "../mesh/tessellate.js";
import { mm } from "../unit/index.js";
import { resolveFaceRef, resolveEdgeRef } from "../mesh/resolve.js";
import { resolveSelector, isSelector } from "./predicates.js";

let oc: Occt;
beforeAll(async () => {
  oc = await initOcct();
}, 120_000);

const box = (): ReturnType<typeof makeBox> => makeBox(oc, mm(40), mm(20), mm(10));

describe("R3.2 selector predicates (real OCCT)", () => {
  it("allFaces / allEdges match box topology", () => {
    const b = box();
    try {
      expect(resolveSelector(oc, b, { kind: "allFaces" }).faces).toHaveLength(6);
      expect(resolveSelector(oc, b, { kind: "allEdges" }).edges).toHaveLength(12);
    } finally {
      b.delete();
    }
  });

  // §4.10 — a cylinder's parameterisation SEAM is an edge whose two adjacent face
  // ids are equal. It is not a user-selectable edge, and feeding it to MakeFillet
  // fails the whole operation, so "fillet all edges" was a trap on any body with a
  // hole. allEdges must exclude seams, and filleting the result must SUCCEED.
  it("allEdges excludes cylinder seams, so 'fillet all edges' does not choke on a bored body", () => {
    const block = makeBox(oc, mm(40), mm(40), mm(20));
    const bore = makeCylinder(oc, mm(8), mm(60), { origin: [mm(20), mm(20), mm(-20)] });
    const r = subtract(oc, block, bore);
    bore.delete();
    block.delete();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const bored = r.solid;
    try {
      // Count seams directly from the tagged mesh (faceIds equal), and confirm
      // there is at least one to exclude.
      const mesh = tessellateTagged(oc, bored, { angularDeflection: 0.1 });
      const seams = mesh.edges.filter((e) => e.faceIds[0] === e.faceIds[1]).length;
      expect(seams, "a through-hole wall has a seam").toBeGreaterThan(0);

      const all = resolveSelector(oc, bored, { kind: "allEdges" }).edges;
      expect(all).toHaveLength(mesh.edges.length - seams);

      // The payoff: filleting every selected edge builds a valid solid instead of
      // failing on the seam.
      const filleted = fillet(oc, bored, all, mm(1));
      expect(filleted.isValid()).toBe(true);
      expect(filleted.volume()).toBeGreaterThan(0);
      filleted.delete();
    } finally {
      bored.delete();
    }
  });

  it("topFace selects the +Z face and it re-resolves", () => {
    const b = box();
    try {
      const r = resolveSelector(oc, b, { kind: "topFace" });
      expect(r.faces).toHaveLength(1);
      expect(r.faces[0]!.normal[2]).toBeGreaterThan(0.99);
      expect(resolveFaceRef(oc, b, r.faces[0]!)).not.toBeNull();
    } finally {
      b.delete();
    }
  });

  it("largestPlanarFace selects a 40×20 face (|normal.z| ≈ 1)", () => {
    const b = box();
    try {
      const r = resolveSelector(oc, b, { kind: "largestPlanarFace" });
      expect(r.faces).toHaveLength(1);
      expect(Math.abs(r.faces[0]!.normal[2])).toBeGreaterThan(0.99);
    } finally {
      b.delete();
    }
  });

  it("faceByNormal filters to the +X face", () => {
    const b = box();
    try {
      const r = resolveSelector(oc, b, { kind: "faceByNormal", normal: [1, 0, 0] });
      expect(r.faces).toHaveLength(1);
      expect(r.faces[0]!.normal[0]).toBeGreaterThan(0.99);
    } finally {
      b.delete();
    }
  });

  it("verticalEdges selects the 4 vertical edges and they re-resolve", () => {
    const b = box();
    try {
      const r = resolveSelector(oc, b, { kind: "verticalEdges" });
      expect(r.edges).toHaveLength(4);
      expect(resolveEdgeRef(oc, b, r.edges[0]!)).not.toBeNull();
    } finally {
      b.delete();
    }
  });

  it("edgesParallelTo([1,0,0]) selects the 4 X-aligned edges", () => {
    const b = box();
    try {
      expect(resolveSelector(oc, b, { kind: "edgesParallelTo", axis: [1, 0, 0] }).edges).toHaveLength(4);
    } finally {
      b.delete();
    }
  });

  it("a predicate survives a parameter change (re-resolves on the rescaled box)", () => {
    const small = box();
    const big = makeBox(oc, mm(80), mm(40), mm(20));
    try {
      const a = resolveSelector(oc, small, { kind: "topFace" }).faces[0]!;
      const b = resolveSelector(oc, big, { kind: "topFace" }).faces[0]!;
      expect(a.normal[2]).toBeGreaterThan(0.99);
      expect(b.normal[2]).toBeGreaterThan(0.99);
      expect(resolveFaceRef(oc, big, b)).not.toBeNull();
    } finally {
      small.delete();
      big.delete();
    }
  });

  it("isSelector validates shapes", () => {
    expect(isSelector({ kind: "topFace" })).toBe(true);
    expect(isSelector({ kind: "nope" })).toBe(false);
    expect(isSelector(null)).toBe(false);
  });
});
