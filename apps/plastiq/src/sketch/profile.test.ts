import { describe, expect, it } from "vitest";
import { extractProfile, isProfile, type Profile } from "./profile.js";
import type { SketchModel } from "./model.js";

function rect(): SketchModel {
  return {
    plane: "XY",
    points: [
      { id: "a", u: 0, v: 0 },
      { id: "b", u: 0.05, v: 0 },
      { id: "c", u: 0.05, v: 0.03 },
      { id: "d", u: 0, v: 0.03 },
    ],
    entities: [
      { id: "l0", kind: "line", a: "a", b: "b" },
      { id: "l1", kind: "line", a: "b", b: "c" },
      { id: "l2", kind: "line", a: "c", b: "d" },
      { id: "l3", kind: "line", a: "d", b: "a" },
    ],
    constraints: [],
  };
}

/** Distinct [u,v] vertices of a loop profile (the walk's closing edge lands back
 * on `start`, so the trailing duplicate is dropped). */
function loopVerts(p: Profile): string[] {
  if (p.kind !== "loop") throw new Error("not a loop");
  const all = [p.start, ...p.segments.map((s) => s.to)];
  const last = all[all.length - 1]!;
  if (all.length > 1 && last[0] === p.start[0] && last[1] === p.start[1]) all.pop();
  return all.map((c) => c.join(","));
}

describe("extractProfile — closed line loop → ordered profile (FR-21)", () => {
  it("returns the 4 rectangle corners as a closed loop", () => {
    const p = extractProfile(rect())!;
    expect(p.kind).toBe("loop");
    const verts = loopVerts(p);
    expect(verts).toHaveLength(4);
    // Every rectangle corner present (order may start anywhere on the loop).
    expect(new Set(verts)).toEqual(new Set(["0,0", "0.05,0", "0.05,0.03", "0,0.03"]));
  });

  it("excludes construction geometry from the profile", () => {
    const m = rect();
    m.entities.push(
      { id: "p0", kind: "line", a: "a", b: "c", construction: true }, // a diagonal guide
    );
    // The diagonal would make corner degrees 3; being construction, it's ignored.
    expect(loopVerts(extractProfile(m)!)).toHaveLength(4);
  });

  it("returns null for an open chain (no closed loop)", () => {
    const m = rect();
    m.entities = m.entities.slice(0, 3); // drop the closing edge
    expect(extractProfile(m)).toBeNull();
  });

  it("returns null when there are too few segments", () => {
    const m: SketchModel = {
      plane: "XY",
      points: [
        { id: "a", u: 0, v: 0 },
        { id: "b", u: 0.05, v: 0 },
      ],
      entities: [{ id: "l0", kind: "line", a: "a", b: "b" }],
      constraints: [],
    };
    expect(extractProfile(m)).toBeNull();
  });
});

describe("extractProfile — circle profile (FR-16 true curved edge)", () => {
  function circleModel(): SketchModel {
    return {
      plane: "XY",
      points: [{ id: "c", u: 0.02, v: 0.01 }],
      entities: [{ id: "e0", kind: "circle", center: "c", radius: 0.005 }],
      constraints: [],
    };
  }

  it("a lone circle becomes a circle profile carrying centre + radius", () => {
    const p = extractProfile(circleModel())!;
    expect(p.kind).toBe("circle");
    if (p.kind !== "circle") throw new Error("expected circle");
    expect(p.center).toEqual([0.02, 0.01]);
    expect(p.radius).toBe(0.005);
  });

  it("ignores a construction circle (no buildable profile)", () => {
    const m = circleModel();
    m.entities = [{ id: "e0", kind: "circle", center: "c", radius: 0.005, construction: true }];
    expect(extractProfile(m)).toBeNull();
  });

  it("a circle mixed with lines becomes a loop with a hole (C5 / T11)", () => {
    const m = rect();
    m.points.push({ id: "cc", u: 0.025, v: 0.015 });
    m.entities.push({ id: "e0", kind: "circle", center: "cc", radius: 0.005 });
    const p = extractProfile(m)!;
    expect(p.kind).toBe("loop");
    if (p.kind === "loop") {
      expect(p.holes).toHaveLength(1);
      const hole = p.holes![0]!;
      expect(hole.kind).toBe("circle");
      if (hole.kind === "circle") {
        expect(hole.radius).toBe(0.005);
        expect(hole.center).toEqual([0.025, 0.015]);
      }
    }
  });

  // §2.7 — a plate with a RECTANGULAR hole (two disjoint line loops). The old
  // extractor consumed a single cycle, found leftover edges, and returned null →
  // the WHOLE sketch failed with "no buildable profile" the moment a hole was
  // drawn. Now the inner loop is classified as a hole by even-odd containment.
  it("a rectangle inside a rectangle becomes a loop with an inner-loop hole", () => {
    const m = rect(); // outer [0,0]–[0.05,0.03]
    // Inner rectangle [0.01,0.01]–[0.04,0.02], fully inside the outer.
    m.points.push(
      { id: "ia", u: 0.01, v: 0.01 },
      { id: "ib", u: 0.04, v: 0.01 },
      { id: "ic", u: 0.04, v: 0.02 },
      { id: "id", u: 0.01, v: 0.02 },
    );
    m.entities.push(
      { id: "il0", kind: "line", a: "ia", b: "ib" },
      { id: "il1", kind: "line", a: "ib", b: "ic" },
      { id: "il2", kind: "line", a: "ic", b: "id" },
      { id: "il3", kind: "line", a: "id", b: "ia" },
    );
    const p = extractProfile(m);
    expect(p, "a plate with a hole must still be buildable (not null)").not.toBeNull();
    expect(p!.kind).toBe("loop");
    if (p!.kind === "loop") {
      // The OUTER boundary is the profile; the inner rectangle is a loop hole.
      expect(loopVerts(p!)).toHaveLength(4);
      expect(p!.holes).toHaveLength(1);
      const hole = p!.holes![0]!;
      expect(hole.kind).toBe("loop");
      if (hole.kind === "loop") {
        // The hole loop carries the 4 inner corners.
        const hv = new Set([hole.start, ...hole.segments.map((s) => s.to)].map((c) => c.join(",")));
        for (const c of ["0.01,0.01", "0.04,0.01", "0.04,0.02", "0.01,0.02"])
          expect(hv.has(c)).toBe(true);
      }
    }
  });

  it("picks the OUTER loop as the boundary regardless of which loop was drawn first", () => {
    // Same as above but the inner loop's entities come FIRST — classification must
    // be by containment, not draw order.
    const m: SketchModel = {
      plane: "XY",
      points: [
        { id: "ia", u: 0.01, v: 0.01 },
        { id: "ib", u: 0.04, v: 0.01 },
        { id: "ic", u: 0.04, v: 0.02 },
        { id: "id", u: 0.01, v: 0.02 },
        { id: "a", u: 0, v: 0 },
        { id: "b", u: 0.05, v: 0 },
        { id: "c", u: 0.05, v: 0.03 },
        { id: "d", u: 0, v: 0.03 },
      ],
      entities: [
        { id: "il0", kind: "line", a: "ia", b: "ib" },
        { id: "il1", kind: "line", a: "ib", b: "ic" },
        { id: "il2", kind: "line", a: "ic", b: "id" },
        { id: "il3", kind: "line", a: "id", b: "ia" },
        { id: "l0", kind: "line", a: "a", b: "b" },
        { id: "l1", kind: "line", a: "b", b: "c" },
        { id: "l2", kind: "line", a: "c", b: "d" },
        { id: "l3", kind: "line", a: "d", b: "a" },
      ],
      constraints: [],
    };
    const p = extractProfile(m);
    expect(p).not.toBeNull();
    if (p!.kind === "loop") {
      // Outer boundary spans the full 0.05×0.03 extent.
      const us = [p!.start[0], ...p!.segments.map((s) => s.to[0])];
      expect(Math.max(...us)).toBeCloseTo(0.05, 9);
      expect(p!.holes).toHaveLength(1);
    }
  });

  it("returns null for TWO disjoint outer regions (honest failure, never a dropped region)", () => {
    // Two side-by-side rectangles that don't contain each other — this profile
    // shape holds ONE outer boundary, so it declines rather than silently drop one.
    const m: SketchModel = {
      plane: "XY",
      points: [
        { id: "a", u: 0, v: 0 },
        { id: "b", u: 0.02, v: 0 },
        { id: "c", u: 0.02, v: 0.02 },
        { id: "d", u: 0, v: 0.02 },
        { id: "e", u: 0.05, v: 0 },
        { id: "f", u: 0.07, v: 0 },
        { id: "g", u: 0.07, v: 0.02 },
        { id: "h", u: 0.05, v: 0.02 },
      ],
      entities: [
        { id: "l0", kind: "line", a: "a", b: "b" },
        { id: "l1", kind: "line", a: "b", b: "c" },
        { id: "l2", kind: "line", a: "c", b: "d" },
        { id: "l3", kind: "line", a: "d", b: "a" },
        { id: "m0", kind: "line", a: "e", b: "f" },
        { id: "m1", kind: "line", a: "f", b: "g" },
        { id: "m2", kind: "line", a: "g", b: "h" },
        { id: "m3", kind: "line", a: "h", b: "e" },
      ],
      constraints: [],
    };
    expect(extractProfile(m)).toBeNull();
  });

  it("rejects a circle whose centre is outside the outer loop (C9 containment)", () => {
    const m = rect(); // [0,0]–[0.05,0.03]
    m.points.push({ id: "out", u: 0.1, v: 0.1 }); // outside
    m.entities.push({ id: "e0", kind: "circle", center: "out", radius: 0.005 });
    const p = extractProfile(m)!;
    expect(p.kind).toBe("loop");
    if (p.kind === "loop") expect(p.holes ?? []).toHaveLength(0);
  });
});

describe("extractProfile — exact ellipse (§13.3)", () => {
  it("derives the solver-native centre/focus/minor-radius profile", () => {
    const m: SketchModel = {
      plane: "XY",
      points: [
        { id: "c", u: 0.01, v: 0.02 },
        { id: "f", u: 0.05, v: 0.02 },
      ],
      entities: [{ id: "e", kind: "ellipse", center: "c", focus1: "f", radmin: 0.02 }],
      constraints: [],
    };
    expect(extractProfile(m)).toEqual({
      kind: "ellipse",
      center: [0.01, 0.02],
      focus1: [0.05, 0.02],
      minorRadius: 0.02,
    });
  });
});

describe("extractProfile — line + arc loop (FR-16 arc tool)", () => {
  it("walks a half-disc (diameter line + semicircular arc) into typed segments", () => {
    // a(−r,0) —line— b(r,0) —arc through (0,r)— back to a.
    const m: SketchModel = {
      plane: "XY",
      points: [
        { id: "a", u: -0.05, v: 0 },
        { id: "b", u: 0.05, v: 0 },
        { id: "t", u: 0, v: 0.05 },
      ],
      entities: [
        { id: "l0", kind: "line", a: "a", b: "b" },
        { id: "e0", kind: "arc", a: "b", b: "a", through: "t" },
      ],
      constraints: [],
    };
    const p = extractProfile(m)!;
    expect(p.kind).toBe("loop");
    if (p.kind !== "loop") throw new Error("expected loop");
    expect(p.start).toEqual([-0.05, 0]);
    expect(p.segments).toHaveLength(2);
    expect(p.segments[0]).toEqual({ kind: "line", to: [0.05, 0] });
    expect(p.segments[1]).toEqual({ kind: "arc", through: [0, 0.05], to: [-0.05, 0] });
  });
});

describe("extractProfile — line + spline loop (FR-16 spline tool)", () => {
  it("walks a loop closed by a spline into a typed spline segment", () => {
    // a —line— b, then a spline from b through m1,m2 back to a.
    const m: SketchModel = {
      plane: "XY",
      points: [
        { id: "a", u: 0, v: 0 },
        { id: "b", u: 0.1, v: 0 },
        { id: "m1", u: 0.08, v: 0.05 },
        { id: "m2", u: 0.02, v: 0.05 },
      ],
      entities: [
        { id: "l0", kind: "line", a: "a", b: "b" },
        { id: "e0", kind: "spline", points: ["b", "m1", "m2", "a"] },
      ],
      constraints: [],
    };
    const p = extractProfile(m)!;
    expect(p.kind).toBe("loop");
    if (p.kind !== "loop") throw new Error("expected loop");
    expect(p.segments).toHaveLength(2);
    expect(p.segments[0]).toEqual({ kind: "line", to: [0.1, 0] });
    const sp = p.segments[1]!;
    expect(sp.kind).toBe("spline");
    if (sp.kind !== "spline") throw new Error("expected spline");
    // Interpolation points after the start (b), ending back on a.
    expect(sp.through).toEqual([
      [0.08, 0.05],
      [0.02, 0.05],
      [0, 0],
    ]);
    expect(sp.to).toEqual([0, 0]);
  });
});

describe("isProfile — validates a deserialized (persisted) payload", () => {
  it("accepts a well-formed loop, circle, and ellipse", () => {
    expect(
      isProfile({
        kind: "loop",
        start: [0, 0],
        segments: [
          { kind: "line", to: [1, 0] },
          { kind: "arc", through: [0.5, 0.5], to: [0, 0] },
        ],
      }),
    ).toBe(true);
    expect(isProfile({ kind: "circle", center: [0, 0], radius: 0.01 })).toBe(true);
    expect(
      isProfile({ kind: "ellipse", center: [0, 0], focus1: [0.04, 0], minorRadius: 0.02 }),
    ).toBe(true);
  });

  it("rejects malformed / legacy payloads", () => {
    expect(isProfile(null)).toBe(false);
    expect(isProfile({ kind: "circle", center: [0, 0], radius: 0 })).toBe(false);
    expect(isProfile({ kind: "loop", start: [0], segments: [] })).toBe(false);
    expect(isProfile([[0, 0]])).toBe(false); // the old bare point-array shape
  });
});
