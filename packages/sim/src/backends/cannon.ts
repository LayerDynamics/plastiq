// cannon-es physics backend (pure JS — no wasm). Rigid bodies posed by world COM,
// each carrying one or more convex-hull shapes (a compound collider for a
// decomposed concave part); hinge/fixed constraints become Hinge/Lock constraints.

import * as CANNON from "cannon-es";

import type { PhysicsBackend, PhysicsEngine, PhysicsPose, PhysicsSnapshot } from "../engine.js";
import type { SimManifest } from "../manifest.js";

class CannonEngine implements PhysicsEngine {
  private world: CANNON.World | null = null;
  private bodies: CANNON.Body[] = [];

  constructor(private readonly timestep: number) {}

  spawn(manifest: SimManifest): number {
    const g = manifest.gravity;
    const world = new CANNON.World({ gravity: new CANNON.Vec3(g[0], g[1], g[2]) });
    this.world = world;

    const byId = new Map<string, CANNON.Body>();
    const origin = new CANNON.Vec3(0, 0, 0);
    for (const b of manifest.bodies) {
      const body = new CANNON.Body({
        mass: b.fixed ? 0 : b.mass,
        position: new CANNON.Vec3(b.com[0], b.com[1], b.com[2]),
        quaternion: new CANNON.Quaternion(
          b.orientation[0],
          b.orientation[1],
          b.orientation[2],
          b.orientation[3],
        ),
      });
      // Add each convex piece as a shape at zero offset (pieces are already in
      // the body's COM-centred frame).
      for (const piece of b.colliders) {
        const vertices: CANNON.Vec3[] = [];
        for (let k = 0; k < piece.points.length; k += 3) {
          vertices.push(new CANNON.Vec3(piece.points[k]!, piece.points[k + 1]!, piece.points[k + 2]!));
        }
        body.addShape(new CANNON.ConvexPolyhedron({ vertices, faces: piece.faces }), origin);
      }
      // Recompute the inertia tensor now that all pieces are attached.
      body.updateMassProperties();
      world.addBody(body);
      this.bodies.push(body);
      byId.set(b.id, body);
    }

    for (const c of manifest.constraints) {
      const a = byId.get(c.bodyA);
      const b = byId.get(c.bodyB);
      if (!a || !b) {
        console.warn(
          `cannon: dropping ${c.kind} constraint — missing body (bodyA='${c.bodyA}'${a ? "" : " [missing]"}, bodyB='${c.bodyB}'${b ? "" : " [missing]"})`,
        );
        continue;
      }
      const pivotA = new CANNON.Vec3(
        c.origin[0] - a.position.x,
        c.origin[1] - a.position.y,
        c.origin[2] - a.position.z,
      );
      const pivotB = new CANNON.Vec3(
        c.origin[0] - b.position.x,
        c.origin[1] - b.position.y,
        c.origin[2] - b.position.z,
      );
      if (c.kind === "hinge") {
        const axis = new CANNON.Vec3(c.axis[0], c.axis[1], c.axis[2]);
        world.addConstraint(
          new CANNON.HingeConstraint(a, b, { pivotA, pivotB, axisA: axis, axisB: axis }),
        );
      } else {
        world.addConstraint(new CANNON.LockConstraint(a, b));
      }
    }
    return this.bodies.length;
  }

  step(): void {
    this.world?.step(this.timestep);
  }

  pose(index: number): PhysicsPose {
    const body = this.bodies[index];
    if (!body) throw new Error(`CannonEngine: no body at index ${index}`);
    const p = body.position;
    const q = body.quaternion;
    return { position: [p.x, p.y, p.z], orientation: [q.x, q.y, q.z, q.w] };
  }

  snapshot(): PhysicsSnapshot {
    return {
      bodies: this.bodies.map((body) => {
        const p = body.position;
        const q = body.quaternion;
        const v = body.velocity;
        const w = body.angularVelocity;
        return {
          position: [p.x, p.y, p.z],
          orientation: [q.x, q.y, q.z, q.w],
          linearVelocity: [v.x, v.y, v.z],
          angularVelocity: [w.x, w.y, w.z],
        };
      }),
    };
  }

  restore(snapshot: PhysicsSnapshot): void {
    if (snapshot.bodies.length !== this.bodies.length) {
      throw new Error(
        `CannonEngine.restore: snapshot has ${snapshot.bodies.length} bodies, world has ${this.bodies.length}`,
      );
    }
    snapshot.bodies.forEach((s, i) => {
      const body = this.bodies[i]!;
      body.position.set(s.position[0], s.position[1], s.position[2]);
      body.quaternion.set(s.orientation[0], s.orientation[1], s.orientation[2], s.orientation[3]);
      body.velocity.set(s.linearVelocity[0], s.linearVelocity[1], s.linearVelocity[2]);
      body.angularVelocity.set(s.angularVelocity[0], s.angularVelocity[1], s.angularVelocity[2]);

      // Clear accumulated forces and torques so the restored state starts clean.
      body.force.set(0, 0, 0);
      body.torque.set(0, 0, 0);

      // Sync the integrator's previous-step state so stepping resumes from the
      // restored pose without an interpolation jump, and wake a sleeping body.
      body.previousPosition.copy(body.position);
      body.previousQuaternion.copy(body.quaternion);
      body.wakeUp();
    });
  }

  get bodyCount(): number {
    return this.bodies.length;
  }

  dispose(): void {
    this.world = null;
    this.bodies = [];
  }
}

export class CannonBackend implements PhysicsBackend {
  readonly name = "cannon" as const;

  async init(): Promise<void> {
    // cannon-es is pure JS — nothing to load.
  }

  createEngine(timestep: number): PhysicsEngine {
    return new CannonEngine(timestep);
  }
}
