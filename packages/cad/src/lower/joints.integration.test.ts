// joint lowering — INTEGRATION: the real flow — articulated joints pass the
// isLowerable filter (total for every current kind), then lower to manifest
// constraints (makeJoint → isLowerable filter → lowerJoints). Nothing is dropped:
// the full joint vocabulary has physics-layer equivalents.

import { describe, expect, it } from "vitest";

import { isLowerable, lowerJoints, makeJoint, type JointBinding } from "./joints.js";

describe("joint lowering — joints → constraints (integration)", () => {
  it("lowers the FULL joint vocabulary through the filter — nothing is dropped", () => {
    const all: JointBinding[] = [
      { joint: makeJoint("revolute", 0, 1, { origin: [0, 0, 0], axis: [0, 1, 0] }), bodyA: "base", bodyB: "arm" },
      { joint: makeJoint("ball", 1, 2, { origin: [0.1, 0, 0], axis: [0, 0, 1] }), bodyA: "arm", bodyB: "hand" },
      { joint: makeJoint("prismatic", 0, 3, { origin: [0, 0, 0], axis: [1, 0, 0] }), bodyA: "base", bodyB: "rail" },
      { joint: makeJoint("cylindrical", 0, 4, { origin: [0, 0, 0], axis: [1, 0, 0] }), bodyA: "base", bodyB: "shaft" },
      { joint: makeJoint("planar", 0, 5, { origin: [0, 0, 0.1], axis: [0, 0, 1] }), bodyA: "base", bodyB: "plate" },
      { joint: makeJoint("fixed", 0, 6, { origin: [0, 0, 0], axis: [0, 0, 1] }), bodyA: "base", bodyB: "mount" },
    ];
    const cs = lowerJoints(all.filter((b) => isLowerable(b.joint.kind)));
    expect(cs).toHaveLength(6); // every kind survives the filter
    expect(cs.map((c) => c.kind)).toEqual([
      "hinge",
      "ball",
      "slider",
      "cylindrical",
      "planar",
      "fixed",
    ]);
    expect(cs.map((c) => c.bodyB)).toEqual(["arm", "hand", "rail", "shaft", "plate", "mount"]);
  });
});
