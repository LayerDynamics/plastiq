// mesh/resolve — UNIT tests (real OCCT): persistent-ref resolution on a box.

import { beforeAll, describe, expect, it } from "vitest";

import { initOcct, type Occt } from "../oc/init.js";
import { makeBox } from "../solid/primitives.js";
import { mm } from "../unit/index.js";
import { normalize } from "../math/index.js";
import { faceNormal } from "./normals.js";
import { resolveEdgeDirection, resolveEdgeRef, resolveFaceRef } from "./resolve.js";

let oc: Occt;
beforeAll(async () => {
  oc = await initOcct();
}, 120_000);

// FaceRef/EdgeRef fields are mutable triples; the math/normals helpers return
// readonly Vec3 — copy into a fresh mutable tuple.
const triple = (v: readonly number[]): [number, number, number] => [v[0]!, v[1]!, v[2]!];

describe("resolveFaceRef (unit)", () => {
  it("resolves a FaceRef by normal to the matching face", () => {
    const box = makeBox(oc, mm(60), mm(40), mm(30));
    const face = resolveFaceRef(oc, box, { normal: [0, 0, 1] });
    expect(face).not.toBeNull();
    expect(faceNormal(oc, face!)[2]).toBeCloseTo(1, 6);
    face!.delete();
    box.delete();
  });

  it("returns null when no face normal matches within tolerance", () => {
    const box = makeBox(oc, mm(20), mm(20), mm(20));
    expect(resolveFaceRef(oc, box, { normal: triple(normalize([1, 1, 1])) })).toBeNull();
    box.delete();
  });
});

describe("resolveEdgeRef / resolveEdgeDirection (unit)", () => {
  it("resolves an EdgeRef by its adjacent-face normal pair", () => {
    const box = makeBox(oc, mm(60), mm(40), mm(30));
    const edge = resolveEdgeRef(oc, box, { faceNormals: [[0, 0, 1], [1, 0, 0]] });
    expect(edge).not.toBeNull();
    edge!.delete();
    box.delete();
  });

  it("returns null for an adjacent-normal pair no edge has (opposite faces)", () => {
    const box = makeBox(oc, mm(20), mm(20), mm(20));
    expect(resolveEdgeRef(oc, box, { faceNormals: [[0, 0, 1], [0, 0, -1]] })).toBeNull();
    box.delete();
  });

  it("resolveEdgeDirection gives a unit tangent — the +Z/+X edge runs along Y", () => {
    const box = makeBox(oc, mm(60), mm(40), mm(30));
    const dir = resolveEdgeDirection(oc, box, { faceNormals: [[0, 0, 1], [1, 0, 0]] });
    expect(Math.hypot(dir[0], dir[1], dir[2])).toBeCloseTo(1, 6);
    expect(Math.abs(dir[1])).toBeCloseTo(1, 6);
    box.delete();
  });

  it("resolveEdgeDirection throws when no edge matches the ref", () => {
    const box = makeBox(oc, mm(20), mm(20), mm(20));
    expect(() => resolveEdgeDirection(oc, box, { faceNormals: [[0, 0, 1], [0, 0, -1]] })).toThrow(
      /no edge matched/,
    );
    box.delete();
  });
});
