// Sketch — UNIT (real OCCT): a profile builds a wire/face of the expected area.

import { beforeAll, describe, expect, it } from "vitest";

import { initOcct, type Occt } from "../oc/init.js";
import { planeXY } from "../env/plane.js";
import type { TopoDS_Face } from "opencascade.js";
import { Sketch } from "./sketch.js";

let oc: Occt;
beforeAll(async () => {
  oc = await initOcct();
}, 120_000);

function faceArea(face: TopoDS_Face): number {
  const props = new oc.GProp_GProps_1();
  oc.BRepGProp.SurfaceProperties_1(face, props, false, false);
  const area = props.Mass(); // for a surface, "mass" is the area
  props.delete();
  return area;
}

describe("Sketch (unit)", () => {
  it("a polygon profile builds a face of side² area", () => {
    const sk = new Sketch(planeXY());
    sk.lineTo(0, 0).lineTo(0.1, 0).lineTo(0.1, 0.1).lineTo(0, 0.1);
    const face = sk.toFace(oc);
    expect(faceArea(face)).toBeCloseTo(0.01, 6); // 0.1 × 0.1 m²
    face.delete();
  });

  it("a circle profile builds a face of area πr²", () => {
    const face = Sketch.circle(planeXY(), 0, 0, 0.05).toFace(oc);
    expect(faceArea(face)).toBeCloseTo(Math.PI * 0.05 * 0.05, 5);
    face.delete();
  });

  it("an ellipse profile builds an exact face of area πab", () => {
    const a = 0.05;
    const b = 0.02;
    const focus = Math.sqrt(a * a - b * b);
    const face = Sketch.ellipse(planeXY(), [0, 0], [focus, 0], b).toFace(oc);
    expect(faceArea(face)).toBeCloseTo(Math.PI * a * b, 8);
    face.delete();
  });

  it("lineTo chains (returns this) and toWire yields a non-null wire", () => {
    const sk = new Sketch(planeXY());
    expect(sk.lineTo(0, 0)).toBe(sk);
    sk.lineTo(0.1, 0).lineTo(0.1, 0.1).lineTo(0, 0.1);
    const wire = sk.toWire(oc);
    expect(wire.IsNull()).toBe(false);
    wire.delete();
  });
});
