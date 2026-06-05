// ammo.js (Bullet) physics backend, via ammojs-typed (wasm). Box-collider rigid
// bodies posed by world COM; hinge/fixed constraints become bt hinge/fixed joints.

import Ammo from "ammojs-typed";

import type { PhysicsBackend, PhysicsEngine, PhysicsPose } from "../engine.js";
import type { SimManifest } from "../manifest.js";

type AmmoModule = Awaited<ReturnType<typeof Ammo>>;

let A: AmmoModule | null = null;

class AmmoEngine implements PhysicsEngine {
  private world: Ammo.btDiscreteDynamicsWorld | null = null;
  private bodies: Ammo.btRigidBody[] = [];
  private readonly tmp: Ammo.btTransform;

  constructor(
    private readonly mod: AmmoModule,
    private readonly timestep: number,
  ) {
    this.tmp = new mod.btTransform();
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
    for (const b of manifest.bodies) {
      const shape = new m.btBoxShape(
        new m.btVector3(b.halfExtents[0], b.halfExtents[1], b.halfExtents[2]),
      );
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
      if (!a || !b) continue;
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

  get bodyCount(): number {
    return this.bodies.length;
  }

  dispose(): void {
    const m = this.mod;
    if (this.world) m.destroy(this.world);
    this.world = null;
    this.bodies = [];
  }
}

export class AmmoBackend implements PhysicsBackend {
  readonly name = "ammo" as const;

  async init(): Promise<void> {
    if (!A) A = await Ammo();
  }

  createEngine(timestep: number): PhysicsEngine {
    if (!A) throw new Error("AmmoBackend: init() must complete before createEngine()");
    return new AmmoEngine(A, timestep);
  }
}
