import { describe, expect, it } from "vitest";
import { solveSketch } from "@mechx/cad";
import {
  emptySketch,
  perpDistance,
  regularPolygonVertices,
  slotOutline,
  toSolverInput,
  type SketchModel,
} from "./model.js";

// A two-segment open chain p0→p1→p2 with one horizontal constraint on p0→p1.
function chain(): SketchModel {
  return {
    plane: "XY",
    points: [
      { id: "p0", u: 0, v: 0, fixed: true },
      { id: "p1", u: 0.05, v: 0.01 },
      { id: "p2", u: 0.05, v: 0.04 },
    ],
    entities: [
      { id: "l0", kind: "line", a: "p0", b: "p1" },
      { id: "l1", kind: "line", a: "p1", b: "p2" },
    ],
    constraints: [{ id: "c0", kind: "horizontal", line: "l0" }],
  };
}

describe("sketch model → solver input (M3.4 bridge)", () => {
  it("maps point/line ids to the solver's numeric indices", () => {
    const input = toSolverInput(chain());
    expect(input.points).toHaveLength(3);
    expect(input.points[0]).toMatchObject({ x: 0, y: 0, fixed: true });
    // The horizontal constraint references the line's endpoint indices (0,1).
    expect(input.constraints).toEqual([{ kind: "horizontal", a: 0, b: 1 }]);
  });

  it("the kernel solver enforces the mapped constraint", () => {
    const input = toSolverInput(chain());
    const result = solveSketch(input.points, input.circles, input.constraints);
    // p1 must end at the same height as p0 (horizontal segment).
    expect(result.points[1]!.y).toBeCloseTo(result.points[0]!.y, 6);
  });

  it("maps a circle's radius constraint to the circle index", () => {
    const model: SketchModel = {
      ...emptySketch(),
      points: [{ id: "c", u: 0.02, v: 0.02 }],
      entities: [{ id: "circ", kind: "circle", center: "c", radius: 0.01 }],
      constraints: [{ id: "r", kind: "radius", circle: "circ", value: 0.015 }],
    };
    const input = toSolverInput(model);
    expect(input.circles).toEqual([{ center: 0, radius: 0.01 }]);
    expect(input.constraints).toEqual([{ kind: "radius", circle: 0, value: 0.015 }]);
    const result = solveSketch(input.points, input.circles, input.constraints);
    expect(result.radii[0]).toBeCloseTo(0.015, 6);
  });
});

describe("concentric + tangent constraints (D7, kernel-backed)", () => {
  it("maps + solves concentric: two circle centres coincide", () => {
    const model: SketchModel = {
      ...emptySketch(),
      points: [
        { id: "c1", u: 0, v: 0 },
        { id: "c2", u: 0.05, v: 0 },
      ],
      entities: [
        { id: "circ1", kind: "circle", center: "c1", radius: 0.01 },
        { id: "circ2", kind: "circle", center: "c2", radius: 0.02 },
      ],
      constraints: [{ id: "k", kind: "concentric", circle1: "circ1", circle2: "circ2" }],
    };
    const input = toSolverInput(model);
    expect(input.constraints).toEqual([{ kind: "concentric", a: 0, b: 1 }]);
    const r = solveSketch(input.points, input.circles, input.constraints);
    expect(r.points[0]!.x).toBeCloseTo(r.points[1]!.x, 6);
    expect(r.points[0]!.y).toBeCloseTo(r.points[1]!.y, 6);
  });

  it("maps + solves tangent: the circle radius grows to meet the line", () => {
    const model: SketchModel = {
      ...emptySketch(),
      points: [
        { id: "a", u: 0, v: 0, fixed: true },
        { id: "b", u: 0.1, v: 0, fixed: true },
        { id: "c", u: 0.05, v: 0.03, fixed: true },
      ],
      entities: [
        { id: "l", kind: "line", a: "a", b: "b" },
        { id: "circ", kind: "circle", center: "c", radius: 0.01 },
      ],
      constraints: [{ id: "k", kind: "tangent", line: "l", circle: "circ" }],
    };
    const input = toSolverInput(model);
    expect(input.constraints).toEqual([{ kind: "tangentLineCircle", a: 0, b: 1, circle: 0 }]);
    const r = solveSketch(input.points, input.circles, input.constraints);
    // Perp distance from the fixed centre (0.05,0.03) to the line y=0 is 0.03.
    expect(r.radii[0]).toBeCloseTo(0.03, 6);
  });
});

describe("point-on-object / symmetric / midpoint constraints (D8)", () => {
  const base = (): SketchModel => ({
    ...emptySketch(),
    points: [
      { id: "a", u: 0, v: 0 },
      { id: "b", u: 0.1, v: 0 },
      { id: "p", u: 0.03, v: 0.04 },
    ],
    entities: [{ id: "l", kind: "line", a: "a", b: "b" }],
    constraints: [],
  });

  it("maps midpoint (point + line) to the solver midpoint", () => {
    const m = base();
    m.constraints = [{ id: "k", kind: "midpoint", point: "p", line: "l" }];
    expect(toSolverInput(m).constraints).toEqual([{ kind: "midpoint", m: 2, a: 0, b: 1 }]);
  });

  it("maps point-on-object to pointOnLine for a line target", () => {
    const m = base();
    m.constraints = [{ id: "k", kind: "pointOnObject", point: "p", object: "l" }];
    expect(toSolverInput(m).constraints).toEqual([{ kind: "pointOnLine", p: 2, a: 0, b: 1 }]);
  });

  it("maps point-on-object to pointOnCircle for a circle target", () => {
    const m = base();
    m.points.push({ id: "cc", u: 0.05, v: 0.05 });
    m.entities.push({ id: "circ", kind: "circle", center: "cc", radius: 0.02 });
    m.constraints = [{ id: "k", kind: "pointOnObject", point: "p", object: "circ" }];
    expect(toSolverInput(m).constraints).toEqual([{ kind: "pointOnCircle", p: 2, circle: 0 }]);
  });

  it("maps symmetric (2 points + axis line) and the solver mirrors", () => {
    const m: SketchModel = {
      ...emptySketch(),
      points: [
        { id: "c", u: 0, v: 0, fixed: true },
        { id: "d", u: 0.1, v: 0, fixed: true },
        { id: "a", u: 0.03, v: 0.02, fixed: true },
        { id: "b", u: 0.08, v: 0.08 },
      ],
      entities: [{ id: "ax", kind: "line", a: "c", b: "d" }],
      constraints: [{ id: "k", kind: "symmetric", a: "a", b: "b", axis: "ax" }],
    };
    const input = toSolverInput(m);
    expect(input.constraints).toEqual([{ kind: "symmetric", a: 2, b: 3, c: 0, d: 1 }]);
    const r = solveSketch(input.points, input.circles, input.constraints);
    expect(r.points[3]!.x).toBeCloseTo(0.03, 6);
    expect(r.points[3]!.y).toBeCloseTo(-0.02, 6);
  });
});

describe("polygon + slot geometry helpers (FR-16)", () => {
  it("regularPolygonVertices returns n vertices on the circumcircle", () => {
    const v = regularPolygonVertices([0, 0], [0.05, 0], 6);
    expect(v).toHaveLength(6);
    // Every vertex is at radius 0.05 from the centre.
    for (const p of v) expect(Math.hypot(p.u, p.v)).toBeCloseTo(0.05, 9);
    // The first vertex is the clicked one.
    expect(v[0]).toEqual({ u: 0.05, v: 0 });
    // A hexagon's second vertex is at 60°.
    expect(v[1]!.u).toBeCloseTo(0.05 * Math.cos(Math.PI / 3), 9);
    expect(v[1]!.v).toBeCloseTo(0.05 * Math.sin(Math.PI / 3), 9);
  });

  it("slotOutline places parallel sides and end-cap apexes", () => {
    // Horizontal centre line (0,0)→(0.1,0), radius 0.02.
    const o = slotOutline([0, 0], [0.1, 0], 0.02)!;
    const near = (p: { u: number; v: number }, u: number, v: number): void => {
      expect(p.u).toBeCloseTo(u, 9);
      expect(p.v).toBeCloseTo(v, 9);
    };
    near(o.a1, 0, 0.02);
    near(o.b1, 0.1, 0.02);
    near(o.b2, 0.1, -0.02);
    near(o.a2, 0, -0.02);
    near(o.capB, 0.12, 0); // apex past B along +x
    near(o.capA, -0.02, 0); // apex past A along −x
  });

  it("slotOutline rejects a degenerate centre line or radius", () => {
    expect(slotOutline([0, 0], [0, 0], 0.02)).toBeNull();
    expect(slotOutline([0, 0], [0.1, 0], 0)).toBeNull();
  });

  it("perpDistance measures the offset from a point to a line", () => {
    expect(perpDistance([0.05, 0.03], [0, 0], [0.1, 0])).toBeCloseTo(0.03, 9);
    expect(perpDistance([0.2, 0], [0, 0], [0.1, 0])).toBeCloseTo(0, 9);
  });
});
