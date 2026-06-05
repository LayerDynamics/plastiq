// cannon-es physics backend (pure JS — no wasm). Box-collider rigid bodies posed
// by world COM; hinge/fixed constraints become Hinge/Lock constraints.

import * as CANNON from "cannon-es";

import type { PhysicsBackend, PhysicsEngine, PhysicsPose } from "../engine.js";
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
    for (const b of manifest.bodies) {
      const vertices: CANNON.Vec3[] = [];
      for (let k = 0; k < b.hull.points.length; k += 3) {
        vertices.push(new CANNON.Vec3(b.hull.points[k]!, b.hull.points[k + 1]!, b.hull.points[k + 2]!));
      }
      const shape = new CANNON.ConvexPolyhedron({ vertices, faces: b.hull.faces });
      const body = new CANNON.Body({
        mass: b.fixed ? 0 : b.mass,
        shape,
        position: new CANNON.Vec3(b.com[0], b.com[1], b.com[2]),
        quaternion: new CANNON.Quaternion(
          b.orientation[0],
          b.orientation[1],
          b.orientation[2],
          b.orientation[3],
        ),
      });
      world.addBody(body);
      this.bodies.push(body);
      byId.set(b.id, body);
    }

    for (const c of manifest.constraints) {
      const a = byId.get(c.bodyA);
      const b = byId.get(c.bodyB);
      if (!a || !b) continue;
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
