import { describe, expect, it } from "vitest";
import { cross, dot, quatRotate, type Quat, type Vec3 } from "../math/index.js";
import type { Mate } from "./constraint.js";
import { type ComponentPose, solveMates } from "./solver.js";

const ID: Quat = [0, 0, 0, 1];
function fixedAt(position: Vec3): ComponentPose {
  return { position, orientation: ID, fixed: true };
}
function freeAt(position: Vec3, orientation: Quat = ID): ComponentPose {
  return { position, orientation, fixed: false };
}
const near = (a: number, b: number, tol = 1e-6): void => expect(Math.abs(a - b)).toBeLessThan(tol);

describe("3D assembly-mate solver (FR-27)", () => {
  it("coincident drives a component point onto a fixed target point", () => {
    const r = solveMates(
      [fixedAt([0, 0, 0]), freeAt([0, 0, 0])],
      [
        {
          kind: "coincident",
          a: { component: 1, point: [0, 0, 0] },
          b: { component: 0, point: [1, 0, 0] },
        },
      ],
    );
    expect(r.residualNorm).toBeLessThan(1e-7);
    near(r.poses[1]!.position[0], 1);
    near(r.poses[1]!.position[1], 0);
    near(r.poses[1]!.position[2], 0);
    expect(r.verdict).toBe("under-constrained"); // 3 rotational DOF remain free
  });

  it("distance places a point at a fixed separation", () => {
    const r = solveMates(
      [fixedAt([0, 0, 0]), freeAt([0.5, 0, 0])],
      [
        {
          kind: "distance",
          a: { component: 1, point: [0, 0, 0] },
          b: { component: 0, point: [0, 0, 0] },
          value: 2,
        },
      ],
    );
    expect(r.residualNorm).toBeLessThan(1e-7);
    const p = r.poses[1]!.position;
    near(Math.hypot(p[0], p[1], p[2]), 2);
  });

  it("parallel aligns two axes (cross → 0)", () => {
    // Oblique start (not a perpendicular saddle) so the solver has a descent
    // direction toward alignment — a realistic mate initial guess.
    const start: Vec3 = [Math.SQRT1_2, Math.SQRT1_2, 0];
    const r = solveMates(
      [fixedAt([0, 0, 0]), freeAt([0, 0, 0])],
      [{ kind: "parallel", a: { component: 1, dir: start }, b: { component: 0, dir: [1, 0, 0] } }],
    );
    expect(r.residualNorm).toBeLessThan(1e-7);
    const worldDir = quatRotate(r.poses[1]!.orientation, start);
    const c = cross(worldDir, [1, 0, 0]);
    near(Math.hypot(c[0], c[1], c[2]), 0, 1e-5);
  });

  it("perpendicular drives two axes to a right angle (dot → 0)", () => {
    const start: Vec3 = [Math.SQRT1_2, Math.SQRT1_2, 0]; // 45° from +X
    const r = solveMates(
      [fixedAt([0, 0, 0]), freeAt([0, 0, 0])],
      [
        {
          kind: "perpendicular",
          a: { component: 1, dir: start },
          b: { component: 0, dir: [1, 0, 0] },
        },
      ],
    );
    expect(r.residualNorm).toBeLessThan(1e-7);
    const worldDir = quatRotate(r.poses[1]!.orientation, start);
    near(dot(worldDir, [1, 0, 0]), 0, 1e-5);
  });

  it("angle sets a specific angle between two axes", () => {
    const start: Vec3 = [Math.SQRT1_2, Math.SQRT1_2, 0]; // 45°, dot = 0.707
    const target = Math.PI / 3; // 60°, dot = 0.5
    const r = solveMates(
      [fixedAt([0, 0, 0]), freeAt([0, 0, 0])],
      [
        {
          kind: "angle",
          a: { component: 1, dir: start },
          b: { component: 0, dir: [1, 0, 0] },
          value: target,
        },
      ],
    );
    expect(r.residualNorm).toBeLessThan(1e-7);
    const worldDir = quatRotate(r.poses[1]!.orientation, start);
    near(dot(worldDir, [1, 0, 0]), Math.cos(target), 1e-5);
  });

  it("concentric makes two axes collinear (a shaft in a hole)", () => {
    // Fixed hole: axis through origin along +Z. Free shaft offset in x,y.
    const r = solveMates(
      [fixedAt([0, 0, 0]), freeAt([0.1, 0.2, 0])],
      [
        {
          kind: "concentric",
          a: { component: 1, point: [0, 0, 0], dir: [0, 0, 1] },
          b: { component: 0, point: [0, 0, 0], dir: [0, 0, 1] },
        },
      ],
    );
    expect(r.residualNorm).toBeLessThan(1e-7);
    // The shaft's axis point must now lie on the z-axis (x = y = 0).
    near(r.poses[1]!.position[0], 0, 1e-5);
    near(r.poses[1]!.position[1], 0, 1e-5);
    expect(r.verdict).toBe("under-constrained"); // slide + spin about the axis remain
  });

  it("tangent rests a cylinder a radius above a plane", () => {
    // Fixed plane: the xz-plane (point origin, normal +Y). Free cylinder, axis
    // along +X, radius 0.5, starts 2 m up; should settle to y = 0.5.
    const r = solveMates(
      [fixedAt([0, 0, 0]), freeAt([0, 2, 0])],
      [
        {
          kind: "tangent",
          a: { component: 1, point: [0, 0, 0], dir: [1, 0, 0] },
          b: { component: 0, point: [0, 0, 0], dir: [0, 1, 0] },
          radius: 0.5,
        },
      ],
    );
    expect(r.residualNorm).toBeLessThan(1e-7);
    near(r.poses[1]!.position[1], 0.5, 1e-5);
  });
});

describe("mate-solver verdicts (FR-27)", () => {
  it("three non-collinear coincident points fully constrain a component", () => {
    // Pin three local points to three world targets = a pure translation [1,1,1].
    const locals: Vec3[] = [
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
    ];
    const mates: Mate[] = locals.map((p) => ({
      kind: "coincident",
      a: { component: 1, point: p },
      b: { component: 0, point: [p[0] + 1, p[1] + 1, p[2] + 1] },
    }));
    const r = solveMates([fixedAt([0, 0, 0]), freeAt([0, 0, 0])], mates);
    expect(r.residualNorm).toBeLessThan(1e-7);
    near(r.poses[1]!.position[0], 1, 1e-5);
    near(r.poses[1]!.position[1], 1, 1e-5);
    near(r.poses[1]!.position[2], 1, 1e-5);
    expect(r.freedom).toBe(0);
    expect(r.verdict).toBe("well-constrained");
  });

  it("conflicting distances are over-constrained (residual cannot vanish)", () => {
    const r = solveMates(
      [fixedAt([0, 0, 0]), freeAt([1, 0, 0])],
      [
        {
          kind: "distance",
          a: { component: 1, point: [0, 0, 0] },
          b: { component: 0, point: [0, 0, 0] },
          value: 2,
        },
        {
          kind: "distance",
          a: { component: 1, point: [0, 0, 0] },
          b: { component: 0, point: [0, 0, 0] },
          value: 3,
        },
      ],
    );
    expect(r.residualNorm).toBeGreaterThan(0.1); // cannot be both 2 and 3
    expect(r.verdict).toBe("over-constrained");
  });
});
