import { describe, expect, it } from "vitest";

import type { PlaneSegment2 } from "@plastiq/cad";
import { emptySketch } from "./model.js";
import { appendProjectedSegments } from "./projectEdges.js";

describe("appendProjectedSegments", () => {
  it("adds construction lines + fixed endpoints for each segment", () => {
    const segs: PlaneSegment2[] = [
      { a: [0, 0], b: [0.05, 0] },
      { a: [0.05, 0], b: [0.05, 0.04] },
    ];
    const model = appendProjectedSegments(emptySketch("XY"), segs);
    // Coalesced shared corner → 3 points, 2 lines.
    expect(model.points).toHaveLength(3);
    expect(model.entities).toHaveLength(2);
    expect(model.points.every((p) => p.fixed === true)).toBe(true);
    expect(model.entities.every((e) => e.kind === "line" && e.construction === true)).toBe(true);
  });

  it("preserves existing model content", () => {
    const base = emptySketch("XY");
    base.points.push({ id: "p0", u: 1, v: 1 });
    base.entities.push({ id: "l0", kind: "line", a: "p0", b: "p0" });
    const model = appendProjectedSegments(base, [{ a: [0, 0], b: [0.01, 0] }]);
    expect(model.points.some((p) => p.id === "p0")).toBe(true);
    expect(model.entities.some((e) => e.id === "l0")).toBe(true);
    expect(model.entities).toHaveLength(2);
  });

  it("is a no-op for an empty segment list", () => {
    const base = emptySketch("XY");
    expect(appendProjectedSegments(base, [])).toBe(base);
  });

  it("honours construction: false and fixed: false", () => {
    const model = appendProjectedSegments(
      emptySketch(),
      [{ a: [0, 0], b: [0.02, 0] }],
      { construction: false, fixed: false },
    );
    expect(model.entities[0]!.construction).toBeUndefined();
    expect(model.points[0]!.fixed).toBeUndefined();
  });

  it("uses a custom makeId factory", () => {
    let n = 0;
    const model = appendProjectedSegments(
      emptySketch(),
      [{ a: [0, 0], b: [1, 0] }],
      { makeId: (p) => `${p}_${++n}` },
    );
    expect(model.points.map((p) => p.id)).toEqual(["p_1", "p_2"]);
    expect(model.entities[0]!.id).toBe("e_3");
  });
});
