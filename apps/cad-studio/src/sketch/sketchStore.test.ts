import { beforeEach, describe, expect, it } from "vitest";
import { useSketchStore } from "./sketchStore.js";
import type { CircleEntity, LineEntity } from "./model.js";

const s = () => useSketchStore.getState();

beforeEach(() => {
  s().enterSketch("XY");
});

describe("sketch drawing tools (M3.2)", () => {
  it("the line tool chains points into connected segments", () => {
    s().setTool("line");
    s().clickAt(0, 0);
    s().clickAt(0.05, 0);
    s().clickAt(0.05, 0.03);
    const m = s().model;
    expect(m.points).toHaveLength(3);
    const lines = m.entities.filter((e): e is LineEntity => e.kind === "line");
    expect(lines).toHaveLength(2); // p1→p2, p2→p3 (chained)
    expect(lines[0]!.a).toBe(m.points[0]!.id);
    expect(lines[0]!.b).toBe(m.points[1]!.id);
    expect(lines[1]!.a).toBe(m.points[1]!.id);
  });

  it("the rectangle tool builds 4 corners + 4 closing edges from 2 clicks", () => {
    s().setTool("rectangle");
    s().clickAt(0, 0);
    s().clickAt(0.04, 0.02);
    const m = s().model;
    expect(m.points).toHaveLength(4);
    expect(m.entities.filter((e) => e.kind === "line")).toHaveLength(4);
    // Axis-aligned corners.
    const us = m.points.map((p) => p.u).sort((a, b) => a - b);
    const vs = m.points.map((p) => p.v).sort((a, b) => a - b);
    expect(us).toEqual([0, 0, 0.04, 0.04]);
    expect(vs).toEqual([0, 0, 0.02, 0.02]);
    expect(s().pending).toHaveLength(0);
  });

  it("the rectCenter tool builds a rectangle centred on the first click", () => {
    s().setTool("rectCenter");
    s().clickAt(0, 0); // centre
    s().clickAt(0.02, 0.01); // corner → half-extents 0.02 × 0.01
    const m = s().model;
    expect(m.points).toHaveLength(4);
    expect(m.entities.filter((e) => e.kind === "line")).toHaveLength(4);
    const us = m.points.map((p) => p.u).sort((a, b) => a - b);
    const vs = m.points.map((p) => p.v).sort((a, b) => a - b);
    expect(us).toEqual([-0.02, -0.02, 0.02, 0.02]);
    expect(vs).toEqual([-0.01, -0.01, 0.01, 0.01]);
  });

  it("the circle3 tool fits a circle through three clicks", () => {
    s().setTool("circle3");
    // Three points on the unit-ish circle centred at (0.05,0): (0.04,0),(0.06,0),(0.05,0.01)
    s().clickAt(0.04, 0);
    s().clickAt(0.06, 0);
    s().clickAt(0.05, 0.01);
    const circles = s().model.entities.filter((e) => e.kind === "circle");
    expect(circles).toHaveLength(1);
    // Only the centre point remains (the 3 temp on-circle points are replaced).
    expect(s().model.points).toHaveLength(1);
    const centre = s().model.points[0]!;
    expect(centre.u).toBeCloseTo(0.05, 6);
    expect(centre.v).toBeCloseTo(0, 6);
  });

  it("the arc3 tool builds one arc through three clicks (start, mid, end)", () => {
    s().setTool("arc3");
    s().clickAt(-0.02, 0); // start
    s().clickAt(0, 0.02); // a point on the arc
    s().clickAt(0.02, 0); // end
    const arcs = s().model.entities.filter((e) => e.kind === "arc");
    expect(arcs).toHaveLength(1);
    expect(s().model.points).toHaveLength(3);
    const arc = arcs[0]!;
    if (arc.kind !== "arc") throw new Error("expected arc");
    // a = first click, b = last click, through = the middle click.
    const [p0, p1, p2] = s().model.points;
    expect(arc.a).toBe(p0!.id);
    expect(arc.through).toBe(p1!.id);
    expect(arc.b).toBe(p2!.id);
  });

  it("the arcCenter tool builds an arc (centre, start, end) and drops the centre", () => {
    s().setTool("arcCenter");
    s().clickAt(0, 0); // centre
    s().clickAt(0.05, 0); // start → radius 0.05, angle 0
    s().clickAt(0, 0.05); // end direction → angle 90°
    const arcs = s().model.entities.filter((e) => e.kind === "arc");
    expect(arcs).toHaveLength(1);
    // start + end + through remain; the centre point was dropped.
    expect(s().model.points).toHaveLength(3);
    const arc = arcs[0]!;
    if (arc.kind !== "arc") throw new Error("expected arc");
    const end = s().model.points.find((p) => p.id === arc.b)!;
    const through = s().model.points.find((p) => p.id === arc.through)!;
    // End snapped onto the radius-0.05 circle at 90°.
    expect(end.u).toBeCloseTo(0, 6);
    expect(end.v).toBeCloseTo(0.05, 6);
    // Through sits at the 45° bisector on the same circle.
    expect(through.u).toBeCloseTo(0.05 * Math.SQRT1_2, 6);
    expect(through.v).toBeCloseTo(0.05 * Math.SQRT1_2, 6);
  });

  it("the circle tool sets radius from the centre→edge click distance", () => {
    s().setTool("circle");
    s().clickAt(0, 0); // centre
    s().clickAt(0.03, 0.04); // radius point (3-4-5 → r=0.05)
    const circles = s().model.entities.filter((e): e is CircleEntity => e.kind === "circle");
    expect(circles).toHaveLength(1);
    expect(circles[0]!.radius).toBeCloseTo(0.05, 9);
  });

  it("the polygon tool builds a regular n-gon from centre + vertex", () => {
    s().setPolygonSides(5);
    s().setTool("polygon");
    s().clickAt(0, 0); // centre
    s().clickAt(0.04, 0); // a vertex (radius 0.04)
    const m = s().model;
    expect(m.points).toHaveLength(5); // 5 vertices, centre dropped
    expect(m.entities.filter((e) => e.kind === "line")).toHaveLength(5); // closed pentagon
    for (const p of m.points) expect(Math.hypot(p.u, p.v)).toBeCloseTo(0.04, 6);
  });

  it("the slot tool builds two lines + two arc caps from centre-line + width", () => {
    s().setTool("slot");
    s().clickAt(0, 0); // centre-line start
    s().clickAt(0.1, 0); // centre-line end
    s().clickAt(0.05, 0.02); // width point → radius 0.02
    const m = s().model;
    expect(m.entities.filter((e) => e.kind === "line")).toHaveLength(2);
    expect(m.entities.filter((e) => e.kind === "arc")).toHaveLength(2);
    // 6 outline points (4 corners + 2 cap apexes); centre-line anchors dropped.
    expect(m.points).toHaveLength(6);
  });

  it("the spline tool accumulates points and finishGesture commits one spline", () => {
    s().setTool("spline");
    s().clickAt(0, 0);
    s().clickAt(0.02, 0.03);
    s().clickAt(0.05, 0.01);
    expect(s().pending).toHaveLength(3);
    expect(s().model.entities.filter((e) => e.kind === "spline")).toHaveLength(0);
    s().finishGesture();
    const splines = s().model.entities.filter((e) => e.kind === "spline");
    expect(splines).toHaveLength(1);
    const sp = splines[0]!;
    if (sp.kind !== "spline") throw new Error("expected spline");
    expect(sp.points).toHaveLength(3);
    expect(s().pending).toHaveLength(0);
  });

  it("finishGesture with fewer than 2 spline points commits nothing", () => {
    s().setTool("spline");
    s().clickAt(0, 0);
    s().finishGesture();
    expect(s().model.entities.filter((e) => e.kind === "spline")).toHaveLength(0);
    expect(s().pending).toHaveLength(0);
  });

  it("the point tool places a single standalone reference point", () => {
    s().setTool("point");
    s().clickAt(0.03, 0.04);
    expect(s().model.points).toHaveLength(1);
    expect(s().model.entities).toHaveLength(0);
    expect(s().pending).toHaveLength(0);
  });

  it("the construction toggle flags new entities (excluded from the profile)", () => {
    s().setConstruction(true);
    s().setTool("line");
    s().clickAt(0, 0);
    s().clickAt(0.05, 0);
    expect(s().model.entities[0]!.construction).toBe(true);
  });

  it("Esc / cancelGesture drops an in-progress rectangle anchor", () => {
    s().setTool("rectangle");
    s().clickAt(0, 0);
    expect(s().pending).toHaveLength(1);
    s().cancelGesture();
    expect(s().pending).toHaveLength(0);
    expect(s().model.points).toHaveLength(1); // the placed anchor stays, no rect formed
  });

  it("switching tool clears the pending gesture", () => {
    s().setTool("line");
    s().clickAt(0, 0);
    s().setTool("circle");
    expect(s().pending).toHaveLength(0);
  });
});

describe("solver feedback (M3.6)", () => {
  it("solving reports DOF + verdict; anchoring/dimensioning reduces freedom", () => {
    // A free 2-point segment.
    s().setTool("line");
    s().clickAt(0, 0);
    s().clickAt(0.05, 0);
    const free = s().solve();
    expect(free.verdict).toBe("under-constrained");
    expect(free.freedom).toBeGreaterThan(0);

    // Anchor both endpoints → no remaining freedom.
    for (const p of s().model.points) s().toggleFix(p.id);
    const fixed = s().result!;
    expect(fixed.freedom).toBe(0);
    expect(fixed.verdict).toBe("well-constrained");
  });

  it("auto-demotes an over-constraining dimension to driven (FR-19)", () => {
    // A segment with one fixed end + one free end (2 DOF).
    s().setTool("line");
    s().clickAt(0, 0);
    s().clickAt(0.03, 0.04);
    const [p0, p1] = s().model.points;
    s().toggleFix(p0!.id);
    // h + v distance fully pin the free end → well-constrained.
    s().setSelection([p0!.id, p1!.id]);
    s().addDimension("hDistance");
    s().setSelection([p0!.id, p1!.id]);
    s().addDimension("vDistance");
    expect(s().result!.verdict).toBe("well-constrained");
    // A third (distance) dimension would over-constrain → it becomes driven.
    s().setSelection([p0!.id, p1!.id]);
    s().addDimension("distance");
    const dist = s().model.constraints.find((c) => c.kind === "distance");
    expect(dist && "driven" in dist && dist.driven).toBe(true);
    expect(s().result!.verdict).not.toBe("over-constrained");
  });

  it("applies an inferred constraint via clickAt and re-solves", () => {
    s().setTool("line");
    s().clickAt(0, 0);
    // Near-horizontal segment with an inferred horizontal constraint.
    s().clickAt(0.05, 0.0005, { constraint: { kind: "horizontal" } });
    expect(s().model.constraints.some((c) => c.kind === "horizontal")).toBe(true);
    // The solver flattened the segment to exactly horizontal.
    const pts = s().model.points;
    expect(pts[1]!.v).toBeCloseTo(pts[0]!.v, 6);
  });
});
