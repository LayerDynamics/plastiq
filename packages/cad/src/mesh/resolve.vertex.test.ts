// mesh/resolve — INTEGRATION for R12 (§12.R12): a VertexRef captured from one solid
// re-resolves to the matching B-rep corner on a REBUILT / edited solid. A vertex has
// no analytic signature, so this proves the position-primary + adjacent-edge-midpoint
// disambiguator carries a measure endpoint / point-placement pick across an edit —
// the vertex analogue of resolve.integration.test.ts's Face/EdgeRef round-trips.
//
// Real OCCT (initOcct beforeAll, 120 s), no mocks: every corner, midpoint and
// adjacency below is read straight off the kernel.

import type { TopoDS_Edge, TopoDS_Vertex } from "opencascade.js";
import { beforeAll, describe, expect, it } from "vitest";

import { initOcct, type Occt } from "../oc/init.js";
import { makeBox, makeBoxAt } from "../solid/primitives.js";
import { makeCompound, type Solid } from "../solid/solid.js";
import { mm } from "../unit/index.js";
import { shapeEnums } from "./normals.js";
import { resolveVertexRef } from "./resolve.js";
import type { VertexRef } from "./tagged.js";

let oc: Occt;
beforeAll(async () => {
  oc = await initOcct();
}, 120_000);

type Tri = [number, number, number];
// VertexRef.position is a mutable triple; copy a readonly source into a fresh tuple.
const triple = (v: readonly number[]): Tri => [v[0]!, v[1]!, v[2]!];
const dist2 = (a: readonly number[], b: readonly number[]): number =>
  (a[0]! - b[0]!) ** 2 + (a[1]! - b[1]!) ** 2 + (a[2]! - b[2]!) ** 2;

/** Every unique B-rep corner position of a solid — the SAME enumeration the
 * resolver (and tessellate.ts) uses, so a captured corner is a real vertex. */
function vertexPositions(solid: Solid): Tri[] {
  const S = shapeEnums(oc);
  const map = new oc.TopTools_IndexedDataMapOfShapeListOfShape_1();
  oc.TopExp.MapShapesAndAncestors(solid.shape, S.TopAbs_VERTEX, S.TopAbs_EDGE, map);
  const out: Tri[] = [];
  const n = map.Extent();
  for (let i = 1; i <= n; i++) {
    const v = oc.TopoDS.Vertex_1(map.FindKey(i));
    const p = oc.BRep_Tool.Pnt(v);
    out.push([p.X(), p.Y(), p.Z()]);
    p.delete();
    v.delete();
  }
  map.delete();
  return out;
}

/** The B-rep point of a resolved vertex. */
function pnt(v: TopoDS_Vertex): Tri {
  const p = oc.BRep_Tool.Pnt(v);
  const out: Tri = [p.X(), p.Y(), p.Z()];
  p.delete();
  return out;
}

/** An edge's mid-parameter point. */
function edgeMid(edge: TopoDS_Edge): Tri {
  const curve = new oc.BRepAdaptor_Curve_2(edge);
  const t = 0.5 * (curve.FirstParameter() + curve.LastParameter());
  const p = curve.Value(t);
  const out: Tri = [p.X(), p.Y(), p.Z()];
  p.delete();
  curve.delete();
  return out;
}

/** Midpoints of every DISTINCT edge with an endpoint at `pos` — the complete
 * corner star, position-scanned. The test is free of the resolver's First/Last
 * binding limit, so this captures a VertexRef's full disambiguator set. Called
 * only on a lone body (where a corner owns exactly its own edges), never on a
 * compound. `TopExp_Explorer` yields each edge once PER adjacent face, so the
 * shared corner edges arrive doubled — deduped here by midpoint position. */
function edgeMidpointsAt(solid: Solid, pos: Tri): Tri[] {
  const S = shapeEnums(oc);
  const exp = new oc.TopExp_Explorer_2(solid.shape, S.TopAbs_EDGE, S.TopAbs_SHAPE);
  const eps2 = 1e-12;
  const out: Tri[] = [];
  for (; exp.More(); exp.Next()) {
    const edge = oc.TopoDS.Edge_1(exp.Current());
    const curve = new oc.BRepAdaptor_Curve_2(edge);
    const t0 = curve.FirstParameter();
    const t1 = curve.LastParameter();
    const pa = curve.Value(t0);
    const a: Tri = [pa.X(), pa.Y(), pa.Z()];
    pa.delete();
    const pb = curve.Value(t1);
    const b: Tri = [pb.X(), pb.Y(), pb.Z()];
    pb.delete();
    if (dist2(a, pos) <= eps2 || dist2(b, pos) <= eps2) {
      const pm = curve.Value(0.5 * (t0 + t1));
      const m: Tri = [pm.X(), pm.Y(), pm.Z()];
      pm.delete();
      if (!out.some((q) => dist2(q, m) <= eps2)) out.push(m);
    }
    curve.delete();
    edge.delete();
  }
  exp.delete();
  return out;
}

/** Sum of the First/Last adjacent-edge midpoint components of the compound's
 * vertex that IsSame `v` — positive when its edges head into the +octant,
 * negative into the −octant. Proves WHICH coincident corner resolved. */
function resolvedAdjacencySign(solid: Solid, v: TopoDS_Vertex): number {
  const S = shapeEnums(oc);
  const map = new oc.TopTools_IndexedDataMapOfShapeListOfShape_1();
  oc.TopExp.MapShapesAndAncestors(solid.shape, S.TopAbs_VERTEX, S.TopAbs_EDGE, map);
  let sum = 0;
  let found = false;
  const n = map.Extent();
  for (let i = 1; i <= n && !found; i++) {
    const key = oc.TopoDS.Vertex_1(map.FindKey(i));
    if (key.IsSame(v)) {
      found = true;
      const list = map.FindFromIndex(i);
      const cnt = list.Extent();
      if (cnt >= 1) {
        const e = oc.TopoDS.Edge_1(list.First_1());
        const m = edgeMid(e);
        sum += m[0] + m[1] + m[2];
        e.delete();
      }
      if (cnt >= 2) {
        const e = oc.TopoDS.Edge_1(list.Last_1());
        const m = edgeMid(e);
        sum += m[0] + m[1] + m[2];
        e.delete();
      }
    }
    key.delete();
  }
  map.delete();
  return sum;
}

describe("resolveVertexRef — capture → rebuild/edit → re-resolve (R12, real OCCT)", () => {
  it("re-resolves to the SAME corner on an identically rebuilt box", () => {
    const a = makeBox(oc, mm(60), mm(40), mm(30));
    const corner = vertexPositions(a)[0]!; // any real corner of the original body
    const ref: VertexRef = { position: triple(corner) };
    a.delete();

    const b = makeBox(oc, mm(60), mm(40), mm(30)); // "rebuilt" solid
    const v = resolveVertexRef(oc, b, ref);
    expect(v).not.toBeNull();
    const got = pnt(v!);
    expect(got[0]).toBeCloseTo(corner[0], 9);
    expect(got[1]).toBeCloseTo(corner[1], 9);
    expect(got[2]).toBeCloseTo(corner[2], 9);
    // …and the match is a genuine corner of the rebuilt body, not a near-miss.
    const nearest = Math.min(...vertexPositions(b).map((q) => dist2(q, corner)));
    expect(nearest).toBeLessThan(1e-12);
    v!.delete();
    b.delete();
  });

  it("FOLLOWS its corner onto a box of different dimensions", () => {
    const a = makeBox(oc, mm(60), mm(40), mm(30));
    // The far corner (max x+y+z) = (60,40,30) mm — resized to (80,50,40) on rebuild.
    const far = vertexPositions(a).reduce((m, c) => (c[0] + c[1] + c[2] > m[0] + m[1] + m[2] ? c : m));
    const ref: VertexRef = { position: triple(far) };
    a.delete();

    const b = makeBox(oc, mm(80), mm(50), mm(40));
    const v = resolveVertexRef(oc, b, ref);
    expect(v).not.toBeNull();
    const got = pnt(v!);
    // Expected = b's corner nearest to the ref position — DERIVED, not guessed.
    const expected = vertexPositions(b).reduce((m, c) =>
      dist2(c, ref.position) < dist2(m, ref.position) ? c : m,
    );
    expect(dist2(got, expected)).toBeLessThan(1e-12);
    // Concretely, it is b's far corner (80,50,40) mm — well inside the bbox cap.
    expect(got[0]).toBeCloseTo(mm(80), 9);
    expect(got[1]).toBeCloseTo(mm(50), 9);
    expect(got[2]).toBeCloseTo(mm(40), 9);
    v!.delete();
    b.delete();
  });

  it("FAILS LOUD (null) when the referenced corner lies beyond the bbox-diagonal cap", () => {
    // A ~1.6 m ref against a ~78 mm-diagonal box: the corner was deleted, so the
    // nearest surviving vertex is implausibly far → reject rather than mis-rebind.
    const ref: VertexRef = { position: [mm(1000), mm(1000), mm(1000)] };
    const b = makeBox(oc, mm(60), mm(40), mm(30));
    const v = resolveVertexRef(oc, b, ref);
    expect(v).toBeNull();
    b.delete();
  });

  it("DISAMBIGUATES two coincident corners of a compound by adjacentEdgeMidpoints", () => {
    // Box A occupies the +octant with its corner at the origin; box B the −octant
    // with ITS corner at the origin. A compound fuses nothing, so the origin is
    // TWO distinct B-rep vertices sharing one position — position alone cannot tell
    // them apart; their disjoint edge stars must.
    const a = makeBox(oc, mm(60), mm(40), mm(30));
    const b = makeBoxAt(oc, [mm(-60), mm(-40), mm(-30)], mm(60), mm(40), mm(30));
    const origin: Tri = [0, 0, 0];

    // Capture each corner's disambiguator from its own body (the "before" state).
    const refA: VertexRef = { position: origin, adjacentEdgeMidpoints: edgeMidpointsAt(a, origin) };
    const refB: VertexRef = { position: origin, adjacentEdgeMidpoints: edgeMidpointsAt(b, origin) };
    expect(refA.adjacentEdgeMidpoints).toHaveLength(3);
    expect(refB.adjacentEdgeMidpoints).toHaveLength(3);
    expect(refA.adjacentEdgeMidpoints!.every((m) => m[0]! + m[1]! + m[2]! > 0)).toBe(true);
    expect(refB.adjacentEdgeMidpoints!.every((m) => m[0]! + m[1]! + m[2]! < 0)).toBe(true);

    const compound = makeCompound(oc, [a, b]);
    a.delete();
    b.delete();

    // Precondition: the compound really carries two coincident vertices at origin.
    const atOrigin = vertexPositions(compound).filter((p) => dist2(p, origin) < 1e-12);
    expect(atOrigin).toHaveLength(2);

    const vA = resolveVertexRef(oc, compound, refA);
    const vB = resolveVertexRef(oc, compound, refB);
    expect(vA).not.toBeNull();
    expect(vB).not.toBeNull();
    // Both sit exactly at the shared origin …
    expect(dist2(pnt(vA!), origin)).toBeLessThan(1e-12);
    expect(dist2(pnt(vB!), origin)).toBeLessThan(1e-12);
    // … yet the disambiguator resolved DIFFERENT vertices (position could not).
    expect(vA!.IsSame(vB!)).toBe(false);
    // Correctness: each resolved vertex's own edge star points the way its ref did.
    expect(resolvedAdjacencySign(compound, vA!)).toBeGreaterThan(0);
    expect(resolvedAdjacencySign(compound, vB!)).toBeLessThan(0);

    vA!.delete();
    vB!.delete();
    compound.delete();
  });
});
