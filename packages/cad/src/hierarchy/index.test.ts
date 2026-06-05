import { describe, expect, it } from "vitest";
import { length, quatFromAxisAngle, sub, type Vec3 } from "../math/index.js";
import { Component, composePlacement, IDENTITY_PLACEMENT, makeBody } from "./index.js";

function close(a: Vec3, b: Vec3, tol = 1e-12): void {
  expect(length(sub(a, b))).toBeLessThan(tol);
}

describe("placement composition", () => {
  it("offsets a child by the parent position", () => {
    const w = composePlacement(
      { position: [1, 0, 0], orientation: [0, 0, 0, 1] },
      { position: [0, 1, 0], orientation: [0, 0, 0, 1] },
    );
    close(w.position, [1, 1, 0]);
  });

  it("rotates the child position by the parent orientation", () => {
    // Parent rotated 90° about +Z maps child +Y → −X, then offset by parent pos.
    const w = composePlacement(
      { position: [1, 0, 0], orientation: quatFromAxisAngle([0, 0, 1], Math.PI / 2) },
      { position: [0, 1, 0], orientation: [0, 0, 0, 1] },
    );
    close(w.position, [0, 0, 0]); // [1,0,0] + rot90z([0,1,0]) = [1,0,0] + [-1,0,0]
  });
});

describe("Component / Body", () => {
  it("counts bodies across the subtree", () => {
    const root = new Component("root");
    root.addBody(makeBody("a"));
    const child = root.addChild(new Component("child"));
    child.addBody(makeBody("b"));
    child.addBody(makeBody("c"));
    expect(root.bodyCount()).toBe(3);
  });

  it("resolves every body's world placement by composing down the tree", () => {
    const root = new Component("root");
    root.placement = { position: [10, 0, 0], orientation: [0, 0, 0, 1] };
    const arm = root.addChild(new Component("arm"));
    arm.placement = { position: [0, 5, 0], orientation: [0, 0, 0, 1] };
    const b = arm.addBody(makeBody("hand"));

    const placed = root.placedBodies();
    expect(placed).toHaveLength(1);
    expect(placed[0]!.body).toBe(b);
    close(placed[0]!.world.position, [10, 5, 0]);
  });

  it("a fresh component has identity placement and no bodies", () => {
    const c = new Component("empty");
    expect(c.placement).toEqual(IDENTITY_PLACEMENT);
    expect(c.bodyCount()).toBe(0);
  });
});
