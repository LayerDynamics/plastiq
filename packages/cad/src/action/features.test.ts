// R4 (chunk 1) — sketch profiles, extrude, revolve, booleans, transforms,
// exercised against the real OCCT wasm.

import { beforeAll, describe, expect, it } from "vitest";

import { initOcct, type Occt } from "../oc/init.js";
import { mm } from "../unit/index.js";
import { makeBox, makeBoxAt } from "../solid/primitives.js";
import { planeXY, planeXZ } from "../env/plane.js";
import { Sketch } from "../sketch/sketch.js";
import { cut, extrude, intersect, mirror, revolve, rotate, subtract, translate, union } from "./index.js";

let oc: Occt;

beforeAll(async () => {
  oc = await initOcct();
}, 120_000);

function rect(u0: number, v0: number, u1: number, v1: number): Sketch {
  const sk = new Sketch(planeXY());
  sk.lineTo(u0, v0);
  sk.lineTo(u1, v0);
  sk.lineTo(u1, v1);
  sk.lineTo(u0, v1);
  return sk; // auto-closes back to (u0,v0)
}

describe("extrude", () => {
  it("extrudes a rectangle profile into a box of the expected volume", () => {
    const solid = extrude(oc, rect(0, 0, mm(60), mm(40)), mm(30));
    expect(solid.volume()).toBeCloseTo(7.2e-5, 9);
    solid.delete();
  });

  it("extrudes a circle profile into a cylinder (π·r²·h)", () => {
    const solid = extrude(oc, Sketch.circle(planeXY(), 0, 0, mm(20)), mm(50));
    expect(solid.volume()).toBeCloseTo(Math.PI * mm(20) * mm(20) * mm(50), 9);
    solid.delete();
  });

  it("two-sided extrude (back) doubles a symmetric pad height", () => {
    const oneSided = extrude(oc, rect(0, 0, mm(10), mm(10)), mm(20));
    const twoSided = extrude(oc, rect(0, 0, mm(10), mm(10)), mm(20), { back: mm(20) });
    expect(twoSided.volume()).toBeCloseTo(oneSided.volume() * 2, 9);
    oneSided.delete();
    twoSided.delete();
  });
});

describe("revolve", () => {
  it("revolves a rectangle into an annulus (Pappus volume)", () => {
    // Profile on XZ plane: x∈[10,20]mm, depth 30mm; revolved full turn about Z.
    const sk = new Sketch(planeXZ());
    sk.lineTo(mm(10), 0);
    sk.lineTo(mm(20), 0);
    sk.lineTo(mm(20), mm(30));
    sk.lineTo(mm(10), mm(30));
    const solid = revolve(oc, sk, [0, 0, 0], [0, 0, 1], Math.PI * 2);
    // π·(r1²−r0²)·h = π·(0.02²−0.01²)·0.03
    expect(solid.volume()).toBeCloseTo(Math.PI * (mm(20) ** 2 - mm(10) ** 2) * mm(30), 9);
    solid.delete();
  });
});

describe("booleans", () => {
  function pair(): { a: ReturnType<typeof makeBox>; b: ReturnType<typeof makeBox> } {
    return {
      a: makeBox(oc, mm(60), mm(40), mm(30)),
      b: makeBoxAt(oc, [mm(30), 0, 0], mm(60), mm(40), mm(30)),
    };
  }
  const whole = 7.2e-5;
  const overlap = mm(30) * mm(40) * mm(30); // 3.6e-5

  it("union = A + B − overlap", () => {
    const { a, b } = pair();
    const r = union(oc, a, b);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.solid.volume()).toBeCloseTo(2 * whole - overlap, 9);
      r.solid.delete();
    }
    a.delete();
    b.delete();
  });

  it("subtract = A − overlap, and cut matches", () => {
    const { a, b } = pair();
    const r = subtract(oc, a, b);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.solid.volume()).toBeCloseTo(whole - overlap, 9);
      r.solid.delete();
    }
    const c = cut(oc, a, b);
    expect(c.volume()).toBeCloseTo(whole - overlap, 9);
    c.delete();
    a.delete();
    b.delete();
  });

  it("intersect = overlap", () => {
    const { a, b } = pair();
    const r = intersect(oc, a, b);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.solid.volume()).toBeCloseTo(overlap, 9);
      r.solid.delete();
    }
    a.delete();
    b.delete();
  });
});

describe("transforms preserve volume", () => {
  it("translate shifts the bounding box but keeps volume", () => {
    const box = makeBox(oc, mm(20), mm(20), mm(20));
    const moved = translate(oc, box, [mm(50), 0, 0]);
    expect(moved.volume()).toBeCloseTo(box.volume(), 12);
    expect(moved.boundingBox().min[0]).toBeCloseTo(mm(50), 6);
    box.delete();
    moved.delete();
  });

  it("rotate and mirror preserve volume", () => {
    const box = makeBox(oc, mm(20), mm(30), mm(40));
    const rotated = rotate(oc, box, [0, 0, 0], [0, 0, 1], Math.PI / 4);
    const mirrored = mirror(oc, box, [0, 0, 0], [1, 0, 0]);
    expect(rotated.volume()).toBeCloseTo(box.volume(), 12);
    expect(mirrored.volume()).toBeCloseTo(box.volume(), 12);
    box.delete();
    rotated.delete();
    mirrored.delete();
  });
});
