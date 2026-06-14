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

  it("isLowerable is true only for revolute and fixed", () => {
    expect(isLowerable("revolute")).toBe(true);
    expect(isLowerable("fixed")).toBe(true);
    for (const k of ["prismatic", "cylindrical", "ball", "planar"] as JointKind[]) {
      expect(isLowerable(k)).toBe(false);
    }
  });

  it("lowerJoints maps revolute→hinge and fixed→fixed, copying origin/axis + bodies", () => {
    const bindings: JointBinding[] = [
      { joint: makeJoint("revolute", 0, 1, { origin: [0, 0, 0], axis: [1, 0, 0] }), bodyA: "a", bodyB: "b" },
      { joint: makeJoint("fixed", 0, 1, { origin: [1, 0, 0], axis: [0, 1, 0] }), bodyA: "a", bodyB: "c" },
    ];
    const cs = lowerJoints(bindings);
    expect(cs[0]).toEqual({ kind: "hinge", bodyA: "a", bodyB: "b", origin: [0, 0, 0], axis: [1, 0, 0] });
    expect(cs[1]).toEqual({ kind: "fixed", bodyA: "a", bodyB: "c", origin: [1, 0, 0], axis: [0, 1, 0] });
  });
});
