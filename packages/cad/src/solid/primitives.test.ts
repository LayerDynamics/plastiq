// R2 geometry core — exercised against the REAL OCCT wasm (no mocks). Runs in
// the Node vitest environment via opencascade.js/dist/node.js.

import { beforeAll, describe, expect, it } from "vitest";

import { initOcct, type Occt } from "../oc/init.js";
import { mm } from "../unit/index.js";
import { tessellateTagged } from "../mesh/tessellate.js";
import { subtract } from "../action/boolean.js";
import type { SurfaceSignature } from "../mesh/surface.js";
import type { Solid } from "./solid.js";
import { makeBox, makeBoxAt, makeCone, makeCylinder, makeSphere, makeTorus } from "./primitives.js";

let oc: Occt;

beforeAll(async () => {
  oc = await initOcct();
}, 120_000);

describe("makeBox", () => {
  it("builds a box whose volume is dx·dy·dz", () => {
    const box = makeBox(oc, mm(60), mm(40), mm(30));
    // 0.06 × 0.04 × 0.03 = 7.2e-5 m³
    expect(box.volume()).toBeCloseTo(7.2e-5, 10);
    box.delete();
  });

  it("reports an axis-aligned bounding box from the origin", () => {
    const box = makeBox(oc, mm(10), mm(20), mm(30));
    const bb = box.boundingBox();
    // OCCT's Bnd_Box stores a slightly enlarged box (a ~1e-7 m gap), so corner
    // positions carry that tolerance — assert to the micron (precision 6).
    expect(bb.min[0]).toBeCloseTo(0, 6);
    expect(bb.min[1]).toBeCloseTo(0, 6);
    expect(bb.min[2]).toBeCloseTo(0, 6);
    expect(bb.max[0]).toBeCloseTo(mm(10), 6);
    expect(bb.max[1]).toBeCloseTo(mm(20), 6);
    expect(bb.max[2]).toBeCloseTo(mm(30), 6);
    box.delete();
  });

  it("centres a unit box's mass at its geometric centre", () => {
    const box = makeBox(oc, mm(10), mm(10), mm(10));
    const c = box.centreOfMass();
    expect(c[0]).toBeCloseTo(mm(5), 9);
    expect(c[1]).toBeCloseTo(mm(5), 9);
    expect(c[2]).toBeCloseTo(mm(5), 9);
    box.delete();
  });
});

describe("makeBoxAt", () => {
  it("offsets the box so its min corner sits at the given point", () => {
    const box = makeBoxAt(oc, [mm(5), mm(10), mm(15)], mm(10), mm(10), mm(10));
    const bb = box.boundingBox();
    expect(bb.min[0]).toBeCloseTo(mm(5), 6);
    expect(bb.min[1]).toBeCloseTo(mm(10), 6);
    expect(bb.min[2]).toBeCloseTo(mm(15), 6);
    expect(bb.max[0]).toBeCloseTo(mm(15), 6);
    expect(box.volume()).toBeCloseTo(1e-6, 12);
    box.delete();
  });
});

describe("Solid.copy", () => {
  it("produces an independent duplicate with the same volume", () => {
    const box = makeBox(oc, mm(20), mm(20), mm(20));
    const dup = box.copy();
    expect(dup.volume()).toBeCloseTo(box.volume(), 12);
    box.delete();
    // dup is still valid after the original is freed
    expect(dup.volume()).toBeCloseTo(8e-6, 12);
    dup.delete();
  });
});

describe("Solid.delete", () => {
  it("is idempotent: a second delete() is a no-op, not a double-free throw", () => {
    const box = makeBox(oc, mm(10), mm(10), mm(10));
    box.delete();
    // A bare this.shape.delete() on the second call would throw an emscripten
    // 'already deleted' BindingError; the disposed guard makes it a safe no-op.
    expect(() => box.delete()).not.toThrow();
  });
});

// --- Round primitives (§4.11) ------------------------------------------------
//
// Box used to be the ONLY primitive, which made the sketcher a single point of
// failure for all round geometry: a cylinder could only be had by extruding a
// circle sketch, so every defect in the sketch/profile path took round solids
// with it. Beyond exact volumes, these assert each primitive's curved face
// reports the EXACT analytic surface a §2.1 FaceRef re-resolves it by.

/** The analytic surface signature of every face of `solid`. */
function surfaceKinds(solid: Solid): SurfaceSignature[] {
  return tessellateTagged(oc, solid, { angularDeflection: 0.1 }).faceGroups.map((g) => g.surface);
}

describe("makeCylinder", () => {
  it("has the exact analytic volume and ONE cylindrical wall between two planar caps", () => {
    const c = makeCylinder(oc, mm(10), mm(20));
    expect(c.volume()).toBeCloseTo(Math.PI * mm(10) ** 2 * mm(20), 12);
    expect(c.isValid()).toBe(true);

    const kinds = surfaceKinds(c);
    const walls = kinds.filter((s) => s.kind === "cylinder");
    expect(walls, "a cylinder has one curved wall").toHaveLength(1);
    const wall = walls[0] as Extract<SurfaceSignature, { kind: "cylinder" }>;
    expect(wall.radius).toBeCloseTo(mm(10), 12);
    expect(Math.abs(wall.axis[2])).toBeCloseTo(1, 12);
    expect(kinds.filter((s) => s.kind === "plane")).toHaveLength(2);

    c.delete();
  });

  it("honours origin and axis placement", () => {
    // Lying along +X from x=5mm: bbox spans x∈[5,25] and the wall's axis is X.
    const c = makeCylinder(oc, mm(10), mm(20), { origin: [mm(5), 0, 0], axis: [1, 0, 0] });
    const bb = c.boundingBox();
    expect(bb.min[0]).toBeCloseTo(mm(5), 6);
    expect(bb.max[0]).toBeCloseTo(mm(25), 6);
    expect(c.volume()).toBeCloseTo(Math.PI * mm(10) ** 2 * mm(20), 12);

    const wall = surfaceKinds(c).find((s) => s.kind === "cylinder") as Extract<
      SurfaceSignature,
      { kind: "cylinder" }
    >;
    expect(Math.abs(wall.axis[0])).toBeCloseTo(1, 12);

    c.delete();
  });

  it("a half-angle cylinder is exactly half the full volume", () => {
    const half = makeCylinder(oc, mm(10), mm(20), { angle: Math.PI });
    expect(half.volume()).toBeCloseTo((Math.PI * mm(10) ** 2 * mm(20)) / 2, 12);
    half.delete();
  });

  it("rejects degenerate inputs instead of building a bad solid", () => {
    expect(() => makeCylinder(oc, 0, mm(20))).toThrow(/radius/);
    expect(() => makeCylinder(oc, mm(10), 0)).toThrow(/height/);
    expect(() => makeCylinder(oc, mm(10), mm(20), { axis: [0, 0, 0] })).toThrow(/non-zero/);
  });
});

describe("makeSphere", () => {
  it("has the exact analytic volume and a single spherical face", () => {
    const s = makeSphere(oc, mm(10));
    expect(s.volume()).toBeCloseTo((4 / 3) * Math.PI * mm(10) ** 3, 12);
    expect(s.isValid()).toBe(true);

    const spheres = surfaceKinds(s).filter((k) => k.kind === "sphere");
    expect(spheres).toHaveLength(1);
    const sig = spheres[0] as Extract<SurfaceSignature, { kind: "sphere" }>;
    expect(sig.radius).toBeCloseTo(mm(10), 12);

    s.delete();
  });

  it("centres on the placement origin (pins the gp_Ax2 overload, not the gp_Pnt one)", () => {
    const s = makeSphere(oc, mm(10), { origin: [mm(30), mm(20), mm(10)] });
    const sig = surfaceKinds(s).find((k) => k.kind === "sphere") as Extract<
      SurfaceSignature,
      { kind: "sphere" }
    >;
    expect(sig.centre[0]).toBeCloseTo(mm(30), 9);
    expect(sig.centre[1]).toBeCloseTo(mm(20), 9);
    expect(sig.centre[2]).toBeCloseTo(mm(10), 9);
    s.delete();
  });
});

describe("makeCone", () => {
  it("a truncated cone has the exact frustum volume and a conical face", () => {
    // V = (π h / 3)(r1² + r1·r2 + r2²)
    const [r1, r2, h] = [mm(10), mm(5), mm(20)];
    const c = makeCone(oc, r1, r2, h);
    expect(c.volume()).toBeCloseTo(((Math.PI * h) / 3) * (r1 * r1 + r1 * r2 + r2 * r2), 12);
    expect(c.isValid()).toBe(true);
    expect(surfaceKinds(c).filter((k) => k.kind === "cone")).toHaveLength(1);
    c.delete();
  });

  it("a point-tipped cone (r2=0) has the exact cone volume", () => {
    const c = makeCone(oc, mm(10), 0, mm(20));
    expect(c.volume()).toBeCloseTo((Math.PI * mm(10) ** 2 * mm(20)) / 3, 12);
    c.delete();
  });

  it("rejects equal radii (that is a cylinder) and all-zero radii", () => {
    expect(() => makeCone(oc, mm(10), mm(10), mm(20))).toThrow(/cylinder/);
    expect(() => makeCone(oc, 0, 0, mm(20))).toThrow(/at least one radius/);
  });
});

describe("makeTorus", () => {
  it("has the exact Pappus volume and a toroidal face", () => {
    // V = 2π² R r²
    const [R, r] = [mm(20), mm(5)];
    const t = makeTorus(oc, R, r);
    expect(t.volume()).toBeCloseTo(2 * Math.PI ** 2 * R * r * r, 12);
    expect(t.isValid()).toBe(true);

    const tori = surfaceKinds(t).filter((k) => k.kind === "torus");
    expect(tori).toHaveLength(1);
    const sig = tori[0] as Extract<SurfaceSignature, { kind: "torus" }>;
    expect(sig.majorRadius).toBeCloseTo(R, 12);
    expect(sig.minorRadius).toBeCloseTo(r, 12);

    t.delete();
  });

  it("rejects a self-intersecting torus rather than building an invalid solid", () => {
    expect(() => makeTorus(oc, mm(5), mm(5))).toThrow(/self-intersect/);
    expect(() => makeTorus(oc, mm(5), mm(10))).toThrow(/self-intersect/);
    expect(() => makeTorus(oc, mm(20), 0)).toThrow(/> 0/);
  });
});

describe("round primitives compose with the rest of the kernel", () => {
  it("bores a block with a primitive cylinder — round geometry with NO sketcher", () => {
    // The §4.11 point: round solids no longer depend on the sketch path at all.
    const block = makeBox(oc, mm(40), mm(40), mm(20));
    const bore = makeCylinder(oc, mm(8), mm(60), { origin: [mm(20), mm(20), -mm(20)] });
    const r = subtract(oc, block, bore);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.solid.volume()).toBeCloseTo(
      mm(40) * mm(40) * mm(20) - Math.PI * mm(8) ** 2 * mm(20),
      10,
    );
    expect(r.lumps).toBe(1);
    // The bore wall is ONE analytic cylinder, so a FaceRef can re-resolve it.
    const walls = surfaceKinds(r.solid).filter((k) => k.kind === "cylinder");
    expect(walls).toHaveLength(1);
    expect((walls[0] as Extract<SurfaceSignature, { kind: "cylinder" }>).radius).toBeCloseTo(
      mm(8),
      9,
    );

    r.solid.delete();
    bore.delete();
    block.delete();
  });
});
