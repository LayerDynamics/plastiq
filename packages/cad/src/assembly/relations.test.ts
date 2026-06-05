import { describe, expect, it } from "vitest";
import type { Quat, Vec3 } from "../math/index.js";
import { contactGap, contactWorldA, type ContactPoint } from "./contact_point.js";
import { drivenCoordinate, driverCoordinate, makeMotionLink } from "./motion_link.js";
import { evaluateRelationship, makeRelationship } from "./relationship.js";
import { groupOf, makeRigidGroup, rigidBodyCount } from "./rigid.js";
import type { ComponentPose } from "./solver.js";

const ID: Quat = [0, 0, 0, 1];
const pose = (position: Vec3, orientation: Quat = ID): ComponentPose => ({ position, orientation });

describe("rigid groups (FR-29)", () => {
  it("a rigid group collapses its members into one body", () => {
    // 5 components; weld 3 of them → 1 (group) + 2 (loose) = 3 rigid bodies.
    const groups = [makeRigidGroup("weld", [0, 1, 2])];
    expect(rigidBodyCount(5, groups)).toBe(3);
    expect(groupOf(groups, 1)?.name).toBe("weld");
    expect(groupOf(groups, 4)).toBeUndefined();
  });

  it("overlapping rigid groups are rejected", () => {
    const groups = [makeRigidGroup("a", [0, 1]), makeRigidGroup("b", [1, 2])];
    expect(() => rigidBodyCount(3, groups)).toThrow(/more than one rigid group/);
  });
});

describe("motion links (FR-29)", () => {
  it("a gear ratio couples driver→driven coordinates", () => {
    const link = makeMotionLink(0, 1, 2); // 2:1 step-up
    expect(drivenCoordinate(link, Math.PI)).toBeCloseTo(2 * Math.PI, 12);
    expect(driverCoordinate(link, 2 * Math.PI)).toBeCloseTo(Math.PI, 12);
  });

  it("a negative ratio reverses sense (meshing external gears)", () => {
    const link = makeMotionLink(0, 1, -0.5);
    expect(drivenCoordinate(link, 4)).toBe(-2);
  });

  it("a zero/non-finite ratio is rejected", () => {
    expect(() => makeMotionLink(0, 1, 0)).toThrow(/non-zero/);
  });
});

describe("parametric relationships (FR-29)", () => {
  it("couples two parameters by a linear equation", () => {
    const rel = makeRelationship("width", "height", 2, 1); // height = 2·width + 1
    expect(evaluateRelationship(rel, 10)).toBe(21);
  });

  it("rejects self-coupling", () => {
    expect(() => makeRelationship("x", "x", 1)).toThrow(/itself/);
  });
});

describe("contact points + pose (FR-29)", () => {
  it("resolves local contact points to world via component poses and reports the gap", () => {
    const cp: ContactPoint = { a: 0, b: 1, pointA: [1, 0, 0], pointB: [0, 0, 0] };
    const poseA = pose([0, 0, 0]); // world A point = [1,0,0]
    const poseB = pose([1.5, 0, 0]); // world B point = [1.5,0,0]
    expect(contactWorldA(cp, poseA)).toEqual([1, 0, 0]);
    expect(contactGap(cp, poseA, poseB)).toBeCloseTo(0.5, 12);
  });

  it("a rotated pose rotates the local contact point", () => {
    // 90° about +Z maps local +X → +Y; with B coincident the gap is √2.
    const cp: ContactPoint = { a: 0, b: 1, pointA: [1, 0, 0], pointB: [0, 0, 0] };
    const rot: Quat = [0, 0, Math.SQRT1_2, Math.SQRT1_2];
    const wA = contactWorldA(cp, pose([0, 0, 0], rot));
    expect(wA[0]).toBeCloseTo(0, 9);
    expect(wA[1]).toBeCloseTo(1, 9);
    expect(contactGap(cp, pose([0, 0, 0], rot), pose([0, 0, 0]))).toBeCloseTo(1, 9);
  });
});
