import { beforeAll, describe, expect, it } from "vitest";
import { initSketchSolver, solveSketch } from "@plastiq/cad";
import { buildDimension, canDimension, measure } from "./dim.js";
import { toSolverInput, type SketchModel } from "./model.js";

// planegcs (the sketch solver) loads its wasm asynchronously; init once.
beforeAll(async () => {
  await initSketchSolver();
}, 120_000);

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

  it("lineAngle: one line ∠ to the X axis — canDimension, measure, build, drive", () => {
    expect(canDimension("lineAngle", model, ["l0"])).toBe(true); // exactly one line
    expect(canDimension("lineAngle", model, ["l0", "l1"])).toBe(false); // two → use `angle`
    // l0 = p0→p1 = atan2(4,3) ≈ 53.13°.
    expect(measure("lineAngle", model, ["l0"])! * (180 / Math.PI)).toBeCloseTo(53.13, 1);
    const dim = buildDimension("lineAngle", model, ["l0"], Math.PI / 6, "la")!;
    expect(dim).toMatchObject({ kind: "lineAngle", line: "l0", value: Math.PI / 6 });
    const input = toSolverInput({ ...model, constraints: [dim] });
    expect(input.constraints).toEqual([{ kind: "lineAngle", a: 0, b: 1, value: Math.PI / 6 }]);
    // The solver tilts the free endpoint so the line sits at exactly 30°.
    const r = solveSketch(input.points, input.circles, input.constraints);
    const [a, b] = r.points;
    expect(Math.atan2(b!.y - a!.y, b!.x - a!.x)).toBeCloseTo(Math.PI / 6, 5);
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

// Selecting a SEGMENT and dimensioning it is the ordinary CAD gesture. It used
// to be a silent no-op: only loose points were resolved, so `measure` returned
// null and addDimension bailed before building anything — the button appeared to
// do nothing at all.
describe("dimensioning a selected line (its endpoints are the pair)", () => {
  it("offers, measures and builds a length on one selected line", () => {
    expect(canDimension("distance", model, ["l0"])).toBe(true);
    expect(measure("distance", model, ["l0"])).toBeCloseTo(0.05, 9); // the 3-4-5 span
    const d = buildDimension("distance", model, ["l0"], 0.05, "d5")!;
    expect(d).toMatchObject({ kind: "distance", a: "p0", b: "p1", value: 0.05 });
  });

  it("h/v distances take the line's own direction, signed a→b", () => {
    expect(measure("hDistance", model, ["l0"])).toBeCloseTo(0.03, 9);
    expect(measure("vDistance", model, ["l0"])).toBeCloseTo(0.04, 9);
    expect(canDimension("hDistance", model, ["l0"])).toBe(true);
    expect(canDimension("vDistance", model, ["l0"])).toBe(true);
  });

  it("what it measures is exactly what it builds — can/measure/build agree", () => {
    // The three used to resolve the selection separately, so a selection could be
    // offered and then refused. They share one resolver now.
    for (const sel of [["l0"], ["p0", "p1"], ["l1"]]) {
      const ok = canDimension("distance", model, sel);
      const v = measure("distance", model, sel);
      expect(ok).toBe(v != null);
      expect(ok).toBe(buildDimension("distance", model, sel, v ?? 0, "x") !== null);
    }
  });

  it("stays out of AMBIGUOUS selections rather than guessing", () => {
    expect(canDimension("distance", model, ["l0", "l1"])).toBe(false); // that's an angle
    expect(canDimension("distance", model, ["l0", "c"])).toBe(false); // line + loose point
    expect(measure("distance", model, ["l0", "l1"])).toBeNull();
    // …and two lines still dimension as an angle, unchanged.
    expect(canDimension("angle", model, ["l0", "l1"])).toBe(true);
  });

  it("a solver constraint built from a line really binds its endpoints", () => {
    const d = buildDimension("distance", model, ["l0"], 0.05, "d6")!;
    const input = toSolverInput({ ...model, constraints: [d] });
    expect(input.constraints).toHaveLength(1); // not driven → a real residual
  });
});
