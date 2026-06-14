// joint lowering — INTEGRATION: the real flow — articulated joints are filtered to
// the lowerable kinds, then lowered to manifest constraints (makeJoint → isLowerable
// filter → lowerJoints), with non-lowerable kinds dropped.

import { describe, expect, it } from "vitest";

import { isLowerable, lowerJoints, makeJoint, type JointBinding } from "./joints.js";

describe("joint lowering — joints → constraints (integration)", () => {
  it("keeps only lowerable joints and lowers them to hinge/fixed constraints", () => {
    const all: JointBinding[] = [
      { joint: makeJoint("revolute", 0, 1, { origin: [0, 0, 0], axis: [0, 1, 0] }), bodyA: "base", bodyB: "arm" },
      { joint: makeJoint("ball", 1, 2, { origin: [0.1, 0, 0], axis: [0, 0, 1] }), bodyA: "arm", bodyB: "hand" },
      { joint: makeJoint("fixed", 0, 3, { origin: [0, 0, 0], axis: [0, 0, 1] }), bodyA: "base", bodyB: "mount" },
    ];
    const cs = lowerJoints(all.filter((b) => isLowerable(b.joint.kind)));
    expect(cs).toHaveLength(2); // the "ball" joint was dropped
    expect(cs.map((c) => c.kind)).toEqual(["hinge", "fixed"]);
    expect(cs[0]!.bodyB).toBe("arm");
    expect(cs[1]!.bodyB).toBe("mount");
  });
});
