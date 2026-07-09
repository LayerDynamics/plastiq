// Adjacent-face id resolution on concentric walls — REAL OCCT wasm (finding 8-M3).
//
// A revolved tube's inner and outer lateral walls share the SAME geometric area
// centroid (the axis midpoint), so the edge pass's centroid-keyed face-id lookup
// is one quadrature residual away from a key collision: in this build the two
// keys differ ONLY in a ~1e-19 GProp noise component (x is byte-identical `0`,
// z byte-identical). Pre-fix, a byte-identical collision made last-inserted-wins
// record the WRONG faceId on every edge of the losing wall — silently. The fix
// buckets ids per centroid key and resolves a multi-id bucket by exact B-rep
// identity (IsSame), with `unresolvedEdgeFaces` counting any residual miss.
//
// These assertions pin the correct end state (each wall's edges reference THAT
// wall, both walls are traversable, nothing unresolved) and keep holding even if
// a future OCCT/wasm build's quadrature cancels exactly and the keys DO collide
// — the bucket + IsSame path then takes over with the same observable result.
// The deterministic byte-identical-collision path itself is unit-tested with a
// controlled fake kernel in tessellate.errorpaths.unit.test.ts (real geometry in
// THIS build cannot produce byte-identical keys — GProp noise is
// radius-proportional).

import { beforeAll, describe, expect, it } from "vitest";

import { initOcct, type Occt } from "../oc/init.js";
import { mm } from "../unit/index.js";
import { makeBox } from "../solid/primitives.js";
import { planeXZ } from "../env/plane.js";
import { Sketch } from "../sketch/sketch.js";
import { revolve } from "../action/revolve.js";
import type { Solid } from "../solid/solid.js";
import { edgeConvexity, faceAdjacency } from "../select/topology.js";
import { tessellateTagged } from "./tessellate.js";
import type { TaggedMesh } from "./tagged.js";

let oc: Occt;

beforeAll(async () => {
  oc = await initOcct();
}, 120_000);

/** An annular tube: the r∈[10,20]mm × 30mm rectangle revolved 2π about Z. Its inner
 * and outer lateral walls BOTH have their area centroid at the axis midpoint — the
 * near-collision (identical up to quadrature noise) this suite exists for. */
function makeTube(): Solid {
  const sk = new Sketch(planeXZ());
  sk.lineTo(mm(10), 0);
  sk.lineTo(mm(20), 0);
  sk.lineTo(mm(20), mm(30));
  sk.lineTo(mm(10), mm(30));
  return revolve(oc, sk, [0, 0, 0], [0, 0, 1], 2 * Math.PI);
}

/** Mean distance of a face group's triangle vertices from the Z axis. */
function meanRadius(mesh: TaggedMesh, faceId: number): number {
  const g = mesh.faceGroups[faceId]!;
  let sum = 0;
  let n = 0;
  for (let k = g.start; k < g.start + g.count; k++) {
    const i = mesh.indices[k]!;
    sum += Math.hypot(mesh.vertices[i * 3]!, mesh.vertices[i * 3 + 1]!);
    n++;
  }
  return sum / n;
}

/** The tube's two lateral-wall face ids `[innerId, outerId]`: the (exactly one)
 * pair of DISTINCT faces whose area centroids coincide geometrically. */
function wallPair(mesh: TaggedMesh): [number, number] {
  const pairs: Array<[number, number]> = [];
  for (const a of mesh.faceGroups) {
    for (const b of mesh.faceGroups) {
      if (a.faceId >= b.faceId) continue;
      const d = Math.hypot(
        a.centroid[0] - b.centroid[0],
        a.centroid[1] - b.centroid[1],
        a.centroid[2] - b.centroid[2],
      );
      if (d < 1e-12) pairs.push([a.faceId, b.faceId]);
    }
  }
  expect(pairs).toHaveLength(1);
  const [wA, wB] = pairs[0]!;
  return meanRadius(mesh, wA) < meanRadius(mesh, wB) ? [wA, wB] : [wB, wA];
}

describe("concentric-wall face-id resolution (shelled tube)", () => {
  it("both walls centre on the axis midpoint yet edges carry the two DISTINCT correct ids", () => {
    const tube = makeTube();
    try {
      const mesh = tessellateTagged(oc, tube);
      expect(mesh.faceGroups).toHaveLength(4); // inner wall, outer wall, two annuli
      const [innerId, outerId] = wallPair(mesh);
      expect(meanRadius(mesh, innerId)).toBeLessThan(mm(15));
      expect(meanRadius(mesh, outerId)).toBeGreaterThan(mm(15));

      // Every lookup resolved — nothing dropped, nothing unresolved.
      expect(mesh.droppedFaces).toBe(0);
      expect(mesh.droppedEdges).toBe(0);
      expect(mesh.unresolvedEdgeFaces).toBe(0);
      for (const e of mesh.edges) {
        expect(e.faceIds[0]).toBeGreaterThanOrEqual(0);
        expect(e.faceIds[1]).toBeGreaterThanOrEqual(0);
      }

      // BOTH walls appear as an edge's adjacent face. (Under a key collision,
      // pre-fix last-inserted-wins left the losing wall's id on NO edge at all.)
      expect(mesh.edges.some((e) => e.faceIds.includes(innerId))).toBe(true);
      expect(mesh.edges.some((e) => e.faceIds.includes(outerId))).toBe(true);

      // Every edge that touches a wall touches the CORRECT wall: a rim/seam edge
      // at radius 10mm must reference the inner wall, at 20mm the outer — never
      // the other (the collision failure recorded ONE wall's id at BOTH radii).
      const wallEdges = mesh.edges.filter(
        (e) => e.faceIds.includes(innerId) || e.faceIds.includes(outerId),
      );
      expect(wallEdges.length).toBeGreaterThanOrEqual(4); // 2 rims per wall (+ seams)
      for (const e of wallEdges) {
        const r = Math.hypot(e.midpoint[0], e.midpoint[1]);
        const expected = Math.abs(r - mm(10)) < Math.abs(r - mm(20)) ? innerId : outerId;
        const wrong = expected === innerId ? outerId : innerId;
        expect(e.faceIds).toContain(expected);
        expect(e.faceIds).not.toContain(wrong);
      }
    } finally {
      tube.delete();
    }
  });

  it("rim convexity is computed from the correct faces (never silently 'smooth')", () => {
    const tube = makeTube();
    try {
      const mesh = tessellateTagged(oc, tube);
      const [innerId, outerId] = wallPair(mesh);

      // Rim edges join a wall to an annulus (two DISTINCT faces) — only the seam
      // edges (one face both sides) may read as smooth.
      const rims = mesh.edges.filter(
        (e) =>
          e.faceIds[0] !== e.faceIds[1] &&
          (e.faceIds.includes(innerId) || e.faceIds.includes(outerId)),
      );
      expect(rims).toHaveLength(4); // top+bottom circles of each wall
      for (const e of rims) expect(edgeConvexity(mesh, e)).not.toBe("smooth");

      // The outer rims are exterior 90° edges — classified convex. (The inner
      // rims' exact class leans on the annulus-centroid proxy of the dihedral
      // test, so only their not-smooth / correct-id behaviour is pinned.)
      const outerRims = rims.filter((e) => e.faceIds.includes(outerId));
      expect(outerRims).toHaveLength(2);
      for (const e of outerRims) expect(edgeConvexity(mesh, e)).toBe("convex");

      // Downstream traversal sees the INNER wall too: it is adjacent to both
      // annuli across its two rim edges. (Under a pre-fix collision the losing
      // wall had NO adjacency.)
      const adj = faceAdjacency(mesh);
      const innerNeighbors = new Set((adj.get(innerId) ?? []).map((n) => n.neighbor));
      const annuli = mesh.faceGroups
        .map((g) => g.faceId)
        .filter((id) => id !== innerId && id !== outerId);
      expect(annuli).toHaveLength(2);
      for (const a of annuli) expect(innerNeighbors.has(a)).toBe(true);
    } finally {
      tube.delete();
    }
  });

  it("a collision-free solid (box) reports unresolvedEdgeFaces = 0 with unique keys", () => {
    const box = makeBox(oc, mm(40), mm(20), mm(10));
    try {
      const mesh = tessellateTagged(oc, box);
      const keys = new Set(mesh.faceGroups.map((g) => g.centroid.join(",")));
      expect(keys.size).toBe(mesh.faceGroups.length); // no buckets — fast path only
      expect(mesh.unresolvedEdgeFaces).toBe(0);
      for (const e of mesh.edges) {
        expect(e.faceIds[0]).toBeGreaterThanOrEqual(0);
        expect(e.faceIds[1]).toBeGreaterThanOrEqual(0);
      }
    } finally {
      box.delete();
    }
  });
});
