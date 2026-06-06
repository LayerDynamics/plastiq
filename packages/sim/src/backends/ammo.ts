// ammo.js (Bullet) physics backend, via ammojs-typed (wasm). Rigid bodies posed
// by world COM, each carrying a btCompoundShape of one or more convex-hull
// children (a compound collider for a decomposed concave part); hinge/fixed
// constraints become bt hinge/fixed joints.

import Ammo from "ammojs-typed";

import type { PhysicsBackend, PhysicsEngine, PhysicsPose, PhysicsSnapshot } from "../engine.js";
import type { SimManifest } from "../manifest.js";

type AmmoModule = Awaited<ReturnType<typeof Ammo>>;

let A: AmmoModule | null = null;

class AmmoEngine implements PhysicsEngine {
  private world: Ammo.btDiscreteDynamicsWorld | null = null;
  private bodies: Ammo.btRigidBody[] = [];
  private readonly tmp: Ammo.btTransform;
  // Reused identity transform for compound child shapes (freed in dispose()).
  private readonly childTransform: Ammo.btTransform;

  constructor(
    private readonly mod: AmmoModule,
    private readonly timestep: number,
  ) {
    this.tmp = new mod.btTransform();
    this.childTransform = new mod.btTransform();
    this.childTransform.setIdentity();
  }

  spawn(manifest: SimManifest): number {
    const m = this.mod;
    const config = new m.btDefaultCollisionConfiguration();
    const dispatcher = new m.btCollisionDispatcher(config);
    const broadphase = new m.btDbvtBroadphase();
    const solver = new m.btSequentialImpulseConstraintSolver();
    const world = new m.btDiscreteDynamicsWorld(dispatcher, broadphase, solver, config);
    const g = manifest.gravity;
    world.setGravity(new m.btVector3(g[0], g[1], g[2]));
    this.world = world;

    const byId = new Map<string, Ammo.btRigidBody>();
    const childTransform = this.childTransform;
    for (const b of manifest.bodies) {
      // A compound of one convex-hull child per piece (all at identity offset —
      // the pieces are already in the body's COM-centred frame).
      const shape = new m.btCompoundShape(true);
      for (const piece of b.colliders) {
        const hull = new m.btConvexHullShape();
        for (let k = 0; k < piece.points.length; k += 3) {
          hull.addPoint(
            new m.btVector3(piece.points[k]!, piece.points[k + 1]!, piece.points[k + 2]!),
            true,
          );
        }
        // Bullet's default convex margin (~0.04 m) inflates mm-scale CAD parts
        // and makes them rest visibly above surfaces — shrink it to 1 mm.
        hull.setMargin(0.001);
        shape.addChildShape(childTransform, hull);
      }
      const transform = new m.btTransform();
      transform.setIdentity();
      transform.setOrigin(new m.btVector3(b.com[0], b.com[1], b.com[2]));
      transform.setRotation(
        new m.btQuaternion(b.orientation[0], b.orientation[1], b.orientation[2], b.orientation[3]),
      );
      const motion = new m.btDefaultMotionState(transform);
      const mass = b.fixed ? 0 : b.mass;
      const inertia = new m.btVector3(0, 0, 0);
      if (mass > 0) shape.calculateLocalInertia(mass, inertia);
      const info = new m.btRigidBodyConstructionInfo(mass, motion, shape, inertia);
      const body = new m.btRigidBody(info);
      world.addRigidBody(body);
      this.bodies.push(body);
      byId.set(b.id, body);
    }

    for (const c of manifest.constraints) {
      const a = byId.get(c.bodyA);
      const b = byId.get(c.bodyB);
      if (!a || !b) {
        console.warn(
          `ammo: dropping ${c.kind} constraint — missing body (bodyA='${c.bodyA}'${a ? "" : " [missing]"}, bodyB='${c.bodyB}'${b ? "" : " [missing]"})`,
        );
        continue;
      }
      const ta = a.getWorldTransform().getOrigin();
      const tb = b.getWorldTransform().getOrigin();
      const pivotA = new m.btVector3(c.origin[0] - ta.x(), c.origin[1] - ta.y(), c.origin[2] - ta.z());
      const pivotB = new m.btVector3(c.origin[0] - tb.x(), c.origin[1] - tb.y(), c.origin[2] - tb.z());
      if (c.kind === "hinge") {
        const axisA = new m.btVector3(c.axis[0], c.axis[1], c.axis[2]);
        const axisB = new m.btVector3(c.axis[0], c.axis[1], c.axis[2]);
        world.addConstraint(new m.btHingeConstraint(a, b, pivotA, pivotB, axisA, axisB, false), true);
      } else {
        const frameA = new m.btTransform();
        frameA.setIdentity();
        frameA.setOrigin(pivotA);
        const frameB = new m.btTransform();
        frameB.setIdentity();
        frameB.setOrigin(pivotB);
        world.addConstraint(new m.btFixedConstraint(a, b, frameA, frameB), true);
      }
    }

    return this.bodies.length;
  }

  step(): void {
    this.world?.stepSimulation(this.timestep, 1, this.timestep);
  }

  pose(index: number): PhysicsPose {
    const body = this.bodies[index];
    if (!body) throw new Error(`AmmoEngine: no body at index ${index}`);
    body.getMotionState().getWorldTransform(this.tmp);
    const o = this.tmp.getOrigin();
    const q = this.tmp.getRotation();
    return { position: [o.x(), o.y(), o.z()], orientation: [q.x(), q.y(), q.z(), q.w()] };
  }

  snapshot(): PhysicsSnapshot {
    return {
      bodies: this.bodies.map((body) => {
        // Read the body's ACTUAL world (centre-of-mass) transform, not the motion
        // state: after a step the motion state holds the interpolated start-of-step
        // transform (one step behind), which would make a restore replay one step
        // behind. getWorldTransform() is the post-integration truth.
        const t = body.getWorldTransform();
        const o = t.getOrigin();
        const r = t.getRotation();
        const lv = body.getLinearVelocity();
        const av = body.getAngularVelocity();
        return {
          position: [o.x(), o.y(), o.z()],
          orientation: [r.x(), r.y(), r.z(), r.w()],
          linearVelocity: [lv.x(), lv.y(), lv.z()],
          angularVelocity: [av.x(), av.y(), av.z()],
        };
      }),
    };
  }

  restore(snapshot: PhysicsSnapshot): void {
    if (snapshot.bodies.length !== this.bodies.length) {
      throw new Error(
        `AmmoEngine.restore: snapshot has ${snapshot.bodies.length} bodies, world has ${this.bodies.length}`,
      );
    }
    const m = this.mod;
    const t = this.tmp;
    // Scratch Bullet objects, reused across bodies and freed at the end (Bullet
    // objects are manual wasm allocations).
    const origin = new m.btVector3(0, 0, 0);
    const rot = new m.btQuaternion(0, 0, 0, 1);
    const lin = new m.btVector3(0, 0, 0);
    const ang = new m.btVector3(0, 0, 0);
    try {
      snapshot.bodies.forEach((s, i) => {
        const body = this.bodies[i]!;
        origin.setValue(s.position[0], s.position[1], s.position[2]);
        rot.setValue(s.orientation[0], s.orientation[1], s.orientation[2], s.orientation[3]);
        t.setIdentity();
        t.setOrigin(origin);
        t.setRotation(rot);
        body.setWorldTransform(t);
        body.getMotionState().setWorldTransform(t);
        lin.setValue(s.linearVelocity[0], s.linearVelocity[1], s.linearVelocity[2]);
        ang.setValue(s.angularVelocity[0], s.angularVelocity[1], s.angularVelocity[2]);
        body.setLinearVelocity(lin);
        body.setAngularVelocity(ang);
        body.clearForces();
        body.activate(); // a body asleep at snapshot time must resume on restore
      });
    } finally {
      m.destroy(origin);
      m.destroy(rot);
      m.destroy(lin);
      m.destroy(ang);
    }
  }

  get bodyCount(): number {
    return this.bodies.length;
  }

  dispose(): void {
    const m = this.mod;
    const world = this.world;
    if (world) {
      // Bullet objects are manually-managed wasm allocations — free each body
      // explicitly (remove from the world, then destroy) rather than relying on
      // destroy(world) to cascade, then free the world and the cached transform.
      for (const body of this.bodies) {
        world.removeRigidBody(body);
        m.destroy(body);
      }
      m.destroy(world);
    }
    m.destroy(this.tmp);
    m.destroy(this.childTransform);
    this.world = null;
    this.bodies = [];
  }
}

export class AmmoBackend implements PhysicsBackend {
  readonly name = "ammo" as const;

  async init(): Promise<void> {
    if (A) return;
    // ammojs-typed's emscripten factory ends with `this.Ammo = b` (a legacy
    // attach-to-global). Under ESM strict mode — how vite bundles it for the
    // browser — the factory runs with `this === undefined`, so that line throws
    // "Cannot set properties of undefined (setting 'Ammo')". Node's non-strict
    // CJS tolerates it. Invoke it with a bound throwaway `this` so the attach is a
    // harmless no-op in both environments.
    A = await (Ammo as unknown as (this: object) => Promise<AmmoModule>).call({});
  }

  createEngine(timestep: number): PhysicsEngine {
    if (!A) throw new Error("AmmoBackend: init() must complete before createEngine()");
    return new AmmoEngine(A, timestep);
  }
}
