import { describe, expect, it } from "vitest";
import { solveSketch } from "@plastiq/cad";
import { buildDimension, canDimension, measure } from "./dim.js";
import { toSolverInput, type SketchModel } from "./model.js";

const model: SketchModel = {
  plane: "XY",
  points: [
    { id: "p0", u: 0, v: 0, fixed: true },
    { id: "p1", u: 0.03, v: 0.04 },
    { id: "c", u: 0.1, v: 0 },
  ],
  entities: [
    { id: "l0", kind: "line", a: "p0", b: "p1" },
    { id: "l1", kind: "line", a: "p0", b: "c" },
    { id: "circ", kind: "circle", center: "c", radius: 0.01 },
  ],
  constraints: [],
};

describe("dimensions — measure / canDimension / build (FR-19)", () => {
  it("measures the current distance between two points", () => {
    expect(measure("distance", model, ["p0", "p1"])).toBeCloseTo(0.05, 9); // 3-4-5
  });

  it("measures a circle's current radius", () => {
    expect(measure("radius", model, ["circ"])).toBeCloseTo(0.01, 9);
  });

  it("measures the acute angle between two lines", () => {
    // l1 is along +X (0 rad); l0 is atan2(4,3) ≈ 53.13°.
    expect(measure("angle", model, ["l0", "l1"])! * (180 / Math.PI)).toBeCloseTo(53.13, 1);
  });

  it("canDimension matches the selection shape", () => {
    expect(canDimension("distance", model, ["p0", "p1"])).toBe(true);
    expect(canDimension("distance", model, ["p0"])).toBe(false);
    expect(canDimension("radius", model, ["circ"])).toBe(true);
    expect(canDimension("angle", model, ["l0", "l1"])).toBe(true);
  });

  it("a distance dimension drives the geometry when solved", () => {
    const dim = buildDimension("distance", model, ["p0", "p1"], 0.08, "d1")!;
    expect(dim).toMatchObject({ kind: "distance", a: "p0", b: "p1", value: 0.08 });
    const solved = { ...model, constraints: [dim] };
    const input = toSolverInput(solved);
    const result = solveSketch(input.points, input.circles, input.constraints);
    const a = result.points[0]!;
    const b = result.points[1]!;
    expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeCloseTo(0.08, 5);
  });

  it("measures + maps diameter as twice the radius (D9)", () => {
    expect(measure("diameter", model, ["circ"])).toBeCloseTo(0.02, 9);
    const dim = buildDimension("diameter", model, ["circ"], 0.03, "d2")!;
    expect(dim).toMatchObject({ kind: "diameter", circle: "circ", value: 0.03 });
    // Lowered to a kernel radius constraint at half the diameter.
    const input = toSolverInput({ ...model, constraints: [dim] });
    expect(input.constraints).toEqual([{ kind: "radius", circle: 0, value: 0.015 }]);
  });

  it("measures + drives horizontal / vertical distance (D9)", () => {
    expect(measure("hDistance", model, ["p0", "p1"])).toBeCloseTo(0.03, 9); // Δx
    expect(measure("vDistance", model, ["p0", "p1"])).toBeCloseTo(0.04, 9); // Δy
    const dim = buildDimension("hDistance", model, ["p0", "p1"], 0.05, "d3")!;
    const input = toSolverInput({ ...model, constraints: [dim] });
    expect(input.constraints).toEqual([{ kind: "hDistance", a: 0, b: 1, value: 0.05 }]);
    const result = solveSketch(input.points, input.circles, input.constraints);
    expect(result.points[1]!.x - result.points[0]!.x).toBeCloseTo(0.05, 5);
  });

  it("canDimension covers the new kinds", () => {
    expect(canDimension("diameter", model, ["circ"])).toBe(true);
    expect(canDimension("hDistance", model, ["p0", "p1"])).toBe(true);
    expect(canDimension("vDistance", model, ["p0", "p1"])).toBe(true);
  });

  it("a driven (reference) dimension is skipped by the solver", () => {
    const driven = {
      ...buildDimension("distance", model, ["p0", "p1"], 0.08, "d4")!,
      driven: true,
    };
    const input = toSolverInput({ ...model, constraints: [driven] });
    expect(input.constraints).toEqual([]); // driven adds no residual
  });
});
