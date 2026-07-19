// §13.8 P0 — where a new sketch lands when the user did not pick a face.
//
// The starter box occupies z = 0…30, so the XY plane at offset 0 is its BOTTOM
// face: drawing there and extruding up went straight into material and looked
// like nothing happened. A sketch started on a datum must land on the surface
// you can actually see from that datum's side.

import { describe, expect, it } from "vitest";
import type { FaceRef } from "@plastiq/cad";
import { defaultSketchFace, startingSketchModel } from "./defaultPlane.js";

/** The six faces of a 60×40×30 box at the origin, as the build publishes them. */
const BOX_FACES: Record<number, FaceRef> = {
  1: { normal: [0, 0, 1], centroid: [0.03, 0.02, 0.03] }, // top    (+Z)
  2: { normal: [0, 0, -1], centroid: [0.03, 0.02, 0] }, // bottom (−Z)
  3: { normal: [0, 1, 0], centroid: [0.03, 0.04, 0.015] }, // back   (+Y)
  4: { normal: [0, -1, 0], centroid: [0.03, 0, 0.015] }, // front  (−Y)
  5: { normal: [1, 0, 0], centroid: [0.06, 0.02, 0.015] }, // right  (+X)
  6: { normal: [-1, 0, 0], centroid: [0, 0.02, 0.015] }, // left   (−X)
};

describe("defaultSketchFace", () => {
  it("picks the TOP face for XY — not the bottom one buried under the body", () => {
    const face = defaultSketchFace("XY", BOX_FACES)!;
    expect(face.normal).toEqual([0, 0, 1]);
    expect(face.centroid![2]).toBeCloseTo(0.03, 9); // the box's top, z = 30 mm
  });

  it("picks the face facing each datum's own normal", () => {
    expect(defaultSketchFace("XZ", BOX_FACES)!.normal).toEqual([0, 1, 0]);
    expect(defaultSketchFace("YZ", BOX_FACES)!.normal).toEqual([1, 0, 0]);
  });

  it("picks the OUTERMOST candidate when several face the same way", () => {
    // Two stacked bodies: the sketch belongs on the higher top face.
    const stacked: Record<number, FaceRef> = {
      ...BOX_FACES,
      7: { normal: [0, 0, 1], centroid: [0.03, 0.02, 0.05] }, // a taller body's top
    };
    expect(defaultSketchFace("XY", stacked)!.centroid![2]).toBeCloseTo(0.05, 9);
  });

  it("returns null when nothing faces that way (draw on the bare datum)", () => {
    expect(defaultSketchFace("XY", {})).toBeNull();
    // Only side walls present → no +Z candidate.
    expect(defaultSketchFace("XY", { 5: BOX_FACES[5]!, 6: BOX_FACES[6]! })).toBeNull();
  });

  it("skips refs with no centroid — an unplaceable face cannot be shown outermost", () => {
    expect(defaultSketchFace("XY", { 1: { normal: [0, 0, 1] } })).toBeNull();
  });
});

describe("startingSketchModel", () => {
  it("lands on the model's top face when no offset is given", () => {
    const model = startingSketchModel("XY", BOX_FACES);
    expect(model.face).toBeDefined();
    expect(model.face!.centroid![2]).toBeCloseTo(0.03, 9);
    expect(model.plane).toBe("XY"); // the requested orientation is preserved
  });

  it("an EXPLICIT offset is honoured against the bare datum, never re-based", () => {
    const model = startingSketchModel("XY", BOX_FACES, 0.05);
    expect(model.face).toBeUndefined(); // exactly 50 mm above XY, as typed
    expect(model.offset).toBeCloseTo(0.05, 9);
  });

  it("an empty document keeps the plain datum sketch", () => {
    const model = startingSketchModel("XY", {});
    expect(model.face).toBeUndefined();
    expect(model.plane).toBe("XY");
    expect(model.offset).toBe(0);
  });
});
