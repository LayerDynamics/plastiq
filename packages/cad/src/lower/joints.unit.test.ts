// joint lowering — UNIT tests: each function's exact contract.

import { describe, expect, it } from "vitest";

import { isLowerable, lowerJoints, makeJoint, type JointBinding } from "./joints.js";
import type { JointKind } from "../assembly/solver.js";

describe("joint lowering (unit)", () => {
  it("makeJoint carries kind + frame, ignoring the parent/child index args", () => {
    const j = makeJoint("revolute", 0, 1, { origin: [1, 2, 3], axis: [0, 0, 1] });
    expect(j.kind).toBe("revolute");
    expect(j.origin).toEqual([1, 2, 3]);
    expect(j.axis).toEqual([0, 0, 1]);
  });

  it("isLowerable is true for EVERY current joint kind (the full vocabulary lowers)", () => {
    const all: JointKind[] = ["revolute", "prismatic", "cylindrical", "ball", "planar", "fixed"];
    for (const k of all) expect(isLowerable(k)).toBe(true);
  });

  it("lowerJoints maps every kind to its manifest constraint, copying origin/axis + bodies", () => {
    const mapping: [JointKind, string][] = [
      ["revolute", "hinge"],
      ["prismatic", "slider"],
      ["cylindrical", "cylindrical"],
      ["ball", "ball"],
      ["planar", "planar"],
      ["fixed", "fixed"],
    ];
    const bindings: JointBinding[] = mapping.map(([kind], i) => ({
      joint: makeJoint(kind, 0, 1, { origin: [i, 0, 0], axis: [0, 1, 0] }),
      bodyA: "a",
      bodyB: `b${i}`,
    }));
    const cs = lowerJoints(bindings);
    expect(cs).toHaveLength(6);
    mapping.forEach(([, lowered], i) => {
      expect(cs[i]).toEqual({
        kind: lowered,
        bodyA: "a",
        bodyB: `b${i}`,
        origin: [i, 0, 0],
        axis: [0, 1, 0],
      });
    });
  });
});
