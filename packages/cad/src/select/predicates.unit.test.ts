// SPEC-6 R3.2 — selector predicates against the REAL OCCT kernel (no mocks). A box
// is the canonical fixture: 6 faces, 12 edges, known normals/areas. Resolved refs
// must re-resolve on the solid, and a predicate must pick the corresponding entity
// on a rescaled box (parameter-change survival, FR-14).

import { beforeAll, describe, it, expect } from "vitest";
import { initOcct, type Occt } from "../oc/init.js";
import { makeBox } from "../solid/primitives.js";
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
