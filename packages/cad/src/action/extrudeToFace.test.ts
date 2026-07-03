// extrudeToFace — TRUE up-to-face termination against the real wasm. The pad's
// top must lie exactly ON the target face (perpendicular, angled, and curved
// targets, each with an analytically exact expected volume), and a face that
// cannot terminate the extrude must fail loudly instead of fabricating geometry.

import { beforeAll, describe, expect, it } from "vitest";

import { initOcct, type Occt } from "../oc/init.js";
import { mm } from "../unit/index.js";
import { planeXY, type DatumPlane } from "../env/plane.js";
import { Sketch } from "../sketch/sketch.js";
import { makeBox } from "../solid/primitives.js";
import { tessellateTagged } from "../mesh/tessellate.js";
import type { FaceRef } from "../mesh/tagged.js";
import type { Solid } from "../solid/solid.js";
import { extrude, extrudeToFace } from "./extrude.js";

let oc: Occt;

beforeAll(async () => {
  oc = await initOcct();
}, 120_000);

/** An axis-aligned rectangle profile on the world XY plane. */
function rectXY(x0: number, y0: number, x1: number, y1: number): Sketch {
  const sk = new Sketch(planeXY());
  sk.lineTo(x0, y0).lineTo(x1, y0).lineTo(x1, y1).lineTo(x0, y1);
  return sk;
}

/** A vertical sketch plane in the world XZ plane: (u,v) → (u, 0, v). */
function frontPlane(): DatumPlane {
  // yAxis = normal × xAxis = (0,−1,0) × (1,0,0) = (0,0,1), so v maps to +Z.
  return { origin: [0, 0, 0], normal: [0, -1, 0], xAxis: [1, 0, 0] };
}

/** The FaceRef (normal + centroid signature) of the first face group matching `pred`. */
function pickFace(base: Solid, pred: (normal: readonly [number, number, number]) => boolean): FaceRef {
  const group = tessellateTagged(oc, base).faceGroups.find((g) => pred(g.normal));
  expect(group).toBeDefined();
  return { normal: group!.normal, centroid: group!.centroid };
}

describe("extrudeToFace — true up-to-face termination", () => {
  it("perpendicular planar target: flat pad exactly to the face (existing semantics)", () => {
    const base = makeBox(oc, mm(60), mm(40), mm(30));
    const top = pickFace(base, (n) => Math.round(n[2]) === 1);
    const pad = extrudeToFace(oc, rectXY(0, 0, mm(20), mm(20)), base, top);
    // 20×20 pad from z=0 exactly up to the top face at z=30mm.
    expect(pad.volume()).toBeCloseTo(mm(20) * mm(20) * mm(30), 9);
    expect(pad.boundingBox().max[2]).toBeCloseTo(mm(30), 6);
    expect(pad.boundingBox().min[2]).toBeCloseTo(0, 6);
    expect(pad.isValid()).toBe(true);
    pad.delete();
    base.delete();
  });

  it("angled planar target: wedge-topped pad with the exact analytic volume", () => {
    // Base: a right-trapezoid profile on the vertical XZ plane extruded along +Y.
    // Its top face is the slanted plane z(x) = h2 − s·x with slope s = (h2−h1)/W,
    // outward normal ∝ (s, 0, 1) — NOT perpendicular to the +Z extrude direction.
    const W = mm(40);
    const h1 = mm(20);
    const h2 = mm(40);
    const D = mm(40);
    const s = (h2 - h1) / W; // 0.5
    const profile = new Sketch(frontPlane());
    profile.lineTo(0, 0).lineTo(W, 0).lineTo(W, h1).lineTo(0, h2);
    const base = extrude(oc, profile, D, { direction: [0, 1, 0] });

    const slant = pickFace(base, (n) => n[0] > 0.3 && n[2] > 0.5);
    // Pad footprint strictly inside the base footprint: x,y ∈ [10,30]mm.
    const x0 = mm(10);
    const x1 = mm(30);
    const pad = extrudeToFace(oc, rectXY(x0, mm(10), x1, mm(30)), base, slant);

    // Exact wedge-topped pad volume: Δy·∫[x0,x1] (h2 − s·x) dx.
    const expected = (mm(30) - mm(10)) * (h2 * (x1 - x0) - (s / 2) * (x1 * x1 - x0 * x0));
    expect(pad.volume()).toBeCloseTo(expected, 9);
    // The top conforms to the slant: highest point at x0 (z = h2 − s·x0), and the
    // flat-top centroid approximation (uniform z = h2 − s·20mm everywhere) would
    // put the bbox top 5mm lower — this asserts the top truly lies on the face.
    expect(pad.boundingBox().max[2]).toBeCloseTo(h2 - s * x0, 6);
    expect(pad.boundingBox().min[2]).toBeCloseTo(0, 6);
    expect(pad.isValid()).toBe(true);
    pad.delete();
    base.delete();
  });

  it("curved target: pad terminates ON a cylindrical face (volume + massprops conformity)", () => {
    // Base: a "D" profile (flat bottom, circular-arc top) on the vertical XZ
    // plane, extruded along +Y — its top face is a cylinder patch of radius
    // R = (h²+a²)/(2h) centred at z = c = (h²−a²)/(2h) (< 0), axis along Y.
    const a = mm(30);
    const h = mm(20);
    const D = mm(40);
    const c = (h * h - a * a) / (2 * h); // −12.5mm
    const R = (h * h + a * a) / (2 * h); // 32.5mm
    const profile = new Sketch(frontPlane());
    profile.lineTo(-a, 0).lineTo(a, 0).arcTo(0, h, -a, 0);
    const base = extrude(oc, profile, D, { direction: [0, 1, 0] });

    const arcTop = pickFace(base, (n) => n[2] > 0.5);
    // Pad footprint x ∈ [−b, b], y ∈ [10, 30]mm — fully under the arc face.
    const b = mm(10);
    const dy = mm(30) - mm(10);
    const pad = extrudeToFace(oc, rectXY(-b, mm(10), b, mm(30)), base, arcTop);

    // Exact volume under the cylinder top z(x) = c + √(R²−x²):
    //   V = Δy·∫[−b,b] z(x) dx = Δy·(2bc + b√(R²−b²) + R²·asin(b/R)).
    const cap = b * Math.sqrt(R * R - b * b) + R * R * Math.asin(b / R);
    const expected = dy * (2 * b * c + cap);
    expect(pad.volume()).toBeCloseTo(expected, 8);

    // Top-face conformity via mass properties. Centre of mass:
    //   V·z̄ = Δy·∫[−b,b] z(x)²/2 dx
    //        = Δy·(2b(c²+R²) − (2/3)b³ + 2c·(b√(R²−b²) + R²·asin(b/R)))/2.
    const zMoment = (dy * (2 * b * (c * c + R * R) - (2 / 3) * b ** 3 + 2 * c * cap)) / 2;
    const com = pad.centreOfMass();
    expect(com[0]).toBeCloseTo(0, 6);
    expect(com[1]).toBeCloseTo(mm(20), 6);
    expect(com[2]).toBeCloseTo(zMoment / expected, 6);
    // The pad's crest touches the cylinder's top generator z = c + R = h at x=0 —
    // a flat centroid-depth top could not reach it.
    expect(pad.boundingBox().max[2]).toBeCloseTo(h, 4);
    expect(pad.boundingBox().min[2]).toBeCloseTo(0, 6);
    expect(pad.isValid()).toBe(true);
    pad.delete();
    base.delete();
  });

  it("fails loudly on a target face parallel to the extrude direction", () => {
    // The +X side face of the box is parallel to the +Z extrude direction: no
    // material lies "up to" it, so it cannot terminate the extrude. The old
    // centroid approximation silently padded to the face centroid's projected
    // depth (mid-height) — fabricated geometry the new trim must reject.
    const base = makeBox(oc, mm(60), mm(40), mm(30));
    const side = pickFace(base, (n) => Math.round(n[0]) === 1);
    expect(() => extrudeToFace(oc, rectXY(0, 0, mm(20), mm(20)), base, side)).toThrow(
      /extrudeToFace/,
    );
    base.delete();
  });

  it("planar target extends past its boundary: a straddling profile pads to the plane (FR-29)", () => {
    // The profile hangs off the base footprint (x ∈ [10,50]mm over a 30mm-wide
    // box). Up-to-face against a PLANAR target terminates on the face's
    // (extended) plane, so the whole pad — including the overhang — reaches
    // z = 20mm exactly (this is the join-up-to-face semantics the app's FR-29
    // rebuild test relies on).
    const base = makeBox(oc, mm(30), mm(30), mm(20));
    const top = pickFace(base, (n) => Math.round(n[2]) === 1);
    const pad = extrudeToFace(oc, rectXY(mm(10), mm(10), mm(50), mm(25)), base, top);
    expect(pad.volume()).toBeCloseTo(mm(40) * mm(15) * mm(20), 9);
    expect(pad.boundingBox().max[2]).toBeCloseTo(mm(20), 6);
    expect(pad.isValid()).toBe(true);
    pad.delete();
    base.delete();
  });

  it("fails loudly when a CURVED target face covers the profile only partially", () => {
    // Same D-shaped base as the conformity test (arc top spanning x ∈ [−30,30]mm),
    // but the profile x ∈ [20,40]mm hangs past the arc's edge at x = 30mm. A
    // curved face cannot be extended past its boundary, so terminating only part
    // of the pad on it must fail loudly rather than fabricate the overhang.
    const a = mm(30);
    const h = mm(20);
    const profile = new Sketch(frontPlane());
    profile.lineTo(-a, 0).lineTo(a, 0).arcTo(0, h, -a, 0);
    const base = extrude(oc, profile, mm(40), { direction: [0, 1, 0] });
    const arcTop = pickFace(base, (n) => n[2] > 0.5);
    expect(() => extrudeToFace(oc, rectXY(mm(20), mm(10), mm(40), mm(30)), base, arcTop)).toThrow(
      /does not cover the whole profile/,
    );
    base.delete();
  });

  it("still rejects a target face lying on the sketch plane", () => {
    const base = makeBox(oc, mm(30), mm(30), mm(20));
    const bottom = pickFace(base, (n) => Math.round(n[2]) === -1);
    expect(() => extrudeToFace(oc, rectXY(0, 0, mm(10), mm(10)), base, bottom)).toThrow(
      /lies on the sketch plane/,
    );
    base.delete();
  });
});
