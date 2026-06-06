import { describe, expect, it } from "vitest";
import { findClashes, type InstanceBox } from "./interference.js";

const box = (id: string, x0: number, x1: number): InstanceBox => ({
  id,
  min: [x0, 0, 0],
  max: [x1, 0.04, 0.03],
});

describe("findClashes — bounding-box interference", () => {
  it("reports a pair whose boxes overlap on every axis", () => {
    const clashes = findClashes([box("a", 0, 0.06), box("b", 0.04, 0.1)]); // x overlap 0.04..0.06
    expect(clashes).toEqual([{ a: "a", b: "b" }]);
  });

  it("does NOT report boxes separated on an axis (the default 80mm spacing)", () => {
    // Two 60 mm boxes 80 mm apart (addInstance's layout): 0..0.06 and 0.08..0.14.
    expect(findClashes([box("a", 0, 0.06), box("b", 0.08, 0.14)])).toEqual([]);
  });

  it("treats merely-touching boxes (zero penetration) as clear", () => {
    expect(findClashes([box("a", 0, 0.06), box("b", 0.06, 0.12)])).toEqual([]);
  });

  it("finds every clashing pair among three instances", () => {
    // a∩b and a∩c (a is wide), but b and c are far apart.
    const a: InstanceBox = { id: "a", min: [0, 0, 0], max: [0.3, 0.04, 0.03] };
    const b: InstanceBox = { id: "b", min: [0.05, 0, 0], max: [0.1, 0.04, 0.03] };
    const c: InstanceBox = { id: "c", min: [0.25, 0, 0], max: [0.32, 0.04, 0.03] };
    expect(findClashes([a, b, c])).toEqual([
      { a: "a", b: "b" },
      { a: "a", b: "c" },
    ]);
  });

  it("returns nothing for fewer than two instances", () => {
    expect(findClashes([box("solo", 0, 0.06)])).toEqual([]);
    expect(findClashes([])).toEqual([]);
  });
});
