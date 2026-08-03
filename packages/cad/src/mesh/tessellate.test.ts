// R3 — tagged tessellation + persistent-ref resolution against the real OCCT wasm.

import { beforeAll, describe, expect, it } from "vitest";

import { initOcct, type Occt } from "../oc/init.js";
import { mm } from "../unit/index.js";
import { makeBox, makeBoxAt } from "../solid/primitives.js";
import { union } from "../action/boolean.js";
import { tessellateTagged } from "./tessellate.js";
import { resolveEdgeRef, resolveFaceRef } from "./resolve.js";
import { edgeMidpoint, faceCentroid, faceNormal } from "./normals.js";

let oc: Occt;

beforeAll(async () => {
  oc = await initOcct();
}, 120_000);

describe("tessellateTagged", () => {
  it("partitions a box into 6 faces, 12 edges, 8 vertices", () => {
    const box = makeBox(oc, mm(60), mm(40), mm(30));
    const mesh = tessellateTagged(oc, box);
    expect(mesh.faceGroups).toHaveLength(6);
    expect(mesh.edges).toHaveLength(12);
    expect(mesh.vertexPoints).toHaveLength(8);
    box.delete();
  });

  it("tags a closed box as bodyKind=solid with freeEdgeCount=0 (§17)", () => {
    const box = makeBox(oc, mm(60), mm(40), mm(30));
    const mesh = tessellateTagged(oc, box);
    expect(mesh.bodyKind).toBe("solid");
    expect(mesh.freeEdgeCount).toBe(0);
    expect(mesh.edges.every((e) => !e.isFree)).toBe(true);
    box.delete();
  });

  it("reports droppedFaces = 0 for a complete (valid) solid", () => {
    const box = makeBox(oc, mm(60), mm(40), mm(30));
    const mesh = tessellateTagged(oc, box);
    // A valid solid triangulates fully — the partial-mesh signal must read 0, and
    // all 6 faces are present (a non-zero count would mean a hole was hidden).
    expect(mesh.droppedFaces).toBe(0);
    expect(mesh.faceGroups).toHaveLength(6);
    box.delete();
  });

  it("emits the 6 outward axis normals as face signatures", () => {
    const box = makeBox(oc, mm(60), mm(40), mm(30));
    const mesh = tessellateTagged(oc, box);
    const rounded = mesh.faceGroups
      .map((g) => g.normal.map((x) => Math.round(x)).join(","))
      .sort();
    expect(rounded).toEqual(["-1,0,0", "0,-1,0", "0,0,-1", "0,0,1", "0,1,0", "1,0,0"]);
    box.delete();
  });

  it("produces a valid, in-range, non-empty index buffer with covering groups", () => {
    const box = makeBox(oc, mm(10), mm(10), mm(10));
    const mesh = tessellateTagged(oc, box);
    const vertCount = mesh.vertices.length / 3;
    expect(mesh.indices.length).toBeGreaterThan(0);
    expect(mesh.indices.length % 3).toBe(0);
    for (const idx of mesh.indices) {
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(vertCount);
    }
    // Face groups tile the whole index buffer contiguously.
    const totalGrouped = mesh.faceGroups.reduce((n, g) => n + g.count, 0);
    expect(totalGrouped).toBe(mesh.indices.length);
    box.delete();
  });

  it("gives each edge a polyline and two adjacent-face normals", () => {
    const box = makeBox(oc, mm(20), mm(20), mm(20));
    const mesh = tessellateTagged(oc, box);
    for (const e of mesh.edges) {
      expect(e.positions.length).toBeGreaterThanOrEqual(6); // ≥ 2 points
      expect(e.faceNormals).toHaveLength(2);
    }
    box.delete();
  });
});

describe("persistent-ref resolution (FR-16)", () => {
  it("re-resolves a captured FaceRef to a face on a rebuilt (resized) box", () => {
    // Capture the +Z top face signature on one box…
    const a = makeBox(oc, mm(60), mm(40), mm(30));
    const meshA = tessellateTagged(oc, a);
    const topA = meshA.faceGroups.find((g) => Math.round(g.normal[2]) === 1);
    expect(topA).toBeDefined();
    a.delete();

    // …and resolve it against a differently-sized box (the "rebuild").
    const b = makeBox(oc, mm(80), mm(50), mm(25));
    const face = resolveFaceRef(oc, b, { normal: topA!.normal });
    expect(face).not.toBeNull();
    // The resolved face must actually be the +Z top face, not just any face.
    const n = faceNormal(oc, face!);
    expect(Math.round(n[2])).toBe(1);
    face!.delete();
    b.delete();
  });

  it("re-resolves a captured EdgeRef across a rebuild", () => {
    const a = makeBox(oc, mm(60), mm(40), mm(30));
    const meshA = tessellateTagged(oc, a);
    const refEdge = meshA.edges[0]!;
    a.delete();

    const b = makeBox(oc, mm(80), mm(50), mm(25));
    const edge = resolveEdgeRef(oc, b, { faceNormals: refEdge.faceNormals });
    expect(edge).not.toBeNull();
    edge!.delete();
    b.delete();
  });
});

describe("FR-16 disambiguates entities sharing a signature (F1)", () => {
  it("two faces sharing the +Z normal each resolve to the RIGHT one by centroid", () => {
    // A stepped solid: a tall block over [0,30]mm unioned with a low base over the
    // full [0,60]mm. The result has TWO faces whose outward normal is +Z — a high
    // top (z≈40mm) and a low top (z≈20mm). With a normal-only signature these are
    // indistinguishable, so the old resolver returned whichever OCCT enumerated
    // first for BOTH refs.
    const base = makeBox(oc, mm(60), mm(40), mm(20));
    const tall = makeBoxAt(oc, [0, 0, 0], mm(30), mm(40), mm(40));
    const u = union(oc, base, tall);
    base.delete();
    tall.delete();
    expect(u.ok).toBe(true);
    if (!u.ok) throw new Error(u.error);
    const step = u.solid;

    const mesh = tessellateTagged(oc, step);
    const tops = mesh.faceGroups.filter((g) => Math.round(g.normal[2]) === 1);
    expect(tops.length).toBeGreaterThanOrEqual(2);
    const high = tops.reduce((a, b) => (b.centroid[2] > a.centroid[2] ? b : a));
    const low = tops.reduce((a, b) => (b.centroid[2] < a.centroid[2] ? b : a));
    expect(high.centroid[2]).toBeGreaterThan(low.centroid[2] + mm(5));

    // Each ref (normal + centroid) must resolve to ITS OWN face.
    const hi = resolveFaceRef(oc, step, { normal: high.normal, centroid: high.centroid });
    const lo = resolveFaceRef(oc, step, { normal: low.normal, centroid: low.centroid });
    expect(hi).not.toBeNull();
    expect(lo).not.toBeNull();
    const hiZ = faceCentroid(oc, hi!)[2];
    const loZ = faceCentroid(oc, lo!)[2];
    expect(hiZ).toBeCloseTo(high.centroid[2], 6); // high ref → high face
    expect(loZ).toBeCloseTo(low.centroid[2], 6); // low ref → low face
    expect(hiZ).toBeGreaterThan(loZ); // they are genuinely DIFFERENT faces
    hi!.delete();
    lo!.delete();
    step.delete();
  });

  it("re-resolves the correct same-normal face ACROSS a resize (the cross-rebuild promise)", () => {
    const stepped = (bx: number, bz: number, tx: number, tz: number) => {
      const base = makeBox(oc, bx, mm(40), bz);
      const tall = makeBoxAt(oc, [0, 0, 0], tx, mm(40), tz);
      const u = union(oc, base, tall);
      base.delete();
      tall.delete();
      if (!u.ok) throw new Error(u.error);
      return u.solid;
    };

    // Capture centroid-bearing refs for the two +Z faces of the ORIGINAL step.
    const a = stepped(mm(60), mm(20), mm(30), mm(40));
    const aTops = tessellateTagged(oc, a).faceGroups.filter((g) => Math.round(g.normal[2]) === 1);
    const aHigh = aTops.reduce((p, q) => (q.centroid[2] > p.centroid[2] ? q : p));
    const aLow = aTops.reduce((p, q) => (q.centroid[2] < p.centroid[2] ? q : p));
    const hiRef = { normal: aHigh.normal, centroid: aHigh.centroid };
    const loRef = { normal: aLow.normal, centroid: aLow.centroid };
    a.delete();

    // Resize the step (a parametric rebuild) — both +Z faces MOVE. The old refs
    // must still re-resolve to their OWN faces on the new body.
    const b = stepped(mm(80), mm(25), mm(40), mm(50));
    const hi = resolveFaceRef(oc, b, hiRef);
    const lo = resolveFaceRef(oc, b, loRef);
    expect(hi).not.toBeNull();
    expect(lo).not.toBeNull();
    const hiZ = faceCentroid(oc, hi!)[2];
    const loZ = faceCentroid(oc, lo!)[2];
    // High ref → the new high face (z≈50mm); low ref → the new low face (z≈25mm) —
    // not swapped, not both collapsed onto whichever OCCT enumerated first.
    expect(hiZ).toBeGreaterThan(loZ);
    expect(hiZ).toBeCloseTo(mm(50), 6);
    expect(loZ).toBeCloseTo(mm(25), 6);
    hi!.delete();
    lo!.delete();
    b.delete();
  });

  it("an EdgeRef carrying a midpoint resolves to the edge at that position", () => {
    const box = makeBox(oc, mm(60), mm(40), mm(30));
    const mesh = tessellateTagged(oc, box);
    const ref0 = mesh.edges[3]!; // a specific edge, not just edges[0]
    const edge = resolveEdgeRef(oc, box, {
      faceNormals: ref0.faceNormals,
      midpoint: ref0.midpoint,
    });
    expect(edge).not.toBeNull();
    // The resolved edge sits at the captured midpoint — verifying the positional
    // signature selects the intended edge, not merely "an edge".
    const mid = edgeMidpoint(oc, edge!);
    expect(mid[0]).toBeCloseTo(ref0.midpoint[0], 6);
    expect(mid[1]).toBeCloseTo(ref0.midpoint[1], 6);
    expect(mid[2]).toBeCloseTo(ref0.midpoint[2], 6);
    edge!.delete();
    box.delete();
  });

  it("falls back to normal-only when a ref has no centroid (legacy refs still resolve)", () => {
    const box = makeBox(oc, mm(60), mm(40), mm(30));
    const mesh = tessellateTagged(oc, box);
    const top = mesh.faceGroups.find((g) => Math.round(g.normal[2]) === 1)!;
    const face = resolveFaceRef(oc, box, { normal: top.normal }); // no centroid
    expect(face).not.toBeNull();
    expect(Math.round(faceNormal(oc, face!)[2])).toBe(1);
    face!.delete();
    box.delete();
  });
});
