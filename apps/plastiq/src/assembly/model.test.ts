import { describe, expect, it } from "vitest";
import { solveMates } from "@plastiq/cad";
import {
  applyJointDrives,
  axisAngleQuat,
  driveJoint,
  reanchorJoints,
  toAssemblyInput,
  type AssemblyJoint,
  type AssemblyModel,
  type ComponentInstance,
  type Quat,
  type Vec3,
} from "./model.js";

/** Rotate a vector by a quaternion (math isn't re-exported from the root). */
function rotate(q: Quat, v: Vec3): Vec3 {
  const [x, y, z, w] = q;
  // t = 2 * (q.xyz × v)
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  // v + w*t + q.xyz × t
  return [
    v[0] + w * tx + (y * tz - z * ty),
    v[1] + w * ty + (z * tx - x * tz),
    v[2] + w * tz + (x * ty - y * tx),
  ];
}

/** World position of a local point under a solved component pose. */
function worldPoint(pose: { position: Vec3; orientation: Quat }, local: Vec3): Vec3 {
  const r = rotate(pose.orientation, local);
  return [pose.position[0] + r[0], pose.position[1] + r[1], pose.position[2] + r[2]];
}

describe("assembly model → kernel solveMates bridge (M4.1 seam)", () => {
  it("maps instances to component poses and mate refs to component indices", () => {
    const model: AssemblyModel = {
      instances: [
        {
          id: "i0",
          name: "A",
          pose: { position: [0, 0, 0], orientation: [0, 0, 0, 1] },
          fixed: true,
        },
        { id: "i1", name: "B", pose: { position: [0.1, 0, 0], orientation: [0, 0, 0, 1] } },
      ],
      mates: [
        {
          id: "m0",
          kind: "coincident",
          a: { instance: "i0", point: [0.02, 0, 0] },
          b: { instance: "i1", point: [-0.02, 0, 0] },
        },
      ],
      joints: [],
    };
    const input = toAssemblyInput(model);
    expect(input.components).toHaveLength(2);
    expect(input.components[0]).toMatchObject({ fixed: true });
    expect(input.mates[0]).toMatchObject({ kind: "coincident" });
    expect((input.mates[0] as { a: { component: number } }).a.component).toBe(0);
    expect((input.mates[0] as { b: { component: number } }).b.component).toBe(1);
  });

  it("a coincident mate solves two instances to touching poses", () => {
    // Instance A fixed at origin; instance B starts offset. A coincident mate
    // between a point on A and a point on B must bring those world points together.
    const model: AssemblyModel = {
      instances: [
        {
          id: "i0",
          name: "A",
          pose: { position: [0, 0, 0], orientation: [0, 0, 0, 1] },
          fixed: true,
        },
        { id: "i1", name: "B", pose: { position: [0.2, 0.05, 0], orientation: [0, 0, 0, 1] } },
      ],
      mates: [
        {
          id: "m0",
          kind: "coincident",
          a: { instance: "i0", point: [0.03, 0, 0] }, // world (0.03,0,0)
          b: { instance: "i1", point: [-0.03, 0, 0] }, // local; world depends on B's pose
        },
      ],
      joints: [],
    };
    const input = toAssemblyInput(model);
    const result = solveMates(input.components, input.mates);
    expect(result.residualNorm).toBeLessThan(1e-6);
    // The mate's invariant: the two referenced world points coincide. (The
    // solver is free to choose any valid pose / rotation that achieves this.)
    const wa = worldPoint(result.poses[0]!, [0.03, 0, 0]); // A is fixed → (0.03,0,0)
    const wb = worldPoint(result.poses[1]!, [-0.03, 0, 0]);
    expect(Math.hypot(wb[0] - wa[0], wb[1] - wa[1], wb[2] - wa[2])).toBeLessThan(1e-5);
    // B actually moved from its offset seed (not a no-op solve).
    expect(result.poses[1]!.position[0]).not.toBeCloseTo(0.2, 2);
  });
});

describe("joint kinematics — drive preview (M4.3/M4.4)", () => {
  const revolute: AssemblyJoint = {
    id: "j0",
    kind: "revolute",
    parent: "i0",
    child: "i1",
    origin: [0, 0, 0],
    axis: [0, 0, 1], // spin about +Z
  };

  it("revolute drive rotates the child about the axis through the origin", () => {
    // Child sits at (0.1,0,0); a +90° spin about Z→origin lands it at (0,0.1,0).
    const child = { position: [0.1, 0, 0] as Vec3, orientation: [0, 0, 0, 1] as Quat };
    const out = driveJoint(revolute, child, Math.PI / 2);
    expect(out.position[0]).toBeCloseTo(0, 6);
    expect(out.position[1]).toBeCloseTo(0.1, 6);
  });

  it("prismatic drive slides the child along the axis", () => {
    const j: AssemblyJoint = { ...revolute, kind: "prismatic", axis: [1, 0, 0] };
    const child = { position: [0, 0, 0] as Vec3, orientation: [0, 0, 0, 1] as Quat };
    expect(driveJoint(j, child, 0.05).position[0]).toBeCloseTo(0.05, 9);
  });

  it("applyJointDrives moves only the driven joint's child, leaving the parent", () => {
    const instances: ComponentInstance[] = [
      {
        id: "i0",
        name: "A",
        pose: { position: [0, 0, 0], orientation: [0, 0, 0, 1] },
        fixed: true,
      },
      { id: "i1", name: "B", pose: { position: [0.1, 0, 0], orientation: [0, 0, 0, 1] } },
    ];
    const out = applyJointDrives(instances, [revolute], { j0: Math.PI / 2 });
    expect(out[0]!.pose.position).toEqual([0, 0, 0]); // parent untouched
    expect(out[1]!.pose.position[1]).toBeCloseTo(0.1, 6); // child rotated
    // Pure: the source instances are not mutated.
    expect(instances[1]!.pose.position[1]).toBe(0);
  });
});

describe("reanchorJoints — joint frames follow the re-posed parent (§2.11.5)", () => {
  const inst = (id: string, pose: ComponentInstance["pose"]): ComponentInstance => ({
    id,
    name: id,
    pose,
  });
  const joint = (parent: string, child: string): AssemblyJoint => ({
    id: "j0",
    kind: "revolute",
    parent,
    child,
    origin: [0.09, 0, 0.01], // baked world frame: a point on the parent
    axis: [0, 0, 1],
  });

  it("a translated parent translates the joint origin; the axis is unchanged", () => {
    const before = [inst("p", { position: [0.08, 0, 0], orientation: [0, 0, 0, 1] }), inst("c", { position: [0.2, 0, 0], orientation: [0, 0, 0, 1] })];
    const after = [inst("p", { position: [0, 0, 0], orientation: [0, 0, 0, 1] }), before[1]!];
    const [j] = reanchorJoints([joint("p", "c")], before, after);
    expect(j!.origin[0]).toBeCloseTo(0.01, 9); // 0.09 − 0.08
    expect(j!.origin[2]).toBeCloseTo(0.01, 9);
    expect(j!.axis).toEqual([0, 0, 1]);
  });

  it("a rotated parent orbits the origin about the parent and rotates the axis", () => {
    const before = [inst("p", { position: [0, 0, 0], orientation: [0, 0, 0, 1] })];
    // Parent re-posed: rotated 90° about world Y at its own position.
    const q = axisAngleQuat([0, 1, 0], Math.PI / 2);
    const after = [inst("p", { position: [0, 0, 0], orientation: q })];
    const j0: AssemblyJoint = { id: "j0", kind: "revolute", parent: "p", child: "c", origin: [0.1, 0, 0], axis: [0, 0, 1] };
    const [j] = reanchorJoints([j0], before, after);
    // Ry(90°): (x,y,z) → (z, y, −x) — origin (0.1,0,0) → (0,0,−0.1); axis (0,0,1) → (1,0,0).
    expect(j!.origin[0]).toBeCloseTo(0, 9);
    expect(j!.origin[2]).toBeCloseTo(-0.1, 9);
    expect(j!.axis[0]).toBeCloseTo(1, 9);
    expect(j!.axis[2]).toBeCloseTo(0, 9);
  });

  it("an unmoved parent (bit-equal pose) returns the joint object unchanged", () => {
    const pose = { position: [0.05, 0, 0] as Vec3, orientation: [0, 0, 0, 1] as Quat };
    const before = [inst("p", pose)];
    const after = [inst("p", { position: [0.05, 0, 0], orientation: [0, 0, 0, 1] })];
    const j0 = joint("p", "c");
    const [j] = reanchorJoints([j0], before, after);
    expect(j).toBe(j0); // same reference — no float churn on repeated solves
  });

  it("a child-only move and an unknown parent leave the frame untouched", () => {
    const before = [inst("p", { position: [0, 0, 0], orientation: [0, 0, 0, 1] }), inst("c", { position: [0.1, 0, 0], orientation: [0, 0, 0, 1] })];
    const after = [before[0]!, inst("c", { position: [0.3, 0, 0], orientation: [0, 0, 0, 1] })];
    const [j1] = reanchorJoints([joint("p", "c")], before, after);
    expect(j1!.origin).toEqual([0.09, 0, 0.01]); // frame is attached to the PARENT

    const [j2] = reanchorJoints([joint("ghost", "c")], before, after);
    expect(j2!.origin).toEqual([0.09, 0, 0.01]);
  });
});
