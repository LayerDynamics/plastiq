// The `hole` kernel op (§13.2) exercised against the real OCCT wasm: a real,
// fully-parameterized hole composed from primitives + boolean subtract. Volumes are
// asserted analytically (π·r² bores, counterbore annuli, countersink frusta, tip
// cones) — no mocks, no stubs.

import { beforeAll, describe, expect, it } from "vitest";

import { initOcct, type Occt } from "../oc/init.js";
import { mm } from "../unit/index.js";
import type { Vec3 } from "../math/index.js";
import { makeBox } from "../solid/primitives.js";
import { Solid } from "../solid/solid.js";
import { shapeEnums } from "../mesh/normals.js";
import { hole } from "./hole.js";

let oc: Occt;

beforeAll(async () => {
  oc = await initOcct();
}, 120_000);

// A 60×40×20 mm block, corner at the origin; the hole is drilled straight down
// through the centre of the top face.
const BOX_VOL = mm(60) * mm(40) * mm(20);
const TOP_CENTRE: Vec3 = [mm(30), mm(20), mm(20)];
const DOWN: Vec3 = [0, 0, -1];
const BORE_D = mm(10); // Ø10 → r = 5 mm
const BORE_R = mm(5);

function block(): Solid {
  return makeBox(oc, mm(60), mm(40), mm(20));
}

/** Number of faces in a solid — a counterbore/countersink adds mouth faces. */
function countFaces(solid: Solid): number {
  const S = shapeEnums(oc);
  const exp = new oc.TopExp_Explorer_2(solid.shape, S.TopAbs_FACE, S.TopAbs_SHAPE);
  let n = 0;
  try {
    while (exp.More()) {
      n++;
      exp.Next();
    }
  } finally {
    exp.delete();
  }
  return n;
}

describe("hole — bore", () => {
  it("cuts a simple through hole: box − π·r²·thickness", () => {
    const box = block();
    const drilled = hole(oc, box, {
      origin: TOP_CENTRE,
      axis: DOWN,
      diameter: BORE_D,
      throughAll: true,
      kind: "simple",
    });
    expect(drilled.isValid()).toBe(true);
    expect(drilled.volume()).toBeCloseTo(BOX_VOL - Math.PI * BORE_R ** 2 * mm(20), 9);
    drilled.delete();
    box.delete();
  });

  it("cuts a blind hole: box − π·r²·depth (flat bottom, inside the body)", () => {
    const box = block();
    const drilled = hole(oc, box, {
      origin: TOP_CENTRE,
      axis: DOWN,
      diameter: BORE_D,
      depth: mm(10),
      kind: "simple",
    });
    expect(drilled.isValid()).toBe(true);
    expect(drilled.volume()).toBeCloseTo(BOX_VOL - Math.PI * BORE_R ** 2 * mm(10), 9);
    // Blind: material remains below the bottom, so the removed volume is strictly
    // less than the full through-bore would remove.
    expect(drilled.volume()).toBeGreaterThan(BOX_VOL - Math.PI * BORE_R ** 2 * mm(20));
    drilled.delete();
    box.delete();
  });

  it("a drill-point tipAngle removes an extra cone at the blind bottom", () => {
    const box = block();
    const flat = hole(oc, box, {
      origin: TOP_CENTRE,
      axis: DOWN,
      diameter: BORE_D,
      depth: mm(10),
      kind: "simple",
    });
    const tipAngle = (118 * Math.PI) / 180; // a real twist-drill point
    const tipped = hole(oc, box, {
      origin: TOP_CENTRE,
      axis: DOWN,
      diameter: BORE_D,
      depth: mm(10),
      kind: "simple",
      tipAngle,
    });
    const tipHeight = BORE_R / Math.tan(tipAngle / 2);
    const coneVol = (Math.PI * BORE_R ** 2 * tipHeight) / 3;
    expect(tipped.isValid()).toBe(true);
    // The tip removes exactly the extra cone volume beyond the flat bottom.
    expect(tipped.volume()).toBeCloseTo(flat.volume() - coneVol, 9);
    expect(tipped.volume()).toBeLessThan(flat.volume());
    tipped.delete();
    flat.delete();
    box.delete();
  });
});

describe("hole — counterbore / spotface", () => {
  it("counterbore removes the bore plus the mouth annulus, and adds mouth faces", () => {
    const box = block();
    const simple = hole(oc, box, {
      origin: TOP_CENTRE,
      axis: DOWN,
      diameter: BORE_D,
      throughAll: true,
      kind: "simple",
    });
    const cbored = hole(oc, box, {
      origin: TOP_CENTRE,
      axis: DOWN,
      diameter: BORE_D,
      throughAll: true,
      kind: "counterbore",
      counterboreDiameter: mm(20), // Ø20 → R = 10 mm
      counterboreDepth: mm(5),
    });
    expect(cbored.isValid()).toBe(true);

    const bore = Math.PI * BORE_R ** 2 * mm(20);
    // annulus = π · depth · (R_cb² − r²)
    const annulus = Math.PI * mm(5) * (mm(10) ** 2 - BORE_R ** 2);
    expect(cbored.volume()).toBeCloseTo(BOX_VOL - (bore + annulus), 9);

    // A counterbore removes MORE than the simple bore, and its mouth (the larger
    // cylinder wall + the flat shoulder) is present as extra faces.
    expect(cbored.volume()).toBeLessThan(simple.volume());
    expect(countFaces(cbored)).toBeGreaterThan(countFaces(simple));

    cbored.delete();
    simple.delete();
    box.delete();
  });

  it("spotface is a shallow flat counterbore (same geometry, small depth)", () => {
    const box = block();
    const spot = hole(oc, box, {
      origin: TOP_CENTRE,
      axis: DOWN,
      diameter: BORE_D,
      throughAll: true,
      kind: "spotface",
      counterboreDiameter: mm(20),
      counterboreDepth: mm(1), // shallow flat seat
    });
    expect(spot.isValid()).toBe(true);
    const bore = Math.PI * BORE_R ** 2 * mm(20);
    const annulus = Math.PI * mm(1) * (mm(10) ** 2 - BORE_R ** 2);
    expect(spot.volume()).toBeCloseTo(BOX_VOL - (bore + annulus), 9);
    spot.delete();
    box.delete();
  });
});

describe("hole — countersink", () => {
  it("removes a conical frustum at the mouth then the straight bore below", () => {
    const box = block();
    const simple = hole(oc, box, {
      origin: TOP_CENTRE,
      axis: DOWN,
      diameter: BORE_D,
      throughAll: true,
      kind: "simple",
    });
    const csunk = hole(oc, box, {
      origin: TOP_CENTRE,
      axis: DOWN,
      diameter: BORE_D,
      throughAll: true,
      kind: "countersink",
      countersinkDiameter: mm(20), // Ø20 → R_cs = 10 mm at the face
      countersinkAngle: Math.PI / 2, // 90° included → 45° half-angle
    });
    expect(csunk.isValid()).toBe(true);

    const rCs = mm(10);
    const tanHalf = Math.tan(Math.PI / 4); // == 1
    const delta = (rCs - BORE_R) / tanHalf; // 5 mm below the face the cone meets the bore
    // Frustum (face → delta): (π·delta/3)(R² + R·r + r²); straight bore below it.
    const frustum = ((Math.PI * delta) / 3) * (rCs ** 2 + rCs * BORE_R + BORE_R ** 2);
    const boreBelow = Math.PI * BORE_R ** 2 * (mm(20) - delta);
    expect(csunk.volume()).toBeCloseTo(BOX_VOL - (frustum + boreBelow), 9);

    // The countersink cone removes more than the straight bore in the mouth region.
    expect(csunk.volume()).toBeLessThan(simple.volume());
    expect(countFaces(csunk)).toBeGreaterThan(countFaces(simple));

    csunk.delete();
    simple.delete();
    box.delete();
  });
});

describe("hole — validation (NAMED errors, before OCCT)", () => {
  it("rejects a zero or negative diameter", () => {
    const box = block();
    expect(() =>
      hole(oc, box, { origin: TOP_CENTRE, axis: DOWN, diameter: 0, throughAll: true, kind: "simple" }),
    ).toThrow(/diameter/);
    expect(() =>
      hole(oc, box, { origin: TOP_CENTRE, axis: DOWN, diameter: mm(-5), throughAll: true, kind: "simple" }),
    ).toThrow(/diameter/);
    box.delete();
  });

  it("rejects zero depth when not throughAll", () => {
    const box = block();
    expect(() =>
      hole(oc, box, { origin: TOP_CENTRE, axis: DOWN, diameter: BORE_D, depth: 0, kind: "simple" }),
    ).toThrow(/depth/);
    // Missing depth AND no throughAll is the same failure.
    expect(() =>
      hole(oc, box, { origin: TOP_CENTRE, axis: DOWN, diameter: BORE_D, kind: "simple" }),
    ).toThrow(/depth/);
    box.delete();
  });

  it("rejects a non-unit axis", () => {
    const box = block();
    expect(() =>
      hole(oc, box, { origin: TOP_CENTRE, axis: [0, 0, 2], diameter: BORE_D, throughAll: true, kind: "simple" }),
    ).toThrow(/unit/);
    // A zero axis is non-unit too.
    expect(() =>
      hole(oc, box, { origin: TOP_CENTRE, axis: [0, 0, 0], diameter: BORE_D, throughAll: true, kind: "simple" }),
    ).toThrow(/unit/);
    box.delete();
  });

  it("rejects a counterbore diameter that does not exceed the bore", () => {
    const box = block();
    expect(() =>
      hole(oc, box, {
        origin: TOP_CENTRE,
        axis: DOWN,
        diameter: BORE_D,
        throughAll: true,
        kind: "counterbore",
        counterboreDiameter: BORE_D, // not larger
        counterboreDepth: mm(5),
      }),
    ).toThrow(/counterboreDiameter/);
    box.delete();
  });
});
