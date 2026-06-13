// faceDatumPlane against the real OCCT wasm: a sketch frame derived from a box face.

import { beforeAll, describe, expect, it } from "vitest";

import { initOcct, type Occt } from "../oc/init.js";
import { mm } from "../unit/index.js";
import { makeBox } from "../solid/primitives.js";
import { tessellateTagged } from "./tessellate.js";
import { resolveFaceRef } from "./resolve.js";
import { faceDatumPlane } from "./faceFrame.js";
import { shapeEnums } from "./normals.js";
import type { FaceRef } from "./tagged.js";
import type { TopoDS_Face } from "opencascade.js";

/** Grab the +X face of a box WITHOUT tessellating the solid first (the real
 * freshly-picked, un-meshed face path). Identified by its centroid (x ≈ dx),
 * which OCCT computes from the B-rep — no triangulation required. */
function unmeshedPlusXFace(box: ReturnType<typeof makeBox>, dx: number): TopoDS_Face {
  const S = shapeEnums(oc);
  const exp = new oc.TopExp_Explorer_2(box.shape, S.TopAbs_FACE, S.TopAbs_SHAPE);
  let target: TopoDS_Face | null = null;
  for (; exp.More(); exp.Next()) {
    const f = oc.TopoDS.Face_1(exp.Current());
    const props = new oc.GProp_GProps_1();
    oc.BRepGProp.SurfaceProperties_1(f, props, false, false);
    const c = props.CentreOfMass();
    const x = c.X();
    c.delete();
    props.delete();
    if (Math.abs(x - dx) < 1e-9) {
      target = f;
      break;
    }
    f.delete();
  }
  exp.delete();
  if (!target) throw new Error("test setup: +X face not found");
  return target;
}

let oc: Occt;

beforeAll(async () => {
  oc = await initOcct();
}, 120_000);

/** The FaceRef of the box face whose rounded normal has `axis` (0/1/2) = ±1. */
function faceRefByAxis(box: ReturnType<typeof makeBox>, axis: 0 | 1 | 2, sign: 1 | -1): FaceRef {
  const mesh = tessellateTagged(oc, box);
  const g = mesh.faceGroups.find((fg) => Math.round(fg.normal[axis]) === sign)!;
  return { normal: g.normal };
}

const dot3 = (a: readonly number[], b: readonly number[]): number =>
  a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;

describe("faceDatumPlane — sketch frame from a model face", () => {
  it("the +Z top face gives a Z-normal frame centred on the face", () => {
    const box = makeBox(oc, mm(60), mm(40), mm(30));
    const face = resolveFaceRef(oc, box, faceRefByAxis(box, 2, 1))!;
    const plane = faceDatumPlane(oc, face);
    expect(Math.abs(plane.normal[2])).toBeCloseTo(1, 6);
    expect(plane.normal[0]).toBeCloseTo(0, 6);
    expect(plane.normal[1]).toBeCloseTo(0, 6);
    // Centroid of the top face: (dx/2, dy/2, dz).
    expect(plane.origin[0]).toBeCloseTo(mm(30), 6);
    expect(plane.origin[1]).toBeCloseTo(mm(20), 6);
    expect(plane.origin[2]).toBeCloseTo(mm(30), 6);
    // xAxis is a unit, in-plane (⊥ normal) direction.
    expect(Math.hypot(plane.xAxis[0], plane.xAxis[1], plane.xAxis[2])).toBeCloseTo(1, 6);
    expect(dot3(plane.xAxis, plane.normal)).toBeCloseTo(0, 6);
    face.delete();
    box.delete();
  });

  it("a +X side face gives an X-normal frame centred on that face", () => {
    const box = makeBox(oc, mm(60), mm(40), mm(30));
    const face = resolveFaceRef(oc, box, faceRefByAxis(box, 0, 1))!;
    const plane = faceDatumPlane(oc, face);
    expect(Math.abs(plane.normal[0])).toBeCloseTo(1, 6);
    expect(plane.origin[0]).toBeCloseTo(mm(60), 6); // the +X face sits at x = dx
    // The chosen in-plane axis avoids the normal direction (no X component).
    expect(plane.xAxis[0]).toBeCloseTo(0, 6);
    expect(dot3(plane.xAxis, plane.normal)).toBeCloseTo(0, 6);
    face.delete();
    box.delete();
  });

  it("meshes a freshly-picked (un-tessellated) face internally — no fabricated +Z normal", () => {
    const box = makeBox(oc, mm(60), mm(40), mm(30));
    // The face is taken straight from the un-meshed solid. Before the fix,
    // faceNormal hit the null-triangulation branch and returned a fabricated
    // [0,0,1]; now faceDatumPlane meshes the face first and returns its real
    // outward normal (+X here, NOT +Z).
    const face = unmeshedPlusXFace(box, mm(60));
    const plane = faceDatumPlane(oc, face);
    expect(Math.abs(plane.normal[0])).toBeCloseTo(1, 6);
    expect(plane.normal[2]).toBeCloseTo(0, 6);
    expect(plane.origin[0]).toBeCloseTo(mm(60), 6);
    face.delete();
    box.delete();
  });
});
