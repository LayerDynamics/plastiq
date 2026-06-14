// mesh/normals — SMOKE: the API runs on a real box face/edge and returns finite data.

import { beforeAll, describe, expect, it } from "vitest";

import { initOcct, type Occt } from "../oc/init.js";
import { makeBox } from "../solid/primitives.js";
import { mm } from "../unit/index.js";
import { resolveFaceRef } from "./resolve.js";
import { edgeMidpoint, faceCentroid, faceNormal, shapeEnums } from "./normals.js";

let oc: Occt;
beforeAll(async () => {
  oc = await initOcct();
}, 120_000);

describe("normals — smoke", () => {
  it("faceNormal / faceCentroid / edgeMidpoint run on a real box", () => {
    const box = makeBox(oc, mm(20), mm(20), mm(20));
    const face = resolveFaceRef(oc, box, { normal: [0, 0, 1] })!; // meshes the solid
    expect(faceNormal(oc, face).every(Number.isFinite)).toBe(true);
    expect(faceCentroid(oc, face).every(Number.isFinite)).toBe(true);

    const S = shapeEnums(oc);
    const map = new oc.TopTools_IndexedDataMapOfShapeListOfShape_1();
    oc.TopExp.MapShapesAndAncestors(box.shape, S.TopAbs_EDGE, S.TopAbs_FACE, map);
    const edge = oc.TopoDS.Edge_1(map.FindKey(1));
    expect(edgeMidpoint(oc, edge).every(Number.isFinite)).toBe(true);

    edge.delete();
    map.delete();
    face.delete();
    box.delete();
  });
});
