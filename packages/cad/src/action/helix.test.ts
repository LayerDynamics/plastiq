// Real-OCCT tests for helix (§13.2): a helical wire whose length and endpoints
// match the analytic cylinder/cone helix.

import { beforeAll, describe, expect, it } from "vitest";
import type { TopoDS_Shape, TopoDS_Wire } from "opencascade.js";

import { initOcct, type Occt } from "../oc/init.js";
import { shapeEnums } from "../mesh/normals.js";
import { helix, type HelixSpec } from "./helix.js";

let oc: Occt;
beforeAll(async () => {
  oc = await initOcct();
}, 120_000);

/** Arc length of a shape via BRepGProp.LinearProperties (Mass ≡ length). */
function wireLength(shape: TopoDS_Shape): number {
  const props = new oc.GProp_GProps_1();
  try {
    oc.BRepGProp.LinearProperties(shape, props, false, false);
    return props.Mass();
  } finally {
    props.delete();
  }
}

/** First / last vertex positions of a wire (start → end of the single edge). */
function wireEnds(wire: TopoDS_Wire): {
  start: [number, number, number];
  end: [number, number, number];
} {
  const S = shapeEnums(oc);
  const exp = new oc.TopExp_Explorer_2(wire, S.TopAbs_VERTEX, S.TopAbs_SHAPE);
  const pts: [number, number, number][] = [];
  try {
    while (exp.More()) {
      const v = oc.TopoDS.Vertex_1(exp.Current());
      const p = oc.BRep_Tool.Pnt(v);
      pts.push([p.X(), p.Y(), p.Z()]);
      p.delete();
      v.delete();
      exp.Next();
    }
  } finally {
    exp.delete();
  }
  // A single open edge contributes two vertices; explorer order is start then end.
  expect(pts.length).toBeGreaterThanOrEqual(2);
  return { start: pts[0]!, end: pts[pts.length - 1]! };
}

/** Analytic length of a constant-radius cylindrical helix. */
function cylHelixLength(radius: number, pitch: number, turns: number): number {
  return turns * Math.hypot(2 * Math.PI * radius, pitch);
}

/** Numeric arc length of a tapered (linear-radius) helix for test oracles. */
function taperHelixLength(
  radius: number,
  pitch: number,
  turns: number,
  taperAngle: number,
  samples = 4096,
): number {
  let len = 0;
  let prev: [number, number, number] | null = null;
  const height = pitch * turns;
  for (let i = 0; i <= samples; i++) {
    const s = i / samples;
    const t = s * turns * 2 * Math.PI;
    const z = height * s;
    const r = radius + z * Math.tan(taperAngle);
    const p: [number, number, number] = [r * Math.cos(t), r * Math.sin(t), z];
    if (prev) {
      len += Math.hypot(p[0] - prev[0], p[1] - prev[1], p[2] - prev[2]);
    }
    prev = p;
  }
  return len;
}

describe("helix", () => {
  it("builds a cylindrical helix with analytic length and endpoint height", () => {
    const spec: HelixSpec = {
      radius: 0.01,
      pitch: 0.005,
      turns: 2,
      handedness: "right",
    };
    const wire = helix(oc, spec);
    try {
      const expected = cylHelixLength(spec.radius, spec.pitch, spec.turns);
      // Exact pcurve-on-cylinder (Geom2d_Line → MakeEdge → BuildCurves3d); length
      // from GCPnts sampling of the 3d curve is within ~1 µm of analytic.
      expect(wireLength(wire)).toBeCloseTo(expected, 5);

      const { start, end } = wireEnds(wire);
      expect(start[0]).toBeCloseTo(spec.radius, 9);
      expect(start[1]).toBeCloseTo(0, 9);
      expect(start[2]).toBeCloseTo(0, 9);
      // Integer turns: end sits back on +X at height = pitch·turns.
      expect(end[0]).toBeCloseTo(spec.radius, 6);
      expect(end[1]).toBeCloseTo(0, 6);
      expect(end[2]).toBeCloseTo(spec.pitch * spec.turns, 9);
    } finally {
      wire.delete();
    }
  });

  it("left-handed helix winds the opposite way (fractional turn endpoint)", () => {
    const base = { radius: 0.01, pitch: 0.008, turns: 0.25 };
    const right = helix(oc, { ...base, handedness: "right" });
    const left = helix(oc, { ...base, handedness: "left" });
    try {
      const rEnd = wireEnds(right).end;
      const lEnd = wireEnds(left).end;
      // Quarter-turn right → (0, +r, h); left → (0, −r, h).
      expect(rEnd[0]).toBeCloseTo(0, 5);
      expect(rEnd[1]).toBeCloseTo(base.radius, 5);
      expect(lEnd[0]).toBeCloseTo(0, 5);
      expect(lEnd[1]).toBeCloseTo(-base.radius, 5);
      expect(rEnd[2]).toBeCloseTo(base.pitch * base.turns, 9);
      expect(lEnd[2]).toBeCloseTo(base.pitch * base.turns, 9);
      // Same length either hand.
      expect(wireLength(left)).toBeCloseTo(wireLength(right), 9);
    } finally {
      left.delete();
      right.delete();
    }
  });

  it("taperAngle opens the radius along the cone (end radius = r + h·tan α)", () => {
    const radius = 0.01;
    const pitch = 0.006;
    const turns = 1.5;
    const taperAngle = Math.PI / 18; // 10°
    const wire = helix(oc, { radius, pitch, turns, handedness: "right", taperAngle });
    try {
      const height = pitch * turns;
      const endR = radius + height * Math.tan(taperAngle);
      const { end } = wireEnds(wire);
      const endRadial = Math.hypot(end[0], end[1]);
      expect(endRadial).toBeCloseTo(endR, 5);
      expect(end[2]).toBeCloseTo(height, 6);

      // Length tracks the tapered analytic curve (numeric oracle).
      const expected = taperHelixLength(radius, pitch, turns, taperAngle);
      expect(wireLength(wire)).toBeCloseTo(expected, 4);
    } finally {
      wire.delete();
    }
  });

  it("rejects non-positive / non-finite inputs with named errors before OCCT work", () => {
    expect(() => helix(oc, { radius: 0, pitch: 0.01, turns: 1, handedness: "right" })).toThrow(
      /helix: radius/,
    );
    expect(() => helix(oc, { radius: 0.01, pitch: 0, turns: 1, handedness: "right" })).toThrow(
      /helix: pitch/,
    );
    expect(() => helix(oc, { radius: 0.01, pitch: 0.01, turns: 0, handedness: "right" })).toThrow(
      /helix: turns/,
    );
    expect(() =>
      helix(oc, { radius: 0.01, pitch: 0.01, turns: 1, handedness: "right", taperAngle: Math.PI }),
    ).toThrow(/helix: \|taperAngle\|/);
    // Taper that drives end radius through zero.
    expect(() =>
      helix(oc, {
        radius: 0.01,
        pitch: 0.02,
        turns: 2,
        handedness: "right",
        taperAngle: -Math.PI / 4, // tan large enough to collapse
      }),
    ).toThrow(/helix: taper collapses/);
  });

  it("is a single-edge open wire usable as a sweep spine", () => {
    const wire = helix(oc, { radius: 0.005, pitch: 0.004, turns: 3, handedness: "right" });
    try {
      const S = shapeEnums(oc);
      let edges = 0;
      const exp = new oc.TopExp_Explorer_2(wire, S.TopAbs_EDGE, S.TopAbs_SHAPE);
      while (exp.More()) {
        edges++;
        exp.Next();
      }
      exp.delete();
      expect(edges).toBe(1);
      expect(wire.IsNull()).toBe(false);
      expect(wireLength(wire)).toBeGreaterThan(0);
    } finally {
      wire.delete();
    }
  });
});
