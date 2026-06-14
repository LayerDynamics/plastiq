// mesh/resolve — INTEGRATION: the real FR-16 purpose — a ref captured from one solid
// re-resolves to the matching topology on a REBUILT solid (signature generation →
// resolution round-trip across a rebuild), composing normals + resolve.

import { beforeAll, describe, expect, it } from "vitest";

import { initOcct, type Occt } from "../oc/init.js";
import { makeBox } from "../solid/primitives.js";
import { mm } from "../unit/index.js";
import { edgeMidpoint, faceCentroid, faceNormal } from "./normals.js";
import { resolveEdgeRef, resolveFaceRef } from "./resolve.js";

let oc: Occt;
beforeAll(async () => {
  oc = await initOcct();
}, 120_000);

// FaceRef/EdgeRef fields are mutable triples; copy readonly Vec3 into a fresh tuple.
const triple = (v: readonly number[]): [number, number, number] => [v[0]!, v[1]!, v[2]!];

describe("resolve — capture → rebuild → re-resolve (integration)", () => {
  it("a FaceRef captured from one box re-resolves to the same face on a rebuilt box", () => {
    const a = makeBox(oc, mm(60), mm(40), mm(30));
    const topA = resolveFaceRef(oc, a, { normal: [0, 0, 1] })!;
    const ref = { normal: triple(faceNormal(oc, topA)), centroid: triple(faceCentroid(oc, topA)) };
    topA.delete();
    a.delete();

    const b = makeBox(oc, mm(60), mm(40), mm(30)); // "rebuilt" solid
    const topB = resolveFaceRef(oc, b, ref);
    expect(topB).not.toBeNull();
    const cB = faceCentroid(oc, topB!);
    expect(cB[0]).toBeCloseTo(ref.centroid[0], 6);
    expect(cB[1]).toBeCloseTo(ref.centroid[1], 6);
    expect(cB[2]).toBeCloseTo(ref.centroid[2], 6);
    topB!.delete();
    b.delete();
  });

  it("an EdgeRef (with midpoint) re-resolves to the same edge on a rebuilt box", () => {
    const a = makeBox(oc, mm(60), mm(40), mm(30));
    const edgeA = resolveEdgeRef(oc, a, { faceNormals: [[0, 0, 1], [1, 0, 0]] })!;
    const mid = triple(edgeMidpoint(oc, edgeA));
    edgeA.delete();
    a.delete();

    const b = makeBox(oc, mm(60), mm(40), mm(30));
    const edgeB = resolveEdgeRef(oc, b, { faceNormals: [[0, 0, 1], [1, 0, 0]], midpoint: mid });
    expect(edgeB).not.toBeNull();
    const midB = edgeMidpoint(oc, edgeB!);
    expect(midB[0]).toBeCloseTo(mid[0], 6);
    expect(midB[1]).toBeCloseTo(mid[1], 6);
    expect(midB[2]).toBeCloseTo(mid[2], 6);
    edgeB!.delete();
    b.delete();
  });
});
