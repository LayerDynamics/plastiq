// joint lowering — SMOKE tests.

import { describe, expect, it } from "vitest";

import { isLowerable, lowerJoints, makeJoint } from "./joints.js";

describe("joint lowering — smoke", () => {
  it("makeJoint / isLowerable / lowerJoints run cleanly", () => {
    const j = makeJoint("revolute", 0, 1, { origin: [0, 0, 0], axis: [0, 0, 1] });
    expect(typeof isLowerable(j.kind)).toBe("boolean");
    const cs = lowerJoints([{ joint: j, bodyA: "a", bodyB: "b" }]);
    expect(cs).toHaveLength(1);
    expect(cs[0]!.kind).toBe("hinge");
  });
});
