import type { TopoDS_Shape } from "opencascade.js";
import { beforeAll, describe, expect, it } from "vitest";
import { planeXY } from "../environment/plane.js";
import { initOcct, type Occt } from "../oc/init.js";
import { makeBox } from "../solid/primitives.js";
import { Sketch } from "../sketch/sketch.js";
import { mm } from "../unit/index.js";
import { extrude, extrudeToFace } from "./extrude.js";

const INIT_TIMEOUT_MS = 120_000;

function volume(oc: Occt, shape: TopoDS_Shape): number {
  const props = new oc.GProp_GProps_1();
  try {
    oc.BRepGProp.VolumeProperties_1(shape, props, false, false, false);
    return props.Mass();
  } finally {
    props.delete();
  }
}

function centroidZ(oc: Occt, shape: TopoDS_Shape): number {
  const props = new oc.GProp_GProps_1();
  try {
    oc.BRepGProp.VolumeProperties_1(shape, props, false, false, false);
    const c = props.CentreOfMass();
    const z = c.Z();
    c.delete();
    return z;
  } finally {
    props.delete();
  }
}

describe("extrude options (SPEC-5 FR-29)", () => {
  let oc: Occt;
  beforeAll(async () => {
    oc = await initOcct();
  }, INIT_TIMEOUT_MS);

  const rect = (): Sketch => Sketch.rectangle(planeXY(), mm(20), mm(30));
  const area = mm(20) * mm(30);

  it("blind extrude: volume = area × height, centred above z=0", () => {
    const s = extrude(oc, rect(), mm(10));
    try {
      expect(volume(oc, s.shape) / (area * mm(10))).toBeCloseTo(1, 6);
      expect(centroidZ(oc, s.shape)).toBeCloseTo(mm(5), 6); // spans 0..10mm
    } finally {
      s.shape.delete();
    }
  });

  it("two-sided extrude spans both ways and is centred on the plane", () => {
    const s = extrude(oc, rect(), mm(10), { back: mm(10) });
    try {
      expect(volume(oc, s.shape) / (area * mm(20))).toBeCloseTo(1, 6); // total 20mm
      expect(centroidZ(oc, s.shape)).toBeCloseTo(0, 6); // symmetric about z=0
    } finally {
      s.shape.delete();
    }
  });

  it("direction override extrudes the other way (centroid below the plane)", () => {
    const s = extrude(oc, rect(), mm(10), { direction: [0, 0, -1] });
    try {
      expect(volume(oc, s.shape) / (area * mm(10))).toBeCloseTo(1, 6);
      expect(centroidZ(oc, s.shape)).toBeCloseTo(-mm(5), 6); // spans −10..0mm
    } finally {
      s.shape.delete();
    }
  });

  it("extrude-to-face pads up to a picked face's plane", () => {
    // A box on z = 0..40mm; its top face (normal +Z) is the target.
    const box = makeBox(oc, mm(20), mm(20), mm(40));
    try {
      const pad = extrudeToFace(oc, rect(), box, { normal: [0, 0, 1] });
      try {
        // The pad reaches the box top (z≈40mm) from z=0 → centroid ≈ 20mm.
        expect(centroidZ(oc, pad.shape)).toBeCloseTo(mm(20), 5);
        expect(volume(oc, pad.shape) / (area * mm(40))).toBeCloseTo(1, 5);
      } finally {
        pad.shape.delete();
      }
    } finally {
      box.shape.delete();
    }
  });

  it("extrude-to-face throws when the face can't be resolved", () => {
    const box = makeBox(oc, mm(20), mm(20), mm(20));
    try {
      // No face has this normal direction on an axis-aligned box.
      expect(() => extrudeToFace(oc, rect(), box, { normal: [0.3, 0.3, 0.9] })).toThrow(
        /could not be resolved/,
      );
    } finally {
      box.shape.delete();
    }
  });
});
