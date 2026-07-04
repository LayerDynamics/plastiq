// Rapier physics backend (@dimforge/rapier3d-compat — self-contained wasm, runs
// in node and the browser). Each manifest body becomes a rigid body placed at its
// world COM, carrying one or more convex-hull colliders (a compound collider for
// a decomposed concave part); constraints become impulse joints.
//
// API LIMITATION (see the support matrix in engine.ts): rapier-compat's
// JointData.revolute/prismatic/generic take a SINGLE axis read in BOTH bodies'
// local frames (only JointData.fixed accepts per-body frames), so an axis-framed
// joint between bodies whose spawn orientations disagree about that axis cannot
// be built directly. Per kind:
//   hinge — when the two bodies' local views of the world axis agree, the native
//     revolute is exact; otherwise the hinge is COMPOSED from two spherical
//     joints pinned at two points along the world hinge axis (spherical joints
//     take anchors only, no frames, so they are exact for ANY orientations; two
//     pinned points on a line leave exactly the rotation about that line free).
//   ball — native spherical, exact for any orientations.
//   slider — native prismatic; requires the bodies' spawn orientations to be
//     EQUAL (all three rotations are locked, so the joint would otherwise fight
//     the spawn pose). Unequal orientations THROW at spawn.
//   cylindrical/planar — generic joint with the appropriate locked-axes mask;
//     requires the two bodies' local views of the axis to agree, else THROWS.
// Implemented-or-loud: no kind is silently dropped or built subtly wrong.

import RAPIER from "@dimforge/rapier3d-compat";

import type { PhysicsBackend, PhysicsEngine, PhysicsPose, PhysicsSnapshot } from "../engine.js";
import { hullVolume, type SimManifest } from "../manifest.js";
import { conjugate, localAnchor, localAxis, normalizeAxis, type SimQuat, type SimVec3 } from "../frame.js";

let ready = false;

/** Two unit vectors equal within a solver-irrelevant tolerance. */
function sameUnitVec(a: SimVec3, b: SimVec3): boolean {
  return (
    Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9 && Math.abs(a[2] - b[2]) < 1e-9
  );
}

/** Two orientations equal as ROTATIONS (q and −q are the same rotation). */
function sameRotation(a: SimQuat, b: SimQuat): boolean {
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  return 1 - Math.abs(dot) < 1e-9;
}

class RapierEngine implements PhysicsEngine {
  private world: RAPIER.World | null = null;
  private bodies: RAPIER.RigidBody[] = [];

  constructor(private readonly timestep: number) {}

  spawn(manifest: SimManifest): number {
    const g = manifest.gravity;
    const world = new RAPIER.World({ x: g[0], y: g[1], z: g[2] });
    world.timestep = this.timestep;
    this.world = world;

    const byId = new Map<string, RAPIER.RigidBody>();
    const orientById = new Map<string, [number, number, number, number]>();
    for (const b of manifest.bodies) {
      const desc = (b.fixed ? RAPIER.RigidBodyDesc.fixed() : RAPIER.RigidBodyDesc.dynamic())
        .setTranslation(b.com[0], b.com[1], b.com[2])
        .setRotation({ x: b.orientation[0], y: b.orientation[1], z: b.orientation[2], w: b.orientation[3] });
      const body = world.createRigidBody(desc);
      // One density shared across all pieces so the body's total mass is exactly
      // b.mass and its centre of mass stays at the (COM-centred) body origin.
      const totalVolume = b.colliders.reduce((sum, c) => sum + hullVolume(c), 0);
      const density = totalVolume > 0 ? b.mass / totalVolume : 0;
      for (const piece of b.colliders) {
        const collider = RAPIER.ColliderDesc.convexHull(new Float32Array(piece.points));
        if (!collider) throw new Error(`rapier: degenerate convex hull for body '${b.id}'`);
        collider.setDensity(density);
        world.createCollider(collider, body);
      }
      this.bodies.push(body);
      byId.set(b.id, body);
      orientById.set(b.id, b.orientation);
    }

    for (const c of manifest.constraints) {
      const a = byId.get(c.bodyA);
      const b = byId.get(c.bodyB);
      if (!a || !b) {
        // parseManifest rejects dangling refs before any backend runs — defensive.
        throw new Error(
          `rapier: ${c.kind} constraint references missing body '${!a ? c.bodyA : c.bodyB}'`,
        );
      }
      const qa = orientById.get(c.bodyA)!;
      const qb = orientById.get(c.bodyB)!;
      const ta = a.translation();
      const tb = b.translation();
      const pa: SimVec3 = [ta.x, ta.y, ta.z];
      const pb: SimVec3 = [tb.x, tb.y, tb.z];
      // Body-LOCAL anchors of the (world) joint origin — q⁻¹·(origin − translation),
      // identity-safe (reduces to the plain world delta for identity orientations).
      const la = localAnchor(c.origin, pa, qa);
      const lb = localAnchor(c.origin, pb, qb);
      const v = (x: SimVec3): RAPIER.Vector3 => new RAPIER.Vector3(x[0], x[1], x[2]);

      if (c.kind === "fixed") {
        // Each body's reference frame is its inverse orientation, so the joint
        // frames coincide in world space at spawn → locks the CURRENT relative
        // pose (identity frames would drive a rotated body back toward identity).
        const fa = conjugate(qa);
        const fb = conjugate(qb);
        world.createImpulseJoint(
          RAPIER.JointData.fixed(
            v(la),
            { x: fa[0], y: fa[1], z: fa[2], w: fa[3] },
            v(lb),
            { x: fb[0], y: fb[1], z: fb[2], w: fb[3] },
          ),
          a,
          b,
          true,
        );
        continue;
      }

      if (c.kind === "ball") {
        // Spherical takes anchors only (no frames) — exact for any orientations.
        world.createImpulseJoint(RAPIER.JointData.spherical(v(la), v(lb)), a, b, true);
        continue;
      }

      // The axis-framed kinds: the world axis seen from each body's local frame.
      const axisW = normalizeAxis(c.axis);
      const axA = localAxis(axisW, qa);
      const axB = localAxis(axisW, qb);

      if (c.kind === "hinge") {
        if (sameUnitVec(axA, axB)) {
          // Both bodies read the same local axis → the single-axis revolute is exact.
          world.createImpulseJoint(RAPIER.JointData.revolute(v(la), v(lb), v(axA)), a, b, true);
        } else {
          // Differently-oriented bodies: compose the hinge from TWO spherical
          // joints pinned at two points along the world hinge axis. Pinning two
          // distinct points of a line leaves exactly the rotation about that line
          // free (and locks translation along it) — a hinge, valid for ANY spawn
          // orientations since spherical joints carry no frames. The second pin is
          // separated by the mechanism's own scale (body distance, floored) so the
          // angular locking is well-conditioned.
          const d = Math.max(0.05, Math.hypot(pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]));
          const p2: SimVec3 = [
            c.origin[0] + axisW[0] * d,
            c.origin[1] + axisW[1] * d,
            c.origin[2] + axisW[2] * d,
          ];
          world.createImpulseJoint(RAPIER.JointData.spherical(v(la), v(lb)), a, b, true);
          world.createImpulseJoint(
            RAPIER.JointData.spherical(v(localAnchor(p2, pa, qa)), v(localAnchor(p2, pb, qb))),
            a,
            b,
            true,
          );
        }
        continue;
      }

      if (c.kind === "slider") {
        // Prismatic locks ALL rotation to the shared joint frame, which rapier
        // derives from ONE axis used in both local frames — only sound when the
        // spawn orientations are equal (then the frames coincide in world space).
        if (!sameRotation(qa, qb)) {
          throw new Error(
            `rapier: cannot express a slider between differently-oriented bodies '${c.bodyA}' and '${c.bodyB}' — rapier3d-compat's prismatic JointData has no per-body frames (see engine.ts support matrix); use the mujoco or ammo backend for this mechanism`,
          );
        }
        world.createImpulseJoint(RAPIER.JointData.prismatic(v(la), v(lb), v(axA)), a, b, true);
        continue;
      }

      // cylindrical / planar — generic joint with a locked-axes mask. The joint
      // frame comes from ONE local axis shared by both bodies, so both bodies must
      // read the same local axis (their spawn orientations may still differ by a
      // rotation ABOUT the axis — that DOF is free in both kinds).
      if (!sameUnitVec(axA, axB)) {
        throw new Error(
          `rapier: cannot express a ${c.kind} joint between bodies '${c.bodyA}' and '${c.bodyB}' whose orientations disagree about the joint axis — rapier3d-compat's generic JointData has no per-body frames (see engine.ts support matrix); use the mujoco or ammo backend for this mechanism`,
        );
      }
      const mask =
        c.kind === "cylindrical"
          ? // free: translation along + rotation about the axis (X); lock the rest.
            RAPIER.JointAxesMask.LinY |
            RAPIER.JointAxesMask.LinZ |
            RAPIER.JointAxesMask.AngY |
            RAPIER.JointAxesMask.AngZ
          : // planar: free in-plane translation (Y,Z) + rotation about the normal (X).
            RAPIER.JointAxesMask.LinX |
            RAPIER.JointAxesMask.AngY |
            RAPIER.JointAxesMask.AngZ;
      world.createImpulseJoint(RAPIER.JointData.generic(v(la), v(lb), v(axA), mask), a, b, true);
    }

    return this.bodies.length;
  }

  step(): void {
    this.world?.step();
  }

  pose(index: number): PhysicsPose {
    const body = this.bodies[index];
    if (!body) throw new Error(`RapierEngine: no body at index ${index}`);
    const t = body.translation();
    const r = body.rotation();
    return { position: [t.x, t.y, t.z], orientation: [r.x, r.y, r.z, r.w] };
  }

  snapshot(): PhysicsSnapshot {
    return {
      bodies: this.bodies.map((body) => {
        const t = body.translation();
        const r = body.rotation();
        const lv = body.linvel();
        const av = body.angvel();
        return {
          position: [t.x, t.y, t.z],
          orientation: [r.x, r.y, r.z, r.w],
          linearVelocity: [lv.x, lv.y, lv.z],
          angularVelocity: [av.x, av.y, av.z],
        };
      }),
    };
  }

  restore(snapshot: PhysicsSnapshot): void {
    if (snapshot.bodies.length !== this.bodies.length) {
      throw new Error(
        `RapierEngine.restore: snapshot has ${snapshot.bodies.length} bodies, world has ${this.bodies.length}`,
      );
    }
    snapshot.bodies.forEach((s, i) => {
      const body = this.bodies[i]!;
      body.setTranslation({ x: s.position[0], y: s.position[1], z: s.position[2] }, true);
      body.setRotation(
        { x: s.orientation[0], y: s.orientation[1], z: s.orientation[2], w: s.orientation[3] },
        true,
      );
      // Clear any accumulated force/torque, then set the restored velocities.
      body.resetForces(true);
      body.resetTorques(true);
      body.setLinvel(
        { x: s.linearVelocity[0], y: s.linearVelocity[1], z: s.linearVelocity[2] },
        true,
      );
      body.setAngvel(
        { x: s.angularVelocity[0], y: s.angularVelocity[1], z: s.angularVelocity[2] },
        true,
      );
    });
  }

  get bodyCount(): number {
    return this.bodies.length;
  }

  dispose(): void {
    this.world?.free();
    this.world = null;
    this.bodies = [];
  }
}

export class RapierBackend implements PhysicsBackend {
  readonly name = "rapier" as const;

  async init(): Promise<void> {
    if (ready) return;
    await RAPIER.init();
    ready = true;
  }

  createEngine(timestep: number): PhysicsEngine {
    if (!ready) throw new Error("RapierBackend: init() must complete before createEngine()");
    return new RapierEngine(timestep);
  }
}
