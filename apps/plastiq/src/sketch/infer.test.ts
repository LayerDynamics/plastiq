import { describe, expect, it } from "vitest";
import { lineHint, nearestSnap, segmentHint } from "./infer.js";
import { circumcircle, type SketchModel } from "./model.js";
import { toScreen, type View2D } from "./transform2d.js";

// A stand-in camera projection. `nearestSnap` now takes a projector (sketch point
// → pixels through the live camera) instead of a fixed 2D view; a plain scale+pan
// is still a perfectly valid projector, so these keep exercising the snap logic
// with arithmetic that is easy to read.
const view: View2D = { scale: 1000, panX: 400, panY: 300 };
const project = (uv: readonly [number, number]): { x: number; y: number } =>
  toScreen(view, { u: uv[0], v: uv[1] });
/** The cursor in both frames, as the sketcher supplies it. */
const at = (px: { x: number; y: number }): { uv: { u: number; v: number }; px: { x: number; y: number } } => ({
  uv: { u: (px.x - view.panX) / view.scale, v: -(px.y - view.panY) / view.scale },
  px,
});

const model: SketchModel = {
  plane: "XY",
  points: [{ id: "p1", u: 0.05, v: 0.02 }],
  entities: [],
  constraints: [],
};

describe("nearestSnap — origin / endpoint / grid (FR-17)", () => {
  it("snaps to the origin when the cursor is near it", () => {
    const near = toScreen(view, { u: 0, v: 0 });
    const snap = nearestSnap(model, project, at({ x: near.x + 3, y: near.y - 2 }));
    expect(snap.kind).toBe("origin");
    expect(snap.u).toBe(0);
    expect(snap.v).toBe(0);
  });

  it("snaps to an existing point and returns its id (true connection)", () => {
    const near = toScreen(view, { u: 0.05, v: 0.02 });
    const snap = nearestSnap(model, project, at({ x: near.x - 4, y: near.y + 1 }));
    expect(snap.kind).toBe("point");
    expect(snap.pointId).toBe("p1");
    expect(snap.u).toBeCloseTo(0.05, 9);
  });

  it("falls back to the nearest grid intersection when nothing is close", () => {
    const snap = nearestSnap(model, project, at({ x: 123, y: 217 }));
    expect(snap.kind).toBe("grid");
    // grid-snapped to a multiple of the grid step.
    const step = snap.u === 0 ? 1 : snap.u;
    expect(Number.isFinite(step)).toBe(true);
  });
});

describe("nearestSnap — midpoint + centre (FR-17)", () => {
  it("snaps to the midpoint of a line segment", () => {
    const m: SketchModel = {
      plane: "XY",
      points: [
        { id: "a", u: 0, v: 0 },
        { id: "b", u: 0.1, v: 0 },
      ],
      entities: [{ id: "l0", kind: "line", a: "a", b: "b" }],
      constraints: [],
    };
    const mid = toScreen(view, { u: 0.05, v: 0 });
    const snap = nearestSnap(m, project, at({ x: mid.x + 2, y: mid.y - 1 }));
    expect(snap.kind).toBe("midpoint");
    expect(snap.u).toBeCloseTo(0.05, 9);
    expect(snap.v).toBeCloseTo(0, 9);
  });

  it("snaps to the centre of an arc (computed, not a stored point)", () => {
    const m: SketchModel = {
      plane: "XY",
      points: [
        { id: "a", u: 0, v: 0 },
        { id: "b", u: 0.1, v: 0 },
        { id: "t", u: 0.05, v: 0.05 },
      ],
      entities: [{ id: "e0", kind: "arc", a: "a", b: "b", through: "t" }],
      constraints: [],
    };
    const cc = circumcircle([0, 0], [0.1, 0], [0.05, 0.05])!;
    const centrePx = toScreen(view, { u: cc.u, v: cc.v });
    const snap = nearestSnap(m, project, at({ x: centrePx.x - 2, y: centrePx.y + 2 }));
    expect(snap.kind).toBe("center");
    expect(snap.u).toBeCloseTo(cc.u, 9);
    expect(snap.v).toBeCloseTo(cc.v, 9);
  });
});

describe("segmentHint — H/V + parallel/perpendicular (FR-17)", () => {
  // An existing line at ~30°.
  const m: SketchModel = {
    plane: "XY",
    points: [
      { id: "a", u: 0, v: 0 },
      { id: "b", u: 0.1, v: 0.057735 }, // tan30°
    ],
    entities: [{ id: "ref", kind: "line", a: "a", b: "b" }],
    constraints: [],
  };

  it("prefers H/V when the segment is axis-aligned", () => {
    const h = segmentHint(m, { u: 0.2, v: 0 }, { u: 0.3, v: 0.0005 })!;
    expect(h.glyph).toBe("H");
    expect(h.constraint).toEqual({ kind: "horizontal" });
  });

  it("infers parallel to a nearby line and names the reference", () => {
    const h = segmentHint(m, { u: 0.2, v: 0 }, { u: 0.3, v: 0.057735 })!;
    expect(h.glyph).toBe("∥");
    expect(h.constraint).toEqual({ kind: "parallel", refLine: "ref" });
  });

  it("infers perpendicular to a nearby line", () => {
    // 30° + 90° = 120°: direction (cos120, sin120).
    const h = segmentHint(
      m,
      { u: 0, v: 0 },
      { u: 0.1 * Math.cos((120 * Math.PI) / 180), v: 0.1 * Math.sin((120 * Math.PI) / 180) },
    )!;
    expect(h.glyph).toBe("⟂");
    expect(h.constraint).toEqual({ kind: "perpendicular", refLine: "ref" });
  });

  it("returns null for a free diagonal unrelated to any edge", () => {
    expect(segmentHint(m, { u: 0, v: 0 }, { u: 0.1, v: 0.02 })).toBeNull();
  });

  it("H/V wins over tangent for an axis-aligned segment that also grazes a circle", () => {
    const mc: SketchModel = {
      plane: "XY",
      points: [{ id: "cc", u: 0.05, v: 0.02 }],
      entities: [{ id: "circ", kind: "circle", center: "cc", radius: 0.02 }],
      constraints: [],
    };
    // A horizontal line at y=0 grazes the circle (centre y=0.02, r=0.02), but the
    // stronger axis relation takes priority.
    expect(segmentHint(mc, { u: 0, v: 0 }, { u: 0.1, v: 0 })!.glyph).toBe("H");
  });

  it("infers tangent for an off-axis grazing line", () => {
    const mc: SketchModel = {
      plane: "XY",
      points: [{ id: "cc", u: 0, v: 0 }],
      entities: [{ id: "circ", kind: "circle", center: "cc", radius: 0.02 }],
      constraints: [],
    };
    // Line offset so its perpendicular distance from the origin ≈ 0.02, tilted 20°.
    const ang = (20 * Math.PI) / 180;
    const nx = -Math.sin(ang);
    const ny = Math.cos(ang); // unit normal
    const off = 0.02;
    const base = { u: nx * off, v: ny * off };
    const dir = { u: Math.cos(ang), v: Math.sin(ang) };
    const h = segmentHint(mc, base, { u: base.u + dir.u * 0.1, v: base.v + dir.v * 0.1 })!;
    expect(h.glyph).toBe("T");
    expect(h.constraint).toEqual({ kind: "tangent", circle: "circ" });
  });
});

describe("lineHint — H/V inference (FR-17)", () => {
  it("flags a near-horizontal segment", () => {
    expect(lineHint({ u: 0, v: 0 }, { u: 0.05, v: 0.001 })).toBe("horizontal");
  });
  it("flags a near-vertical segment", () => {
    expect(lineHint({ u: 0, v: 0 }, { u: 0.001, v: 0.05 })).toBe("vertical");
  });
  it("returns null for a clear diagonal", () => {
    expect(lineHint({ u: 0, v: 0 }, { u: 0.05, v: 0.05 })).toBeNull();
  });
});

describe("degenerate (near-zero-length) segments — epsilon guards", () => {
  it("lineHint: a 1e-12-long axis-direction segment yields NO hint (was: H/V)", () => {
    // Pre-epsilon, `du !== 0` let float noise through: these returned
    // "horizontal"/"vertical" for segments that are really just a point.
    expect(lineHint({ u: 0, v: 0 }, { u: 1e-12, v: 0 })).toBeNull();
    expect(lineHint({ u: 0, v: 0 }, { u: 0, v: 1e-12 })).toBeNull();
  });

  it("lineHint: an exactly-zero segment still yields no hint", () => {
    expect(lineHint({ u: 0.02, v: 0.03 }, { u: 0.02, v: 0.03 })).toBeNull();
  });

  it("segmentHint: a 1e-12 noise segment yields no spurious tangent (no ~0 division)", () => {
    const m: SketchModel = {
      plane: "XY",
      points: [{ id: "c", u: 0.05, v: 0.05 }],
      entities: [{ id: "circ", kind: "circle", center: "c", radius: 0.0224 }],
      constraints: [],
    };
    // Float-noise direction (1,2) from the origin: the infinite line through it
    // passes ≈0.02236 from the centre — within 5% of r. The pre-epsilon code
    // divided the cross product by len ≈ 2.24e-12 and reported a tangent hint
    // for a segment that is really just a point.
    expect(segmentHint(m, { u: 0, v: 0 }, { u: 1e-12, v: 2e-12 })).toBeNull();
  });

  it("segmentHint: an exactly-zero segment still yields no hint", () => {
    const m: SketchModel = { plane: "XY", points: [], entities: [], constraints: [] };
    expect(segmentHint(m, { u: 0.01, v: 0.01 }, { u: 0.01, v: 0.01 })).toBeNull();
  });
});
