import { describe, expect, it } from "vitest";
import { drawDims, drawFields, liveValues, resolveCursor, type CommitContext } from "./drawInput.js";

const ids = (() => {
  let n = 0;
  return () => `c${++n}`;
})();

describe("drawFields — fields per tool/step", () => {
  it("first click of any tool places the anchor by X/Y", () => {
    for (const t of ["line", "rectangle", "circle", "polygon", "slot", "spline"] as const) {
      expect(drawFields(t, 0).map((f) => f.key)).toEqual(["x", "y"]);
    }
  });
  it("shape-defining click exposes each tool's natural fields", () => {
    expect(drawFields("line", 1).map((f) => f.key)).toEqual(["length", "angle"]);
    expect(drawFields("rectangle", 1).map((f) => f.key)).toEqual(["width", "height"]);
    expect(drawFields("rectCenter", 1).map((f) => f.key)).toEqual(["width", "height"]);
    expect(drawFields("circle", 1).map((f) => f.key)).toEqual(["radius"]);
    // precise-X/Y tools keep coordinate entry on later clicks
    expect(drawFields("spline", 2).map((f) => f.key)).toEqual(["x", "y"]);
    expect(drawFields("arc3", 1).map((f) => f.key)).toEqual(["x", "y"]);
  });
  it("angle is in degrees, lengths in mm", () => {
    expect(drawFields("line", 1).find((f) => f.key === "angle")!.unit).toBe("deg");
    expect(drawFields("line", 1).find((f) => f.key === "length")!.unit).toBe("mm");
  });
});

describe("liveValues — values the cursor currently implies", () => {
  it("line: length + angle from the anchor to the cursor", () => {
    const v = liveValues("line", 1, [{ u: 0, v: 0 }], { u: 0.03, v: 0.03 });
    expect(v[0]).toBeCloseTo(Math.hypot(0.03, 0.03), 9); // length
    expect(v[1]).toBeCloseTo(Math.PI / 4, 9); // 45°
  });
  it("rectangle width/height are |Δ|; rectCenter doubles them (full extent)", () => {
    expect(liveValues("rectangle", 1, [{ u: 0, v: 0 }], { u: 0.04, v: -0.02 })).toEqual([0.04, 0.02]);
    expect(liveValues("rectCenter", 1, [{ u: 0, v: 0 }], { u: 0.04, v: -0.02 })).toEqual([0.08, 0.04]);
  });
  it("circle: radius is the cursor distance from the centre", () => {
    expect(liveValues("circle", 1, [{ u: 0, v: 0 }], { u: 0, v: 0.05 })[0]).toBeCloseTo(0.05, 9);
  });
});

describe("resolveCursor — typed values → exact world point", () => {
  it("line: typed length+angle land the endpoint exactly", () => {
    const p = resolveCursor("line", 1, [{ u: 0, v: 0 }], { u: 1, v: 0 }, [0.05, Math.PI / 6]);
    expect(p.u).toBeCloseTo(0.05 * Math.cos(Math.PI / 6), 9);
    expect(p.v).toBeCloseTo(0.05 * Math.sin(Math.PI / 6), 9);
  });
  it("line: a null field falls back to the cursor's live value", () => {
    // length typed, angle live (cursor straight up) → point at (0, 0.05)
    const p = resolveCursor("line", 1, [{ u: 0, v: 0 }], { u: 0, v: 1 }, [0.05, null]);
    expect(p.u).toBeCloseTo(0, 6);
    expect(p.v).toBeCloseTo(0.05, 6);
  });
  it("rectangle: typed W/H keep the side (sign) the cursor is on", () => {
    const p = resolveCursor("rectangle", 1, [{ u: 0, v: 0 }], { u: -1, v: 1 }, [0.04, 0.02]);
    expect(p.u).toBeCloseTo(-0.04, 9); // cursor left of anchor → negative
    expect(p.v).toBeCloseTo(0.02, 9);
  });
  it("rectCenter: typed full W/H resolve the corner at ±half from the centre", () => {
    const p = resolveCursor("rectCenter", 1, [{ u: 0, v: 0 }], { u: 1, v: 1 }, [0.08, 0.04]);
    expect(p.u).toBeCloseTo(0.04, 9);
    expect(p.v).toBeCloseTo(0.02, 9);
  });
  it("X/Y tool: typed coords place the point absolutely", () => {
    const p = resolveCursor("spline", 1, [{ u: 0, v: 0 }], { u: 9, v: 9 }, [0.012, 0.034]);
    expect(p).toEqual({ u: 0.012, v: 0.034 });
  });
});

describe("drawDims — typed fields become driving dimensions", () => {
  const base = (over: Partial<CommitContext>): CommitContext => ({
    tool: "line",
    fields: drawFields("line", 1),
    values: [null, null],
    anchorPointIds: ["pStart"],
    createdPointIds: ["pEnd"],
    createdEntityIds: ["eLine"],
    mkId: ids,
    ...over,
  });

  it("line: typed length → distance dim; typed angle → lineAngle dim", () => {
    const dims = drawDims(base({ values: [0.05, Math.PI / 6] }));
    expect(dims.map((d) => d.kind).sort()).toEqual(["distance", "lineAngle"]);
    const d = dims.find((x) => x.kind === "distance")!;
    expect(d).toMatchObject({ a: "pStart", b: "pEnd", value: 0.05 });
    const la = dims.find((x) => x.kind === "lineAngle")!;
    expect(la).toMatchObject({ line: "eLine", value: Math.PI / 6 });
  });

  it("line: only the typed field is dimensioned (live field adds nothing)", () => {
    expect(drawDims(base({ values: [0.05, null] })).map((d) => d.kind)).toEqual(["distance"]);
    expect(drawDims(base({ values: [null, null] }))).toEqual([]);
  });

  it("rectangle: typed W/H → hDistance + vDistance on the corners", () => {
    const dims = drawDims({
      tool: "rectangle",
      fields: drawFields("rectangle", 1),
      values: [0.04, 0.02],
      anchorPointIds: ["A"],
      createdPointIds: ["B", "C", "D"],
      createdEntityIds: ["l1", "l2", "l3", "l4"],
      mkId: ids,
    });
    expect(dims.find((d) => d.kind === "hDistance")).toMatchObject({ a: "A", b: "B", value: 0.04 });
    expect(dims.find((d) => d.kind === "vDistance")).toMatchObject({ a: "B", b: "C", value: 0.02 });
  });

  it("circle: typed radius → radius dim on the circle entity", () => {
    const dims = drawDims({
      tool: "circle",
      fields: drawFields("circle", 1),
      values: [0.03],
      anchorPointIds: ["center"],
      createdPointIds: [],
      createdEntityIds: ["circ"],
      mkId: ids,
    });
    expect(dims).toHaveLength(1);
    expect(dims[0]).toMatchObject({ kind: "radius", circle: "circ", value: 0.03 });
  });

  it("precise-X/Y tools place exactly but add no dimension", () => {
    const dims = drawDims({
      tool: "spline",
      fields: drawFields("spline", 1),
      values: [0.01, 0.02],
      anchorPointIds: [],
      createdPointIds: ["p"],
      createdEntityIds: [],
      mkId: ids,
    });
    expect(dims).toEqual([]);
  });
});
