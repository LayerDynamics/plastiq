// Rapier physics backend (@dimforge/rapier3d-compat — self-contained wasm, runs
// in node and the browser). Each manifest body becomes a rigid body placed at its
// world COM, carrying one or more convex-hull colliders (a compound collider for
// a decomposed concave part); hinge/fixed constraints become impulse joints.

import RAPIER from "@dimforge/rapier3d-compat";

import type { PhysicsBackend, PhysicsEngine, PhysicsPose, PhysicsSnapshot } from "../engine.js";
import { hullVolume, type SimManifest } from "../manifest.js";
import { conjugate, localAnchor } from "../frame.js";

let ready = false;

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
        console.warn(
          `rapier: dropping ${c.kind} constraint — missing body (bodyA='${c.bodyA}'${a ? "" : " [missing]"}, bodyB='${c.bodyB}'${b ? "" : " [missing]"})`,
        );
        continue;
      }
      const qa = orientById.get(c.bodyA)!;
      const qb = orientById.get(c.bodyB)!;
      const ta = a.translation();
      const tb = b.translation();
      let data: RAPIER.JointData;
      if (c.kind === "hinge") {
        // LIMITATION: rapier-compat's `JointData.revolute` takes a SINGLE axis read
        // in each body's joint frame and exposes no per-body axis/frame override
        // that affects the built joint, so a world-axis hinge between
        // differently-oriented bodies cannot be expressed here (ammo/cannon, with
        // per-body axes, handle it correctly). For the common identity-orientation
        // case this is exact; we therefore pass the world delta + world axis (which
        // equals the body-local value when orientation is identity).
        const anchorA = { x: c.origin[0] - ta.x, y: c.origin[1] - ta.y, z: c.origin[2] - ta.z };
        const anchorB = { x: c.origin[0] - tb.x, y: c.origin[1] - tb.y, z: c.origin[2] - tb.z };
        data = RAPIER.JointData.revolute(anchorA, anchorB, {
          x: c.axis[0],
          y: c.axis[1],
          z: c.axis[2],
        });
      } else {
        // Fixed: anchors are body-LOCAL (q⁻¹·(origin − translation)) and each body's
        // reference frame is its inverse orientation, so the joint frames coincide in
        // world space at spawn → locks the CURRENT relative pose. Identity-safe
        // (reduces to the world delta + identity frame when orientation is identity);
        // identity frames here would instead drive a rotated body back toward identity.
        const la = localAnchor(c.origin, [ta.x, ta.y, ta.z], qa);
        const lb = localAnchor(c.origin, [tb.x, tb.y, tb.z], qb);
        const fa = conjugate(qa);
        const fb = conjugate(qb);
        data = RAPIER.JointData.fixed(
          { x: la[0], y: la[1], z: la[2] },
          { x: fa[0], y: fa[1], z: fa[2], w: fa[3] },
          { x: lb[0], y: lb[1], z: lb[2] },
          { x: fb[0], y: fb[1], z: fb[2], w: fb[3] },
        );
      }
      world.createImpulseJoint(data, a, b, true);
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
