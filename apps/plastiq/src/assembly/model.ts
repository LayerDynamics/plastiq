// The assembly model (SPEC-5 M4). N occurrences ("instances") of the current
// part, each with a rigid pose, plus mates that the kernel solver positions
// (FR-33/FR-34). Persistent document data (undoable/reloadable) — ADR-0013:
// persist the mate graph + seed poses, derive the solved poses. Instances all
// reference the single feature-tree part for M4 (a multi-part library is M5).
//
// Poses are QUATERNIONS end-to-end (solver ↔ three.js ↔ manifest); never the
// M1.3 Euler placement. `toAssemblyInput` bridges this id-based model to the
// kernel's index-based solveMates input.

import type { ComponentPose, JointKind, Mate, MateRef } from "@plastiq/cad";

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number]; // x,y,z,w

export interface InstancePose {
  position: Vec3;
  orientation: Quat;
}

export interface ComponentInstance {
  id: string;
  /** Display name (e.g. "Part 1"). */
  name: string;
  /** The part this instance is an occurrence OF — its BOM key (M4). Defaults to `name` when a
   * `.assy` link gives no override; lets the auto-BOM count occurrences of the same part. */
  part?: string;
  pose: InstancePose;
  /** Anchored — the solver won't move it (the assembly's ground). */
  fixed?: boolean;
}

/** A mate endpoint: an instance + a local point and/or direction (from a pick). */
export interface AssemblyMateRef {
  instance: string;
  point?: Vec3;
  dir?: Vec3;
}

export type AssemblyMate =
  | { id: string; kind: "coincident"; a: AssemblyMateRef; b: AssemblyMateRef }
  | { id: string; kind: "distance"; a: AssemblyMateRef; b: AssemblyMateRef; value: number }
  | { id: string; kind: "parallel"; a: AssemblyMateRef; b: AssemblyMateRef }
  | { id: string; kind: "perpendicular"; a: AssemblyMateRef; b: AssemblyMateRef }
  | { id: string; kind: "angle"; a: AssemblyMateRef; b: AssemblyMateRef; value: number }
  | { id: string; kind: "concentric"; a: AssemblyMateRef; b: AssemblyMateRef };

/** An articulated joint between two instances (SPEC-5 FR-35), drivable for the
 * motion preview and lowered to the sim at M4.5. The frame is in world coords. */
export interface AssemblyJoint {
  id: string;
  kind: JointKind;
  /** Parent (base) + child (moving) instance ids. */
  parent: string;
  child: string;
  origin: Vec3;
  /** Primary axis (unit): rotation/slide axis or plane normal. */
  axis: Vec3;
  limits?: { lower?: number; upper?: number };
}

export interface AssemblyModel {
  instances: ComponentInstance[];
  mates: AssemblyMate[];
  joints: AssemblyJoint[];
}

export function emptyAssembly(): AssemblyModel {
  return { instances: [], mates: [], joints: [] };
}

/** Rotate a vector by a quaternion. */
export function quatRotate(q: Quat, v: Vec3): Vec3 {
  const [x, y, z, w] = q;
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [
    v[0] + w * tx + (y * tz - z * ty),
    v[1] + w * ty + (z * tx - x * tz),
    v[2] + w * tz + (x * ty - y * tx),
  ];
}

/** World point of a local point under a pose. */
export function localToWorld(pose: InstancePose, local: Vec3): Vec3 {
  const r = quatRotate(pose.orientation, local);
  return [pose.position[0] + r[0], pose.position[1] + r[1], pose.position[2] + r[2]];
}

function normalize(v: Vec3): Vec3 {
  const n = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / n, v[1] / n, v[2] / n];
}

/** Quaternion for a rotation of `angle` (rad) about a unit `axis`. */
export function axisAngleQuat(axis: Vec3, angle: number): Quat {
  const [x, y, z] = normalize(axis);
  const s = Math.sin(angle / 2);
  return [x * s, y * s, z * s, Math.cos(angle / 2)];
}

/** Hamilton product a∘b (apply b then a). */
export function quatMul(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

/** Conjugate — the inverse rotation for a unit quaternion. */
export function quatConj(q: Quat): Quat {
  return [-q[0], -q[1], -q[2], q[3]];
}

function samePose(a: InstancePose, b: InstancePose): boolean {
  return (
    a.position[0] === b.position[0] &&
    a.position[1] === b.position[1] &&
    a.position[2] === b.position[2] &&
    a.orientation[0] === b.orientation[0] &&
    a.orientation[1] === b.orientation[1] &&
    a.orientation[2] === b.orientation[2] &&
    a.orientation[3] === b.orientation[3]
  );
}

/**
 * Re-anchor joint frames after instances move (§2.11.5). A joint's world-frame
 * origin/axis is baked from its PARENT instance's pose at creation; when the
 * parent is re-posed (mate solve), the frame is physically attached to the
 * parent and must ride along: express it in the old parent's local frame, then
 * re-world it under the new pose. Joints whose parent did not move (bit-equal
 * pose — no float churn on repeated solves) or is not in either instance list
 * are returned unchanged. Pure: never mutates the input joints.
 */
export function reanchorJoints(
  joints: readonly AssemblyJoint[],
  oldInstances: readonly ComponentInstance[],
  newInstances: readonly ComponentInstance[],
): AssemblyJoint[] {
  const oldById = new Map(oldInstances.map((i) => [i.id, i.pose]));
  const newById = new Map(newInstances.map((i) => [i.id, i.pose]));
  return joints.map((j) => {
    const oldPose = oldById.get(j.parent);
    const newPose = newById.get(j.parent);
    if (!oldPose || !newPose || samePose(oldPose, newPose)) return j;
    const inv = quatConj(oldPose.orientation);
    const localOrigin = quatRotate(inv, [
      j.origin[0] - oldPose.position[0],
      j.origin[1] - oldPose.position[1],
      j.origin[2] - oldPose.position[2],
    ]);
    const localAxis = quatRotate(inv, j.axis);
    return {
      ...j,
      origin: localToWorld(newPose, localOrigin),
      axis: quatRotate(newPose.orientation, localAxis),
    };
  });
}

/**
 * Drive a joint's child to a coordinate, relative to its neutral pose — the
 * design-time motion preview (FR-36). Revolute rotates about (origin,axis);
 * prismatic/cylindrical slide along axis (cylindrical's primary = rotation);
 * fixed/ball/planar aren't single-coordinate driven and return the pose as-is.
 */
export function driveJoint(
  joint: AssemblyJoint,
  childPose: InstancePose,
  coord: number,
): InstancePose {
  if (joint.kind === "prismatic") {
    const ax = normalize(joint.axis);
    return {
      position: [
        childPose.position[0] + ax[0] * coord,
        childPose.position[1] + ax[1] * coord,
        childPose.position[2] + ax[2] * coord,
      ],
      orientation: [...childPose.orientation],
    };
  }
  if (joint.kind === "revolute" || joint.kind === "cylindrical") {
    const q = axisAngleQuat(joint.axis, coord);
    const rel: Vec3 = [
      childPose.position[0] - joint.origin[0],
      childPose.position[1] - joint.origin[1],
      childPose.position[2] - joint.origin[2],
    ];
    const r = quatRotate(q, rel);
    return {
      position: [joint.origin[0] + r[0], joint.origin[1] + r[1], joint.origin[2] + r[2]],
      orientation: quatMul(q, childPose.orientation),
    };
  }
  return { position: [...childPose.position], orientation: [...childPose.orientation] };
}

/**
 * Apply joint drives to the resting instance poses for the motion preview
 * (FR-36). Each driven joint repositions its child from the child's resting
 * pose; joints are applied independently (chained kinematics is a later
 * refinement). Pure: returns new poses, never mutating the document.
 */
export function applyJointDrives(
  instances: readonly ComponentInstance[],
  joints: readonly AssemblyJoint[],
  drives: Readonly<Record<string, number>>,
): ComponentInstance[] {
  const byId = new Map(instances.map((i) => [i.id, i]));
  const out = instances.map((i) => ({
    ...i,
    pose: { position: [...i.pose.position] as Vec3, orientation: [...i.pose.orientation] as Quat },
  }));
  const outById = new Map(out.map((i) => [i.id, i]));
  for (const j of joints) {
    const coord = drives[j.id];
    if (coord === undefined || coord === 0) continue;
    const child = byId.get(j.child);
    const target = outById.get(j.child);
    if (!child || !target) continue;
    target.pose = driveJoint(j, child.pose, coord);
  }
  return out;
}

/** Local point (in the instance frame) of a world point under a pose. */
export function worldToLocal(pose: InstancePose, world: Vec3): Vec3 {
  const [x, y, z, w] = pose.orientation;
  const conj: Quat = [-x, -y, -z, w];
  const d: Vec3 = [
    world[0] - pose.position[0],
    world[1] - pose.position[1],
    world[2] - pose.position[2],
  ];
  return quatRotate(conj, d);
}

export const IDENTITY_POSE: InstancePose = { position: [0, 0, 0], orientation: [0, 0, 0, 1] };

function instanceIndex(model: AssemblyModel, id: string): number {
  return model.instances.findIndex((i) => i.id === id);
}

function toMateRef(model: AssemblyModel, ref: AssemblyMateRef): MateRef {
  const out: MateRef = { component: instanceIndex(model, ref.instance) };
  return { ...out, point: ref.point, dir: ref.dir };
}

/** Bridge the id-based assembly model to the kernel's index-based solver input. */
export function toAssemblyInput(model: AssemblyModel): {
  components: ComponentPose[];
  mates: Mate[];
} {
  const components: ComponentPose[] = model.instances.map((i) => ({
    position: [...i.pose.position],
    orientation: [...i.pose.orientation],
    fixed: i.fixed,
  }));

  const mates: Mate[] = model.mates.map((m) => {
    const a = toMateRef(model, m.a);
    const b = toMateRef(model, m.b);
    switch (m.kind) {
      case "distance":
        return { kind: "distance", a, b, value: m.value };
      case "angle":
        return { kind: "angle", a, b, value: m.value };
      default:
        return { kind: m.kind, a, b };
    }
  });

  return { components, mates };
}
