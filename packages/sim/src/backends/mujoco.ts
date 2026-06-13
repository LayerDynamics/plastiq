// MuJoCo physics backend (@mujoco/mujoco — DeepMind's official WASM build, runs in
// node and the browser). Unlike the maximal-coordinate backends (Rapier, Bullet,
// cannon-es) MuJoCo is a REDUCED-coordinate engine: bodies live in a kinematic
// tree and joints ARE the degrees of freedom. That is exactly why it can express a
// world-axis hinge between differently-oriented bodies (the documented rapier-compat
// limitation): the hinge is a native tree joint, not an impulse constraint forced
// into a single body-frame axis.
//
// Mapping a flat manifest (bodies + pairwise constraints) onto a tree:
//   - Fixed bodies (mass 0) become no-joint children of the worldbody (static, and
//     they double as the collision ground).
//   - A spanning tree is grown breadth-first from the fixed roots over the
//     constraint graph; each tree edge becomes the child's joint:
//       hinge → <joint type="hinge"> with pivot + axis in the CHILD's local frame,
//       fixed → no joint (the child is rigidly welded into its parent).
//   - A dynamic body reached by no constraint becomes a free body (<freejoint>).
//   - A constraint that would close a loop (a non-tree edge) cannot be a tree joint;
//     a fixed loop-closer becomes a <weld> equality, a hinge loop-closer is dropped
//     with a warning (MuJoCo has no single-axis hinge equality). No fixture exercises
//     loops, and the kernel emits trees, so this is a graceful-degradation path.
//
// Geometry: each convex-hull collider becomes a <mesh> asset (MuJoCo builds the
// convex hull from the vertex cloud). All pieces of one body share a density so the
// body's total mass is exactly b.mass and its inertia is physical — mirroring rapier.

// Vendored DeepMind MuJoCo WASM build — see packages/sim/vendor/mujoco/PROVENANCE.md.
// Vendored (not an npm dependency) for the same anti-vanishing-dependency reason as
// the kernel's OCCT and V-HACD: the simulator must keep building from a self-contained
// tree. The loader resolves mujoco.wasm via `new URL('mujoco.wasm', import.meta.url)`,
// so the .js and .wasm stay co-located.
import loadMujoco from "../../vendor/mujoco/mujoco.js";

import type {
  BodyState,
  PhysicsBackend,
  PhysicsEngine,
  PhysicsPose,
  PhysicsSnapshot,
} from "../engine.js";
import { hullVolume, type ManifestBody, type SimManifest } from "../manifest.js";
import { conjugate, localAnchor, localAxis, quatMul, type SimQuat, type SimVec3 } from "../frame.js";

// The factory's resolved module (MjModel/MjData classes, mj_* functions, enums).
// The package types its data arrays as `any`, so this stays loosely typed.
type MujocoModule = Awaited<ReturnType<typeof loadMujoco>>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MjModelH = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MjDataH = any;

let mj: MujocoModule | null = null;

/** Density used for static (fixed) bodies — never enters the dynamics, since a
 * no-joint body does not move; present only so MuJoCo's compiler is happy. */
const STATIC_DENSITY = 1000;

// A tree edge: the constraint that attaches a child body to its parent.
interface TreeEdge {
  other: number;
  kind: "hinge" | "fixed";
  origin: SimVec3;
  axis: SimVec3;
}

/** Build the MJCF (MuJoCo XML) for a manifest at a fixed integration timestep. */
function buildMjcf(manifest: SimManifest, timestep: number): string {
  const bodies = manifest.bodies;
  const idToIndex = new Map<string, number>();
  bodies.forEach((b, i) => idToIndex.set(b.id, i));

  // Constraint graph (undirected): resolve body refs to indices; warn-and-drop a
  // constraint that names a missing body (matches the other backends — a dangling
  // ref degrades gracefully rather than failing the spawn).
  const adjacency: TreeEdge[][] = bodies.map(() => []);
  const edges: { a: number; b: number; kind: "hinge" | "fixed"; origin: SimVec3; axis: SimVec3 }[] = [];
  for (const c of manifest.constraints) {
    const ai = idToIndex.get(c.bodyA);
    const bi = idToIndex.get(c.bodyB);
    if (ai === undefined || bi === undefined) {
      console.warn(
        `mujoco: dropping ${c.kind} constraint — missing body (bodyA='${c.bodyA}'${ai === undefined ? " [missing]" : ""}, bodyB='${c.bodyB}'${bi === undefined ? " [missing]" : ""})`,
      );
      continue;
    }
    edges.push({ a: ai, b: bi, kind: c.kind, origin: c.origin, axis: c.axis });
    adjacency[ai]!.push({ other: bi, kind: c.kind, origin: c.origin, axis: c.axis });
    adjacency[bi]!.push({ other: ai, kind: c.kind, origin: c.origin, axis: c.axis });
  }

  // Breadth-first spanning forest. Fixed bodies seed the forest (welded to world);
  // any body left unvisited starts a new component rooted at a free base.
  const parent: number[] = bodies.map(() => -1); // -1 → child of the worldbody
  const parentEdge: (TreeEdge | null)[] = bodies.map(() => null);
  const visited = bodies.map(() => false);
  const queue: number[] = [];
  const makeRoot = (i: number): void => {
    visited[i] = true;
    parent[i] = -1;
    parentEdge[i] = null;
    queue.push(i);
  };
  bodies.forEach((b, i) => {
    if (b.fixed && !visited[i]) makeRoot(i);
  });
  let head = 0;
  for (;;) {
    while (head < queue.length) {
      const p = queue[head++]!;
      for (const e of adjacency[p]!) {
        if (!visited[e.other]) {
          visited[e.other] = true;
          parent[e.other] = p;
          parentEdge[e.other] = e;
          queue.push(e.other);
        }
      }
    }
    const next = visited.findIndex((v) => !v);
    if (next === -1) break;
    makeRoot(next);
  }

  // Loop-closing edges (neither endpoint is the other's tree parent) → equalities.
  const equalities: string[] = [];
  for (const e of edges) {
    if (parent[e.a] === e.b || parent[e.b] === e.a) continue; // a tree edge
    if (e.kind === "fixed") {
      equalities.push(`<weld body1="b${e.a}" body2="b${e.b}"/>`);
    } else {
      console.warn(
        `mujoco: hinge between '${bodies[e.a]!.id}' and '${bodies[e.b]!.id}' closes a kinematic loop; MuJoCo has no single-axis hinge equality, so this loop-closing hinge is dropped`,
      );
    }
  }

  const childrenOf = new Map<number, number[]>();
  bodies.forEach((_, i) => {
    const p = parent[i]!;
    (childrenOf.get(p) ?? childrenOf.set(p, []).get(p)!).push(i);
  });

  // Mesh assets (one per collider piece). MuJoCo computes the convex hull from the
  // raw vertex cloud — exactly the collision shape we want.
  const assets = bodies
    .flatMap((b, i) =>
      b.colliders.map((piece, k) => `<mesh name="m${i}_${k}" vertex="${fmtFloats(piece.points)}"/>`),
    )
    .join("");

  const geomsFor = (i: number, b: ManifestBody): string => {
    const totalVol = b.colliders.reduce((sum, c) => sum + hullVolume(c), 0);
    const density = b.mass > 0 && totalVol > 0 ? b.mass / totalVol : STATIC_DENSITY;
    return b.colliders
      .map((_, k) => `<geom type="mesh" mesh="m${i}_${k}" density="${fmtNum(density)}"/>`)
      .join("");
  };

  const emitBody = (i: number): string => {
    const b = bodies[i]!;
    const p = parent[i]!;
    const childQ = b.orientation as SimQuat;

    // Pose RELATIVE to the parent frame (worldbody is identity for roots).
    let posLocal: SimVec3;
    let quatLocal: SimQuat; // (x,y,z,w)
    if (p === -1) {
      posLocal = [b.com[0], b.com[1], b.com[2]];
      quatLocal = childQ;
    } else {
      const pb = bodies[p]!;
      const parentQ = pb.orientation as SimQuat;
      posLocal = localAnchor(b.com as SimVec3, pb.com as SimVec3, parentQ);
      quatLocal = quatMul(conjugate(parentQ), childQ);
    }

    // Joint from the edge that attached this body. Hinge pivot + axis are in the
    // CHILD's local frame (frame.ts helpers — identical to the maximal backends).
    let joint = "";
    const e = parentEdge[i];
    if (p === -1) {
      if (!b.fixed) joint = "<freejoint/>";
    } else if (e && e.kind === "hinge") {
      const pivot = localAnchor(e.origin, b.com as SimVec3, childQ);
      const axis = localAxis(e.axis, childQ);
      joint = `<joint type="hinge" pos="${fmtFloats(pivot)}" axis="${fmtFloats(axis)}" limited="false"/>`;
    }
    // fixed edge → no joint (rigidly welded into the parent)

    const kids = (childrenOf.get(i) ?? []).map(emitBody).join("");
    return `<body name="b${i}" pos="${fmtFloats(posLocal)}" quat="${fmtQuatWFirst(quatLocal)}">${joint}${geomsFor(i, b)}${kids}</body>`;
  };

  const roots = (childrenOf.get(-1) ?? []).map(emitBody).join("");
  const equality = equalities.length ? `<equality>${equalities.join("")}</equality>` : "";

  return (
    `<mujoco model="plastiq-sim">` +
    `<compiler angle="radian"/>` +
    `<option timestep="${fmtNum(timestep)}" gravity="${fmtFloats(manifest.gravity)}"/>` +
    `<asset>${assets}</asset>` +
    `<worldbody>${roots}</worldbody>` +
    equality +
    `</mujoco>`
  );
}

// MJCF is whitespace-separated floats; keep them finite and full-precision.
function fmtNum(n: number): string {
  if (!Number.isFinite(n)) throw new Error(`mujoco: non-finite value ${n} in MJCF`);
  return String(n);
}
function fmtFloats(a: ArrayLike<number>): string {
  const out: string[] = [];
  for (let i = 0; i < a.length; i++) out.push(fmtNum(a[i]!));
  return out.join(" ");
}
/** (x,y,z,w) → MJCF's scalar-first "w x y z". */
function fmtQuatWFirst(q: SimQuat): string {
  return `${fmtNum(q[3])} ${fmtNum(q[0])} ${fmtNum(q[1])} ${fmtNum(q[2])}`;
}

class MujocoEngine implements PhysicsEngine {
  private model: MjModelH = null;
  private data: MjDataH = null;
  private bodyIds: number[] = []; // manifest index → MuJoCo body id
  // xpos/xquat/cvel reflect the integrated qpos/qvel only after a forward pass; a
  // bare mj_step leaves them one step behind. We mark dirty on step/restore and run
  // a single mj_forward lazily before any read.
  private dirty = true;
  private readonly native = new WeakMap<PhysicsSnapshot, { qpos: Float64Array; qvel: Float64Array }>();

  constructor(private readonly timestep: number) {}

  spawn(manifest: SimManifest): number {
    if (!mj) throw new Error("MujocoEngine: backend not initialised");
    const model = mj.MjModel.from_xml_string(buildMjcf(manifest, this.timestep));
    const data = new mj.MjData(model);
    this.model = model;
    this.data = data;
    const BODY = mj.mjtObj.mjOBJ_BODY.value;
    this.bodyIds = manifest.bodies.map((_, i) => {
      const id = mj!.mj_name2id(model, BODY, `b${i}`);
      if (id < 0) throw new Error(`mujoco: body 'b${i}' missing after compile`);
      return id;
    });
    this.dirty = true; // first read runs mj_forward to populate xpos/xquat/cvel
    return this.bodyIds.length;
  }

  step(): void {
    mj!.mj_step(this.model, this.data);
    this.dirty = true;
  }

  /** Recompute xpos/xquat/cvel from the current qpos/qvel (once per read burst). */
  private sync(): void {
    if (this.dirty) {
      mj!.mj_forward(this.model, this.data);
      this.dirty = false;
    }
  }

  pose(index: number): PhysicsPose {
    const id = this.bodyIds[index];
    if (id === undefined) throw new Error(`MujocoEngine: no body at index ${index}`);
    this.sync();
    const xp = this.data.xpos as Float64Array;
    const xq = this.data.xquat as Float64Array; // scalar-first (w,x,y,z)
    return {
      position: [xp[id * 3]!, xp[id * 3 + 1]!, xp[id * 3 + 2]!],
      orientation: [xq[id * 4 + 1]!, xq[id * 4 + 2]!, xq[id * 4 + 3]!, xq[id * 4]!],
    };
  }

  snapshot(): PhysicsSnapshot {
    this.sync();
    const xp = this.data.xpos as Float64Array;
    const xq = this.data.xquat as Float64Array;
    // cvel[i] is a spatial velocity in the WORLD frame: [angular(3), linear(3)].
    // The angular part is the body's world angular velocity directly, but the linear
    // part is the velocity of the point at the tree ROOT's subtree centre-of-mass
    // (data.subtree_com[body_rootid[i]]), NOT this body's own COM. For a free body or
    // a single body hinged off a static base that point coincides with the body COM
    // (the offset below is zero), but in a multi-link DYNAMIC chain it does not, so we
    // shift it to the body's COM: v_com = v_ref + ω × (x_com − subtree_com[root]).
    // (The canonical mj_objectVelocity does this internally, but its output pointer is
    // unreachable in this embind build, so we apply the rigid-body shift ourselves.)
    const cv = this.data.cvel as Float64Array;
    const sc = this.data.subtree_com as Float64Array;
    const rootid = this.model.body_rootid as Int32Array;
    const bodies: BodyState[] = this.bodyIds.map((id) => {
      const wx = cv[id * 6]!,
        wy = cv[id * 6 + 1]!,
        wz = cv[id * 6 + 2]!;
      const px = xp[id * 3]!,
        py = xp[id * 3 + 1]!,
        pz = xp[id * 3 + 2]!;
      const r = rootid[id]!;
      const rx = px - sc[r * 3]!,
        ry = py - sc[r * 3 + 1]!,
        rz = pz - sc[r * 3 + 2]!;
      return {
        position: [px, py, pz],
        orientation: [xq[id * 4 + 1]!, xq[id * 4 + 2]!, xq[id * 4 + 3]!, xq[id * 4]!],
        angularVelocity: [wx, wy, wz],
        linearVelocity: [
          cv[id * 6 + 3]! + (wy * rz - wz * ry),
          cv[id * 6 + 4]! + (wz * rx - wx * rz),
          cv[id * 6 + 5]! + (wx * ry - wy * rx),
        ],
      };
    });
    const snap: PhysicsSnapshot = { bodies };
    // Stash the full reduced state so restore() of THIS snapshot is exact. MuJoCo's
    // joint coordinates can't be reconstructed from per-body world state in general
    // (a hinge body's qvel is a scalar angle-rate), so foreign snapshots can't be
    // restored — every real caller restores the same object it captured.
    this.native.set(snap, {
      qpos: Float64Array.from(this.data.qpos as Float64Array),
      qvel: Float64Array.from(this.data.qvel as Float64Array),
    });
    return snap;
  }

  restore(snapshot: PhysicsSnapshot): void {
    if (snapshot.bodies.length !== this.bodyIds.length) {
      throw new Error(
        `MujocoEngine.restore: snapshot has ${snapshot.bodies.length} bodies, world has ${this.bodyIds.length}`,
      );
    }
    const state = this.native.get(snapshot);
    if (!state) {
      console.warn(
        "mujoco: restore() needs the snapshot object produced by THIS engine's snapshot() — MuJoCo's reduced (joint) coordinates can't be rebuilt from per-body world state; leaving the world unchanged",
      );
      return;
    }
    (this.data.qpos as Float64Array).set(state.qpos);
    (this.data.qvel as Float64Array).set(state.qvel);
    this.dirty = true;
    this.sync(); // make pose() immediately reflect the restored state
  }

  get bodyCount(): number {
    return this.bodyIds.length;
  }

  dispose(): void {
    // Embind handles — free the wasm-side allocations.
    this.data?.delete?.();
    this.model?.delete?.();
    this.data = null;
    this.model = null;
    this.bodyIds = [];
  }
}

export class MujocoBackend implements PhysicsBackend {
  readonly name = "mujoco" as const;

  async init(): Promise<void> {
    if (!mj) mj = await loadMujoco();
  }

  createEngine(timestep: number): PhysicsEngine {
    if (!mj) throw new Error("MujocoBackend: init() must complete before createEngine()");
    return new MujocoEngine(timestep);
  }
}
