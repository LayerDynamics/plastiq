import { beforeAll, describe, expect, it } from "vitest";
import { planeXY } from "../environment/plane.js";
import { massProperties } from "../lower/massprops.js";
import { Model } from "../model/model.js";
import { initOcct, type Occt } from "../oc/init.js";
import { makeBox } from "../solid/primitives.js";
import type { Solid } from "../solid/solid.js";
import { Sketch } from "../sketch/sketch.js";
import { mm } from "../unit/index.js";
import { cut, extrude, pocket, revolve } from "./index.js";

const INIT_TIMEOUT_MS = 120_000;

function volume(oc: Occt, s: Solid): number {
  return massProperties(oc, s, 1).volume;
}
function rel(a: number, b: number): number {
  return Math.abs(a - b) / Math.abs(b);
}

describe("feature operations (FR-4/FR-5/FR-6)", () => {
  let oc: Occt;
  beforeAll(async () => {
    oc = await initOcct();
  }, INIT_TIMEOUT_MS);

  it("extrude: rectangle × depth → box volume", () => {
    const s = extrude(oc, Sketch.rectangle(planeXY(), mm(20), mm(30)), mm(10));
    try {
      expect(s.isValid()).toBe(true);
      expect(rel(volume(oc, s), 0.02 * 0.03 * 0.01)).toBeLessThan(1e-9);
    } finally {
      s.delete();
    }
  });

  it("revolve: profile touching the axis, 2π → cylinder volume πR²H", () => {
    const R = mm(10);
    const H = mm(20);
    // Profile in XY touching the Y axis (u=0 edge): (0,0)→(R,0)→(R,H)→(0,H).
    const profile = new Sketch(planeXY()).lineTo(0, 0).lineTo(R, 0).lineTo(R, H).lineTo(0, H);
    const s = revolve(oc, profile, [0, 0, 0], [0, 1, 0], 2 * Math.PI);
    try {
      expect(s.isValid()).toBe(true);
      expect(rel(volume(oc, s), Math.PI * R * R * H)).toBeLessThan(1e-6);
    } finally {
      s.delete();
    }
  });

  it("cut: box − overlapping tool → difference volume", () => {
    const target = makeBox(oc, mm(20), mm(20), mm(20)); // 8e-6
    const tool = makeBox(oc, mm(10), mm(10), mm(40)); // overlaps the corner column
    try {
      const result = cut(oc, target, tool);
      try {
        expect(result.isValid()).toBe(true);
        // overlap = 0.01 × 0.01 × 0.02 = 2e-6 → 8e-6 − 2e-6 = 6e-6
        expect(rel(volume(oc, result), 6e-6)).toBeLessThan(1e-9);
      } finally {
        result.delete();
      }
    } finally {
      target.delete();
      tool.delete();
    }
  });

  it("pocket: a sketch-driven cut through a box", () => {
    const target = makeBox(oc, mm(20), mm(20), mm(20)); // 8e-6
    // Profile in the box corner (0..0.01)×(0..0.01) on XY, extruded up 0.03 → tool
    // column (0..0.01)×(0..0.01)×(0..0.02 of the box) = 2e-6 removed.
    const profile = new Sketch(planeXY())
      .lineTo(0, 0)
      .lineTo(mm(10), 0)
      .lineTo(mm(10), mm(10))
      .lineTo(0, mm(10));
    try {
      const result = pocket(oc, target, profile, mm(30));
      try {
        expect(result.isValid()).toBe(true);
        expect(rel(volume(oc, result), 6e-6)).toBeLessThan(1e-9);
      } finally {
        result.delete();
      }
    } finally {
      target.delete();
    }
  });

  it("integrates with the feature-history engine: depth param drives the rebuild", () => {
    const m = new Model();
    m.setParam("depth", mm(10));
    m.addFeature({
      id: "block",
      deps: [],
      evaluate: (ctx) =>
        extrude(oc, Sketch.rectangle(planeXY(), mm(20), mm(30)), ctx.params.get("depth")!),
    });
    expect(rel(volume(oc, m.result("block") as Solid), 6e-6)).toBeLessThan(1e-9);

    m.setParam("depth", mm(20)); // re-evaluate → doubled volume
    expect(rel(volume(oc, m.result("block") as Solid), 1.2e-5)).toBeLessThan(1e-9);
  });
});
