// M2 — clean-room B-rep traversal: dihedral edge convexity + tangent-face grouping, and the
// selectors built on them (tangentFaces / filletChain / convex|concaveEdges). Real OCCT, no
// mocks. Implemented from the standard dihedral test (docs/adr/0002), not from BRepNet's source.

import { beforeAll, describe, expect, it } from "vitest";

import { initOcct, type Occt } from "../oc/init.js";
import { makeBox, makeBoxAt } from "../solid/primitives.js";
import { fillet } from "../action/dressup.js";
import { cut } from "../action/boolean.js";
import { mm } from "../unit/index.js";
import { tessellateTagged } from "../mesh/tessellate.js";
import { edgeConvexity, faceAdjacency, growTangentFaces } from "./topology.js";
import { resolveSelector } from "./predicates.js";

let oc: Occt;
beforeAll(async () => {
  oc = await initOcct();
}, 120_000);

describe("edge convexity (clean-room dihedral, M2)", () => {
  it("a box has 12 convex edges, no concave/smooth", () => {
    const b = makeBox(oc, mm(40), mm(20), mm(10));
    try {
      const mesh = tessellateTagged(oc, b);
      const kinds = mesh.edges.map((e) => edgeConvexity(mesh, e));
      expect(mesh.edges).toHaveLength(12);
      expect(kinds.filter((k) => k === "convex")).toHaveLength(12);
      expect(kinds.filter((k) => k === "concave")).toHaveLength(0);
      expect(kinds.filter((k) => k === "smooth")).toHaveLength(0);
    } finally {
      b.delete();
    }
  });

  it("a filleted edge produces smooth (tangent) joins to its neighbours", () => {
    const b = makeBox(oc, mm(40), mm(20), mm(10));
    const e = resolveSelector(oc, b, { kind: "verticalEdges" }).edges[0]!;
    const f = fillet(oc, b, [e], mm(3));
    try {
      // tangent detection needs a curvature-resolving mesh (as resolveSelector uses), not the
      // coarse render default — otherwise a fillet's boundary triangle normal misses the tangent.
      const mesh = tessellateTagged(oc, f, { angularDeflection: 0.1 });
      const smooth = mesh.edges.filter((ed) => edgeConvexity(mesh, ed) === "smooth");
      // the rounded fillet face joins each of its two neighbour faces tangentially → ≥2 smooth edges
      expect(smooth.length).toBeGreaterThanOrEqual(2);
    } finally {
      b.delete();
      f.delete();
    }
  });

  it("a notched (step) box has at least one concave edge", () => {
    const base = makeBox(oc, mm(40), mm(40), mm(20));
    const tool = makeBoxAt(oc, [mm(20), mm(-10), mm(10)], mm(30), mm(60), mm(30));
    const notched = cut(oc, base, tool);
    try {
      const mesh = tessellateTagged(oc, notched);
      const kinds = mesh.edges.map((e) => edgeConvexity(mesh, e));
      expect(kinds.filter((k) => k === "concave").length).toBeGreaterThanOrEqual(1);
      expect(kinds.filter((k) => k === "convex").length).toBeGreaterThanOrEqual(1);
    } finally {
      base.delete();
      tool.delete();
      notched.delete();
    }
  });
});

describe("tangent-face grouping + selectors (M2)", () => {
  it("growTangentFaces over a plain box stays a single face (no smooth edges)", () => {
    const b = makeBox(oc, mm(40), mm(20), mm(10));
    try {
      const mesh = tessellateTagged(oc, b);
      const grown = growTangentFaces(mesh, mesh.faceGroups[0]!.faceId);
      expect(grown.size).toBe(1); // box faces meet at sharp edges only
      expect(faceAdjacency(mesh).size).toBe(6); // every face has neighbours
    } finally {
      b.delete();
    }
  });

  it("filletChain selects the curved fillet face; tangentFaces grows across it", () => {
    const b = makeBox(oc, mm(40), mm(20), mm(10));
    const e = resolveSelector(oc, b, { kind: "verticalEdges" }).edges[0]!;
    const f = fillet(oc, b, [e], mm(3));
    try {
      const chain = resolveSelector(oc, f, { kind: "filletChain" });
      expect(chain.faces.length).toBeGreaterThanOrEqual(1); // the rounded blend face

      // seed tangentFaces from the fillet face → grows to include its tangent neighbours
      const seed = chain.faces[0]!;
      const grown = resolveSelector(oc, f, { kind: "tangentFaces", seed });
      expect(grown.faces.length).toBeGreaterThan(1);
    } finally {
      b.delete();
      f.delete();
    }
  });

  it("convexEdges / concaveEdges partition a notched box", () => {
    const base = makeBox(oc, mm(40), mm(40), mm(20));
    const tool = makeBoxAt(oc, [mm(20), mm(-10), mm(10)], mm(30), mm(60), mm(30));
    const notched = cut(oc, base, tool);
    try {
      const convex = resolveSelector(oc, notched, { kind: "convexEdges" });
      const concave = resolveSelector(oc, notched, { kind: "concaveEdges" });
      expect(convex.edges.length).toBeGreaterThanOrEqual(1);
      expect(concave.edges.length).toBeGreaterThanOrEqual(1);
      // disjoint: no edge is both convex and concave
      const mids = new Set(convex.edges.map((e) => e.midpoint?.join(",")));
      expect(concave.edges.every((e) => !mids.has(e.midpoint?.join(",")))).toBe(true);
    } finally {
      base.delete();
      tool.delete();
      notched.delete();
    }
  });
});
