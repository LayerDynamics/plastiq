import { describe, expect, it } from "vitest";
import { buildConstraints, canApply, distToSegment, hitTest } from "./hit.js";
import type { SketchModel } from "./model.js";
import { toScreen, type View2D } from "./transform2d.js";

const view: View2D = { scale: 1000, panX: 400, panY: 300 };
// `hitTest` now takes a projector (sketch point → pixels through the live
// camera) rather than a fixed 2D view. A scale+pan is still a valid projector,
// so these keep testing the hit ranking with readable arithmetic.
const project = (uv: readonly [number, number]): { x: number; y: number } =>
  toScreen(view, { u: uv[0], v: uv[1] });

const model: SketchModel = {
  plane: "XY",
  points: [
    { id: "p0", u: 0, v: 0 },
    { id: "p1", u: 0.05, v: 0 },
    { id: "p2", u: 0.05, v: 0.03 },
  ],
  entities: [
    { id: "l0", kind: "line", a: "p0", b: "p1" },
    { id: "l1", kind: "line", a: "p1", b: "p2" },
  ],
  constraints: [],
};

describe("hitTest — click → nearest entity (M3.4)", () => {
  it("hits a point when the cursor is on it", () => {
    const s = toScreen(view, { u: 0.05, v: 0 });
    expect(hitTest(model, project, { x: s.x + 2, y: s.y })).toEqual({ kind: "point", id: "p1" });
  });

  it("hits a line along its span (not just endpoints)", () => {
    const s = toScreen(view, { u: 0.025, v: 0 }); // midpoint of l0
    expect(hitTest(model, project, { x: s.x, y: s.y + 2 })).toEqual({ kind: "line", id: "l0" });
  });

  it("misses empty space", () => {
    expect(hitTest(model, project, { x: 10, y: 10 })).toBeNull();
  });
});

describe("canApply / buildConstraints — select-then-constrain (FR-18)", () => {
  let n = 0;
  const nextId = (): string => `c${++n}`;

  it("horizontal applies to a selected line", () => {
    expect(canApply("horizontal", model, ["l0"])).toBe(true);
    expect(buildConstraints("horizontal", model, ["l0"], nextId)).toEqual([
      { id: "c1", kind: "horizontal", line: "l0" },
    ]);
  });

  it("coincident needs exactly two points", () => {
    expect(canApply("coincident", model, ["p0"])).toBe(false);
    expect(canApply("coincident", model, ["p0", "p1"])).toBe(true);
    expect(buildConstraints("coincident", model, ["p0", "p1"], nextId)).toEqual([
      { id: "c2", kind: "coincident", a: "p0", b: "p1" },
    ]);
  });

  it("parallel/perpendicular/equal need two lines", () => {
    expect(canApply("parallel", model, ["l0"])).toBe(false);
    expect(canApply("parallel", model, ["l0", "l1"])).toBe(true);
    expect(buildConstraints("perpendicular", model, ["l0", "l1"], nextId)).toEqual([
      { id: "c3", kind: "perpendicular", line1: "l0", line2: "l1" },
    ]);
  });

  it("a non-fitting selection yields no constraint", () => {
    expect(buildConstraints("coincident", model, ["l0"], nextId)).toEqual([]);
  });
});

describe("canApply / buildConstraints — concentric + tangent (D7)", () => {
  let n = 0;
  const nextId = (): string => `k${++n}`;
  const m: SketchModel = {
    plane: "XY",
    points: [
      { id: "a", u: 0, v: 0 },
      { id: "b", u: 0.1, v: 0 },
      { id: "c1", u: 0.02, v: 0.02 },
      { id: "c2", u: 0.06, v: 0.02 },
    ],
    entities: [
      { id: "l", kind: "line", a: "a", b: "b" },
      { id: "circ1", kind: "circle", center: "c1", radius: 0.01 },
      { id: "circ2", kind: "circle", center: "c2", radius: 0.015 },
    ],
    constraints: [],
  };

  it("concentric needs exactly two circles", () => {
    expect(canApply("concentric", m, ["circ1"])).toBe(false);
    expect(canApply("concentric", m, ["circ1", "circ2"])).toBe(true);
    expect(canApply("concentric", m, ["circ1", "l"])).toBe(false);
    expect(buildConstraints("concentric", m, ["circ1", "circ2"], nextId)).toEqual([
      { id: "k1", kind: "concentric", circle1: "circ1", circle2: "circ2" },
    ]);
  });

  it("tangent supports line↔circle and circle↔circle", () => {
    expect(canApply("tangent", m, ["l"])).toBe(false);
    expect(canApply("tangent", m, ["l", "circ1"])).toBe(true);
    expect(canApply("tangent", m, ["circ1", "circ2"])).toBe(true);
    expect(buildConstraints("tangent", m, ["l", "circ1"], nextId)).toEqual([
      { id: "k2", kind: "tangent", curve1: "l", curve2: "circ1" },
    ]);
  });

  it("equal radius authors against two selected radius curves", () => {
    expect(canApply("equalRadius", m, ["circ1", "circ2"])).toBe(true);
    expect(buildConstraints("equalRadius", m, ["circ1", "circ2"], nextId)).toEqual([
      { id: "k3", kind: "equalRadius", curve1: "circ1", curve2: "circ2" },
    ]);
  });

  it("midpoint needs one point and one line", () => {
    expect(canApply("midpoint", m, ["a"])).toBe(false);
    expect(canApply("midpoint", m, ["a", "l"])).toBe(true);
    expect(buildConstraints("midpoint", m, ["a", "l"], nextId)).toEqual([
      { id: "k4", kind: "midpoint", point: "a", line: "l" },
    ]);
  });

  it("point-on-object needs one point and one line OR circle", () => {
    expect(canApply("pointOnObject", m, ["a"])).toBe(false);
    expect(canApply("pointOnObject", m, ["a", "l"])).toBe(true);
    expect(canApply("pointOnObject", m, ["a", "circ1"])).toBe(true);
    expect(canApply("pointOnObject", m, ["a", "l", "circ1"])).toBe(false);
    expect(buildConstraints("pointOnObject", m, ["a", "circ1"], nextId)).toEqual([
      { id: "k5", kind: "pointOnObject", point: "a", object: "circ1" },
    ]);
  });

  it("symmetric needs two points and one axis line", () => {
    expect(canApply("symmetric", m, ["a", "b"])).toBe(false);
    expect(canApply("symmetric", m, ["a", "b", "l"])).toBe(true);
    expect(buildConstraints("symmetric", m, ["a", "b", "l"], nextId)).toEqual([
      { id: "k6", kind: "symmetric", a: "a", b: "b", axis: "l" },
    ]);
  });
});

describe("distToSegment — degenerate-segment epsilon guard", () => {
  it("treats a 1e-12 px segment as a point instead of dividing by ~0", () => {
    const a = { x: 400, y: 300 };
    const b = { x: 400 + 1e-12, y: 300 }; // length 1e-12 px → len² = 1e-24
    const d = distToSegment({ x: 402, y: 300 }, a, b);
    expect(Number.isFinite(d)).toBe(true);
    expect(d).toBeCloseTo(2, 9); // exactly the distance to the collapsed point
  });

  it("an exactly-zero-length segment still measures as a point", () => {
    const a = { x: 100, y: 100 };
    expect(distToSegment({ x: 103, y: 104 }, a, { ...a })).toBeCloseTo(5, 9);
  });

  it("a real segment still measures along its span (epsilon not over-eager)", () => {
    const d = distToSegment({ x: 405, y: 303 }, { x: 400, y: 300 }, { x: 410, y: 300 });
    expect(d).toBeCloseTo(3, 9);
  });
});
