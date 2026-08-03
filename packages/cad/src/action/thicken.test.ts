// Real-OCCT tests for thicken (§13.2, §14): an open face → a solid plate whose
// volume is the analytic faceArea × thickness, plus the wall-magnitude guards.

import { beforeAll, describe, expect, it } from "vitest";
import { initOcct, type Occt } from "../oc/init.js";
import { makeBox } from "../solid/primitives.js";
import { shapeEnums } from "../mesh/normals.js";
import { Solid } from "../solid/solid.js";
import { thicken } from "./thicken.js";
import type { TopoDS_Face } from "opencascade.js";

let oc: Occt;
beforeAll(async () => {
  oc = await initOcct();
});

/** The first planar face of a box, and its analytic surface area + centroid. */
function firstFace(box: Solid): { face: TopoDS_Face; area: number; centroid: [number, number, number] } {
  const S = shapeEnums(oc);
  const exp = new oc.TopExp_Explorer_2(box.shape, S.TopAbs_FACE, S.TopAbs_SHAPE);
  const face = oc.TopoDS.Face_1(exp.Current());
  exp.delete();
  const props = new oc.GProp_GProps_1();
  try {
    oc.BRepGProp.SurfaceProperties_1(face, props, false, false);
    const area = props.Mass();
    const c = props.CentreOfMass();
    const centroid: [number, number, number] = [c.X(), c.Y(), c.Z()];
    c.delete();
    return { face, area, centroid };
  } finally {
    props.delete();
  }
}

function dist(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

describe("thicken", () => {
  it("turns a planar face into a solid plate of volume faceArea × thickness", () => {
    const box = makeBox(oc, 0.04, 0.03, 0.02);
    const { face, area, centroid } = firstFace(box);
    const faceSolid = new Solid(oc, face); // wrap the bare face as a sheet body
    const t = 0.005;

    const plate = thicken(oc, faceSolid, t);
    try {
      // Analytic: a flat plate is exactly its face area times the wall thickness.
      expect(plate.volume()).toBeCloseTo(area * t, 12);
      // And it is a real, watertight, positively-oriented solid — not a skin.
      expect(plate.volume()).toBeGreaterThan(0);
      expect(plate.isValid()).toBe(true);
      // One-sided: the whole wall grows to one side, so the plate's centroid sits
      // half a wall (t/2) off the face plane.
      expect(dist(plate.centreOfMass(), centroid)).toBeCloseTo(t / 2, 9);
    } finally {
      plate.delete();
      faceSolid.delete(); // frees the wrapped face
      box.delete();
    }
  });

  it("bothSides centres the wall on the surface (same volume, centroid on the face plane)", () => {
    const box = makeBox(oc, 0.04, 0.03, 0.02);
    const { face, area, centroid } = firstFace(box);
    const faceSolid = new Solid(oc, face);
    const t = 0.005;

    const oneSided = thicken(oc, faceSolid, t);
    const centred = thicken(oc, faceSolid, t, { bothSides: true });
    try {
      // Same wall ⇒ same volume, whichever way it is distributed.
      expect(centred.volume()).toBeCloseTo(area * t, 12);
      expect(centred.volume()).toBeCloseTo(oneSided.volume(), 12);
      expect(centred.isValid()).toBe(true);
      // Centred: the original surface is the mid-plane, so the centroid is ON the
      // face plane — and measurably closer to it than the one-sided plate's.
      const centredDist = dist(centred.centreOfMass(), centroid);
      const oneSidedDist = dist(oneSided.centreOfMass(), centroid);
      expect(centredDist).toBeCloseTo(0, 9);
      expect(centredDist).toBeLessThan(oneSidedDist);
    } finally {
      centred.delete();
      oneSided.delete();
      faceSolid.delete();
      box.delete();
    }
  });

  it("thickens with the same volume whichever side (sign of thickness) the wall grows", () => {
    const box = makeBox(oc, 0.04, 0.03, 0.02);
    const { face, area } = firstFace(box);
    const faceSolid = new Solid(oc, face);

    const pos = thicken(oc, faceSolid, 0.005);
    const neg = thicken(oc, faceSolid, -0.005);
    try {
      // The sign only picks the side; both are valid solids of the same volume.
      expect(pos.volume()).toBeCloseTo(area * 0.005, 12);
      expect(neg.volume()).toBeCloseTo(area * 0.005, 12);
      expect(pos.volume()).toBeGreaterThan(0);
      expect(neg.volume()).toBeGreaterThan(0);
      expect(neg.isValid()).toBe(true);
    } finally {
      pos.delete();
      neg.delete();
      faceSolid.delete();
      box.delete();
    }
  });

  it("rejects a zero, NaN, or infinite wall with a named error, before touching OCCT", () => {
    const box = makeBox(oc, 0.04, 0.03, 0.02);
    const { face } = firstFace(box);
    const faceSolid = new Solid(oc, face);
    try {
      expect(() => thicken(oc, faceSolid, 0)).toThrow(/thicken: thickness must be a finite non-zero number \(got 0\)/);
      expect(() => thicken(oc, faceSolid, Number.NaN)).toThrow(/thicken: thickness must be a finite non-zero number/);
      expect(() => thicken(oc, faceSolid, Number.POSITIVE_INFINITY)).toThrow(/thicken: thickness must be a finite non-zero number/);
    } finally {
      faceSolid.delete();
      box.delete();
    }
  });
});
