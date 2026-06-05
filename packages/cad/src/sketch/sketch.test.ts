import type { TopoDS_Face, TopoDS_Shape } from "opencascade.js";
import { beforeAll, describe, expect, it } from "vitest";
import { extrude } from "../action/extrude.js";
import { offsetPlane, planeXY } from "../environment/plane.js";
import { initOcct, type Occt } from "../oc/init.js";
import { mm } from "../unit/index.js";
import { Sketch } from "./sketch.js";

const INIT_TIMEOUT_MS = 120_000;

/** Planar area of an OCCT face via surface mass properties. */
function faceArea(oc: Occt, face: TopoDS_Face): number {
  const props = new oc.GProp_GProps_1();
  try {
    oc.BRepGProp.SurfaceProperties_1(face, props, false, false);
    return props.Mass();
  } finally {
    props.delete();
  }
}

/** Solid volume of an OCCT shape via volume mass properties. */
function shapeVolume(oc: Occt, shape: TopoDS_Shape): number {
  const props = new oc.GProp_GProps_1();
  try {
    oc.BRepGProp.VolumeProperties_1(shape, props, false, false, false);
    return props.Mass();
  } finally {
    props.delete();
  }
}

describe("Sketch profiles → planar face (FR-2)", () => {
  let oc: Occt;
  beforeAll(async () => {
    oc = await initOcct();
  }, INIT_TIMEOUT_MS);

  it("a rectangle profile has 4 vertices", () => {
    expect(Sketch.rectangle(planeXY(), mm(20), mm(30)).vertexCount).toBe(4);
  });

  it("builds a valid planar face whose area = width × height", () => {
    const w = mm(20);
    const h = mm(30);
    const face = Sketch.rectangle(planeXY(), w, h).toFace(oc);
    try {
      const analyzer = new oc.BRepCheck_Analyzer(face, true, false);
      try {
        expect(analyzer.IsValid_2()).toBe(true);
      } finally {
        analyzer.delete();
      }
      expect(Math.abs(faceArea(oc, face) - w * h) / (w * h)).toBeLessThan(1e-9);
    } finally {
      face.delete();
    }
  });

  it("builds the profile on an offset plane (placed in 3D)", () => {
    const face = Sketch.rectangle(offsetPlane(planeXY(), mm(50)), mm(10), mm(10)).toFace(oc);
    try {
      const analyzer = new oc.BRepCheck_Analyzer(face, true, false);
      try {
        expect(analyzer.IsValid_2()).toBe(true);
      } finally {
        analyzer.delete();
      }
    } finally {
      face.delete();
    }
  });

  it("a regular hexagon area = (3√3/2) r²", () => {
    const r = mm(10);
    const face = Sketch.regularPolygon(planeXY(), 6, r).toFace(oc);
    try {
      const expected = ((3 * Math.sqrt(3)) / 2) * r * r;
      expect(Math.abs(faceArea(oc, face) - expected) / expected).toBeLessThan(1e-9);
    } finally {
      face.delete();
    }
  });

  it("a full-circle profile faces to area = π r² (FR-16 true curved edge)", () => {
    const r = mm(10);
    const face = Sketch.circle(planeXY(), 0, 0, r).toFace(oc);
    try {
      const analyzer = new oc.BRepCheck_Analyzer(face, true, false);
      try {
        expect(analyzer.IsValid_2()).toBe(true);
      } finally {
        analyzer.delete();
      }
      const expected = Math.PI * r * r;
      expect(Math.abs(faceArea(oc, face) - expected) / expected).toBeLessThan(1e-6);
    } finally {
      face.delete();
    }
  });

  it("extrudes a circle into a true cylinder (volume = π r² h, not a facet poly)", () => {
    const r = mm(8);
    const h = mm(15);
    // A faceted N-gon profile would undershoot π r² h by ~1%; a true curved edge
    // hits it to 1e-6 — this is the proof the profile is a real arc, not chords.
    const solid = extrude(oc, Sketch.circle(planeXY(), 0, 0, r), h);
    try {
      const expected = Math.PI * r * r * h;
      expect(Math.abs(shapeVolume(oc, solid.shape) - expected) / expected).toBeLessThan(1e-6);
    } finally {
      solid.shape.delete();
    }
  });

  it("a half-disc (diameter line + semicircular arc) has area = π r² / 2", () => {
    const r = mm(12);
    // start (−r,0) → arc through the top (0,r) to (r,0); the loop auto-closes
    // along the diameter (r,0)→(−r,0).
    const face = new Sketch(planeXY()).lineTo(-r, 0).arcTo(0, r, r, 0).toFace(oc);
    try {
      const analyzer = new oc.BRepCheck_Analyzer(face, true, false);
      try {
        expect(analyzer.IsValid_2()).toBe(true);
      } finally {
        analyzer.delete();
      }
      const expected = (Math.PI * r * r) / 2;
      expect(Math.abs(faceArea(oc, face) - expected) / expected).toBeLessThan(1e-6);
    } finally {
      face.delete();
    }
  });

  it("a spline-sided profile builds a valid face with positive area", () => {
    const r = mm(10);
    // start bottom-left, a spline bowing across the top, closing along the base.
    const face = new Sketch(planeXY())
      .lineTo(-r, 0)
      .lineTo(r, 0)
      .splineTo([
        [r, r],
        [0, 1.4 * r],
        [-r, r],
        [-r, 0],
      ])
      .toFace(oc);
    try {
      const analyzer = new oc.BRepCheck_Analyzer(face, true, false);
      try {
        expect(analyzer.IsValid_2()).toBe(true);
      } finally {
        analyzer.delete();
      }
      expect(faceArea(oc, face)).toBeGreaterThan(0);
    } finally {
      face.delete();
    }
  });

  it("circle() rejects a non-positive radius", () => {
    expect(() => Sketch.circle(planeXY(), 0, 0, 0)).toThrow(/radius/);
  });

  it("throws on a degenerate profile (< 3 points)", () => {
    expect(() => new Sketch(planeXY()).lineTo(0, 0).toFace(oc)).toThrow(/≥ 3 points/);
  });
});
