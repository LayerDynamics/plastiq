import { describe, expect, it } from "vitest";
import {
  applyJointLimits,
  jointDof,
  jointDofCount,
  JOINT_KINDS,
  makeJoint,
  withinJointLimits,
} from "./joint.js";

describe("articulated joints (FR-28)", () => {
  it("each joint kind has the textbook DOF split", () => {
    expect(jointDof("revolute")).toEqual({ translational: 0, rotational: 1 });
    expect(jointDof("prismatic")).toEqual({ translational: 1, rotational: 0 });
    expect(jointDof("cylindrical")).toEqual({ translational: 1, rotational: 1 });
    expect(jointDof("ball")).toEqual({ translational: 0, rotational: 3 });
    expect(jointDof("planar")).toEqual({ translational: 2, rotational: 1 });
    expect(jointDof("fixed")).toEqual({ translational: 0, rotational: 0 });
  });

  it("DOF counts: revolute/prismatic 1, cylindrical 2, ball/planar 3, fixed 0", () => {
    expect(jointDofCount("revolute")).toBe(1);
    expect(jointDofCount("prismatic")).toBe(1);
    expect(jointDofCount("cylindrical")).toBe(2);
    expect(jointDofCount("ball")).toBe(3);
    expect(jointDofCount("planar")).toBe(3);
    expect(jointDofCount("fixed")).toBe(0);
  });

  it("every advertised kind is covered by jointDof", () => {
    for (const k of JOINT_KINDS) {
      const d = jointDof(k);
      expect(d.translational + d.rotational).toBe(jointDofCount(k));
    }
  });

  it("stores the parent/child and joint frame", () => {
    const j = makeJoint(
      "revolute",
      0,
      1,
      { origin: [1, 2, 3], axis: [0, 0, 1] },
      { lower: -1, upper: 1 },
    );
    expect(j.parent).toBe(0);
    expect(j.child).toBe(1);
    expect(j.frame.origin).toEqual([1, 2, 3]);
    expect(j.frame.axis).toEqual([0, 0, 1]);
  });

  it("limits clamp the joint coordinate", () => {
    const j = makeJoint(
      "revolute",
      0,
      1,
      { origin: [0, 0, 0], axis: [0, 0, 1] },
      { lower: -1, upper: 1 },
    );
    expect(applyJointLimits(j, 2)).toBe(1);
    expect(applyJointLimits(j, -2)).toBe(-1);
    expect(applyJointLimits(j, 0.5)).toBe(0.5);
    expect(withinJointLimits(j, 0.5)).toBe(true);
    expect(withinJointLimits(j, 2)).toBe(false);
  });

  it("a joint with no limits is unbounded", () => {
    const j = makeJoint("prismatic", 0, 1, { origin: [0, 0, 0], axis: [1, 0, 0] });
    expect(applyJointLimits(j, 1e6)).toBe(1e6);
    expect(withinJointLimits(j, 1e6)).toBe(true);
  });

  it("inverted limits are rejected", () => {
    const j = makeJoint(
      "revolute",
      0,
      1,
      { origin: [0, 0, 0], axis: [0, 0, 1] },
      { lower: 1, upper: -1 },
    );
    expect(() => applyJointLimits(j, 0)).toThrow(/inverted/);
  });
});
