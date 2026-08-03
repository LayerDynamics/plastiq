import { describe, expect, it } from "vitest";

import { emptySketch, type SketchModel } from "./model.js";
import { patternSketch } from "./patternSketch.js";

/** A horizontal line p0→p1 of length 0.05 with a horizontal constraint. */
function seedLine(): SketchModel {
  return {
    ...emptySketch("XY"),
    points: [
      { id: "p0", u: 0, v: 0, fixed: true },
      { id: "p1", u: 0.05, v: 0 },
    ],
    entities: [{ id: "l0", kind: "line", a: "p0", b: "p1" }],
    constraints: [{ id: "c0", kind: "horizontal", line: "l0" }],
  };
}

describe("patternSketch — linear", () => {
  it("count=1 returns the seed unchanged (no copies)", () => {
    const seed = seedLine();
    const r = patternSketch(seed, {
      kind: "linear",
      count: 1,
      direction: [1, 0],
      spacing: 0.1,
    });
    expect(r.createdEntityIds).toHaveLength(0);
    expect(r.model.entities).toHaveLength(1);
    expect(r.model.points).toHaveLength(2);
  });

  it("places N copies along direction with spacing and replicates constraints", () => {
    const seed = seedLine();
    const r = patternSketch(seed, {
      kind: "linear",
      count: 3,
      direction: [0, 1],
      spacing: 0.02,
    });
    // 1 seed line + 2 copies
    expect(r.createdEntityIds).toHaveLength(2);
    expect(r.model.entities.filter((e) => e.kind === "line")).toHaveLength(3);
    // 2 seed points + 2×2 copy points
    expect(r.model.points).toHaveLength(6);
    // horizontal constraint replicated twice
    expect(r.createdConstraintIds).toHaveLength(2);
    expect(r.model.constraints.filter((c) => c.kind === "horizontal")).toHaveLength(3);

    // Copy 1 endpoints shifted by (0, 0.02)
    const copy1 = r.model.entities.find((e) => e.id === r.createdEntityIds[0]!);
    expect(copy1?.kind).toBe("line");
    if (copy1?.kind !== "line") return;
    const a = r.model.points.find((p) => p.id === copy1.a)!;
    const b = r.model.points.find((p) => p.id === copy1.b)!;
    expect(a.u).toBeCloseTo(0, 12);
    expect(a.v).toBeCloseTo(0.02, 12);
    expect(b.u).toBeCloseTo(0.05, 12);
    expect(b.v).toBeCloseTo(0.02, 12);

    // Copy 2 at 0.04
    const copy2 = r.model.entities.find((e) => e.id === r.createdEntityIds[1]!);
    if (copy2?.kind !== "line") throw new Error("expected line");
    const a2 = r.model.points.find((p) => p.id === copy2.a)!;
    expect(a2.v).toBeCloseTo(0.04, 12);
  });

  it("unitizes a non-unit direction so spacing is the true step", () => {
    const seed = seedLine();
    const r = patternSketch(seed, {
      kind: "linear",
      count: 2,
      direction: [0, 2], // not unit
      spacing: 0.01,
    });
    const copy = r.model.entities.find((e) => e.id === r.createdEntityIds[0]!);
    if (copy?.kind !== "line") throw new Error("expected line");
    const a = r.model.points.find((p) => p.id === copy.a)!;
    expect(a.v).toBeCloseTo(0.01, 12); // not 0.02
  });

  it("rejects zero spacing for count > 1", () => {
    expect(() =>
      patternSketch(seedLine(), {
        kind: "linear",
        count: 2,
        direction: [1, 0],
        spacing: 0,
      }),
    ).toThrow(/spacing must be non-zero/);
  });

  it("rejects a zero direction", () => {
    expect(() =>
      patternSketch(seedLine(), {
        kind: "linear",
        count: 2,
        direction: [0, 0],
        spacing: 0.01,
      }),
    ).toThrow(/direction must be a non-zero vector/);
  });
});

describe("patternSketch — circular", () => {
  it("rotates a point about the origin by full-turn steps", () => {
    // Point at (0.03, 0) — a degenerate "circle" via its centre only is enough;
    // use a line from origin so we can check both endpoints.
    const seed: SketchModel = {
      ...emptySketch("XY"),
      points: [
        { id: "p0", u: 0.03, v: 0 },
        { id: "p1", u: 0.04, v: 0 },
      ],
      entities: [{ id: "l0", kind: "line", a: "p0", b: "p1" }],
      constraints: [],
    };
    const r = patternSketch(seed, {
      kind: "circular",
      count: 4,
      center: [0, 0],
      // full turn default → step = π/2
    });
    expect(r.createdEntityIds).toHaveLength(3);
    // Instance 1 at 90°: (0.03,0) → (0, 0.03)
    const c1 = r.model.entities.find((e) => e.id === r.createdEntityIds[0]!);
    if (c1?.kind !== "line") throw new Error("expected line");
    const a1 = r.model.points.find((p) => p.id === c1.a)!;
    expect(a1.u).toBeCloseTo(0, 12);
    expect(a1.v).toBeCloseTo(0.03, 12);
    // Instance 2 at 180°: (−0.03, 0)
    const c2 = r.model.entities.find((e) => e.id === r.createdEntityIds[1]!);
    if (c2?.kind !== "line") throw new Error("expected line");
    const a2 = r.model.points.find((p) => p.id === c2.a)!;
    expect(a2.u).toBeCloseTo(-0.03, 12);
    expect(a2.v).toBeCloseTo(0, 12);
  });

  it("partial angle uses count−1 steps (seed + last at ends)", () => {
    const seed: SketchModel = {
      ...emptySketch("XY"),
      points: [{ id: "p0", u: 1, v: 0 }],
      entities: [{ id: "c0", kind: "circle", center: "p0", radius: 0.01 }],
      constraints: [],
    };
    const r = patternSketch(seed, {
      kind: "circular",
      count: 3,
      center: [0, 0],
      angle: Math.PI, // 180° over 2 steps → 90° each
    });
    expect(r.createdEntityIds).toHaveLength(2);
    const e1 = r.model.entities.find((e) => e.id === r.createdEntityIds[0]!);
    if (e1?.kind !== "circle") throw new Error("expected circle");
    const p1 = r.model.points.find((p) => p.id === e1.center)!;
    expect(p1.u).toBeCloseTo(0, 12);
    expect(p1.v).toBeCloseTo(1, 12);
    const e2 = r.model.entities.find((e) => e.id === r.createdEntityIds[1]!);
    if (e2?.kind !== "circle") throw new Error("expected circle");
    const p2 = r.model.points.find((p) => p.id === e2.center)!;
    expect(p2.u).toBeCloseTo(-1, 12);
    expect(p2.v).toBeCloseTo(0, 12);
  });
});

describe("patternSketch — selection + constraint scope", () => {
  it("patterns only the requested entityIds", () => {
    const model: SketchModel = {
      ...emptySketch("XY"),
      points: [
        { id: "p0", u: 0, v: 0 },
        { id: "p1", u: 0.01, v: 0 },
        { id: "p2", u: 1, v: 1 },
        { id: "p3", u: 1.01, v: 1 },
      ],
      entities: [
        { id: "l0", kind: "line", a: "p0", b: "p1" },
        { id: "l1", kind: "line", a: "p2", b: "p3" },
      ],
      constraints: [],
    };
    const r = patternSketch(
      model,
      { kind: "linear", count: 2, direction: [0, 1], spacing: 0.05 },
      { entityIds: ["l0"] },
    );
    // Only l0 copied once → 3 lines total
    expect(r.model.entities.filter((e) => e.kind === "line")).toHaveLength(3);
    // l1 endpoints not duplicated
    expect(r.model.points.filter((p) => p.id === "p2" || p.id === "p3")).toHaveLength(2);
    expect(r.model.points).toHaveLength(6); // 4 seed + 2 copy of p0/p1
  });

  it("skips construction entities by default", () => {
    const model: SketchModel = {
      ...emptySketch("XY"),
      points: [
        { id: "p0", u: 0, v: 0 },
        { id: "p1", u: 0.01, v: 0 },
      ],
      entities: [{ id: "l0", kind: "line", a: "p0", b: "p1", construction: true }],
      constraints: [],
    };
    const r = patternSketch(model, {
      kind: "linear",
      count: 3,
      direction: [1, 0],
      spacing: 0.01,
    });
    expect(r.createdEntityIds).toHaveLength(0);
  });

  it("does not replicate constraints that cross outside the seed", () => {
    // l0 horizontal (internal) + equalLength to an outside line l1 — only horizontal replicates.
    const model: SketchModel = {
      ...emptySketch("XY"),
      points: [
        { id: "p0", u: 0, v: 0 },
        { id: "p1", u: 0.02, v: 0 },
        { id: "p2", u: 0, v: 1 },
        { id: "p3", u: 0.03, v: 1 },
      ],
      entities: [
        { id: "l0", kind: "line", a: "p0", b: "p1" },
        { id: "l1", kind: "line", a: "p2", b: "p3" },
      ],
      constraints: [
        { id: "cH", kind: "horizontal", line: "l0" },
        { id: "cE", kind: "equalLength", line1: "l0", line2: "l1" },
      ],
    };
    const r = patternSketch(
      model,
      { kind: "linear", count: 2, direction: [0, 1], spacing: 0.05 },
      { entityIds: ["l0"] },
    );
    // Only the internal horizontal is replicated (1 new), equalLength stays sole.
    expect(r.createdConstraintIds).toHaveLength(1);
    expect(r.model.constraints.filter((c) => c.kind === "equalLength")).toHaveLength(1);
    expect(r.model.constraints.filter((c) => c.kind === "horizontal")).toHaveLength(2);
  });
});
