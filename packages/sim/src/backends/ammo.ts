// ammo.js (Bullet) physics backend, via ammojs-typed (wasm). Rigid bodies posed
// by world COM, each carrying a btCompoundShape of one or more convex-hull
// children (a compound collider for a decomposed concave part); hinge/fixed
// constraints become bt hinge/fixed joints.

import Ammo from "ammojs-typed";

import type { BodyState, PhysicsBackend, PhysicsEngine, PhysicsPose, PhysicsSnapshot } from "../engine.js";
import type { SimManifest } from "../manifest.js";
import { conjugate, localAnchor, localAxis } from "../frame.js";

type AmmoModule = Awaited<ReturnType<typeof Ammo>>;

let A: AmmoModule | null = null;

export class AmmoEngine implements PhysicsEngine {
  private world: Ammo.btDiscreteDynamicsWorld | null = null;
  private bodies: Ammo.btRigidBody[] = [];
  // Long-lived wasm objects that outlive spawn() and must be freed in dispose().
  // Bullet's destructors do NOT cascade to objects the world/bodies merely
  // reference — the world does not own the dispatch stack, a body does not own its
  // shape or motion state, and a compound does not own its child shapes — so spawn()
  // records each here and dispose() frees them explicitly. Everything else spawn()
  // allocates (vectors, quaternions, transforms, the construction info) is transient
  // scratch, freed inline as soon as Bullet has copied it, mirroring restore()'s
  // scratch-in-finally discipline.
  private collisionConfig: Ammo.btDefaultCollisionConfiguration | null = null;
  private dispatcher: Ammo.btCollisionDispatcher | null = null;
  private broadphase: Ammo.btDbvtBroadphase | null = null;
  private solver: Ammo.btSequentialImpulseConstraintSolver | null = null;
  private shapes: Ammo.btCollisionShape[] = [];
  private motionStates: Ammo.btMotionState[] = [];
  private constraints: Ammo.btTypedConstraint[] = [];
  private readonly tmp: Ammo.btTransform;
  // Reused identity transform for compound child shapes (freed in dispose()).
  private readonly childTransform: Ammo.btTransform;
  // Bullet objects are manual wasm allocations; dispose() frees tmp/childTransform
  // unconditionally, so a second call would double-free. Guard for idempotency.
  private disposed = false;

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
    // Track the dispatch stack + world for dispose() — none is owned by another, so
    // none is freed by another's destructor.
    this.collisionConfig = config;
    this.dispatcher = dispatcher;
    this.broadphase = broadphase;
    this.solver = solver;
    this.world = world;

    const g = manifest.gravity;
    const gravity = new m.btVector3(g[0], g[1], g[2]);
    world.setGravity(gravity);
    m.destroy(gravity); // setGravity copies the vector — scratch

    const byId = new Map<string, Ammo.btRigidBody>();
    const orientById = new Map<string, [number, number, number, number]>();
    const childTransform = this.childTransform;
    for (const b of manifest.bodies) {
      // A compound of one convex-hull child per piece (all at identity offset —
      // the pieces are already in the body's COM-centred frame).
      const shape = new m.btCompoundShape(true);
      this.shapes.push(shape);
      for (const piece of b.colliders) {
        const hull = new m.btConvexHullShape();
        this.shapes.push(hull);
        for (let k = 0; k < piece.points.length; k += 3) {
          const p = new m.btVector3(piece.points[k]!, piece.points[k + 1]!, piece.points[k + 2]!);
          hull.addPoint(p, true); // addPoint copies the point into the hull's buffer
          m.destroy(p); // scratch — the hull keeps its own copy
        }
        // Bullet's default convex margin (~0.04 m) inflates mm-scale CAD parts
        // and makes them rest visibly above surfaces — shrink it to 1 mm.
        hull.setMargin(0.001);
        shape.addChildShape(childTransform, hull); // copies the transform, refs the hull
      }
      const transform = new m.btTransform();
      transform.setIdentity();
      const origin = new m.btVector3(b.com[0], b.com[1], b.com[2]);
      transform.setOrigin(origin);
      const quat = new m.btQuaternion(
        b.orientation[0], b.orientation[1], b.orientation[2], b.orientation[3],
      );
      transform.setRotation(quat);
      const motion = new m.btDefaultMotionState(transform); // copies the transform
      this.motionStates.push(motion);
      const mass = b.fixed ? 0 : b.mass;
      const inertia = new m.btVector3(0, 0, 0);
      if (mass > 0) shape.calculateLocalInertia(mass, inertia);
      const info = new m.btRigidBodyConstructionInfo(mass, motion, shape, inertia);
      const body = new m.btRigidBody(info); // refs motion + shape (kept); copies inertia
      // The construction info, the source transform, and the scratch vectors are all
      // consumed synchronously above — free them now (the body/motion keep copies).
      m.destroy(info);
      m.destroy(inertia);
      m.destroy(quat);
      m.destroy(origin);
      m.destroy(transform);
      world.addRigidBody(body);
      this.bodies.push(body);
      byId.set(b.id, body);
      orientById.set(b.id, b.orientation);
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
      // Anchors/axes/frames are body-LOCAL: inverse-rotate the world origin/axis by
      // each body's orientation (identity-safe — reduces to `origin − translation`
      // and the raw axis when orientation is identity).
      const qa = orientById.get(c.bodyA)!;
      const qb = orientById.get(c.bodyB)!;
      const ta = a.getWorldTransform().getOrigin();
      const tb = b.getWorldTransform().getOrigin();
      const la = localAnchor(c.origin, [ta.x(), ta.y(), ta.z()], qa);
      const lb = localAnchor(c.origin, [tb.x(), tb.y(), tb.z()], qb);
      const pivotA = new m.btVector3(la[0], la[1], la[2]);
      const pivotB = new m.btVector3(lb[0], lb[1], lb[2]);
      if (c.kind === "hinge") {
        const axA = localAxis(c.axis, qa);
        const axB = localAxis(c.axis, qb);
        const axisA = new m.btVector3(axA[0], axA[1], axA[2]);
        const axisB = new m.btVector3(axB[0], axB[1], axB[2]);
        const hinge = new m.btHingeConstraint(a, b, pivotA, pivotB, axisA, axisB, false);
        this.constraints.push(hinge);
        world.addConstraint(hinge, true);
        m.destroy(axisA); // the constraint built its frames from these — scratch
        m.destroy(axisB);
      } else {
        // Fixed: each body's reference-frame basis is its inverse orientation, so the
        // frames coincide in world space at spawn → locks the CURRENT relative pose
        // (an identity basis would instead drive the body back toward identity).
        const fa = conjugate(qa);
        const fb = conjugate(qb);
        const frameA = new m.btTransform();
        frameA.setIdentity();
        frameA.setOrigin(pivotA);
        const fqa = new m.btQuaternion(fa[0], fa[1], fa[2], fa[3]);
        frameA.setRotation(fqa);
        const frameB = new m.btTransform();
        frameB.setIdentity();
        frameB.setOrigin(pivotB);
        const fqb = new m.btQuaternion(fb[0], fb[1], fb[2], fb[3]);
        frameB.setRotation(fqb);
        const fixed = new m.btFixedConstraint(a, b, frameA, frameB);
        this.constraints.push(fixed);
        world.addConstraint(fixed, true);
        // The constraint copied both frames — free the frames and their scratch quats.
        m.destroy(fqa);
        m.destroy(fqb);
        m.destroy(frameA);
        m.destroy(frameB);
      }
      m.destroy(pivotA); // copied into the constraint's frames above — scratch
      m.destroy(pivotB);
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
    const o = this.tmp.getOrigin(); // a reference into tmp — do NOT free
    const q = this.tmp.getRotation(); // a fresh btQuaternion BY VALUE — must free
    const pose: PhysicsPose = { position: [o.x(), o.y(), o.z()], orientation: [q.x(), q.y(), q.z(), q.w()] };
    this.mod.destroy(q);
    return pose;
  }

  snapshot(): PhysicsSnapshot {
    const m = this.mod;
    return {
      bodies: this.bodies.map((body) => {
        // Read the body's ACTUAL world (centre-of-mass) transform, not the motion
        // state: after a step the motion state holds the interpolated start-of-step
        // transform (one step behind), which would make a restore replay one step
        // behind. getWorldTransform() is the post-integration truth.
        const t = body.getWorldTransform(); // a reference — do NOT free
        const o = t.getOrigin(); // a reference into t — do NOT free
        const r = t.getRotation(); // a fresh btQuaternion BY VALUE — must free
        const lv = body.getLinearVelocity(); // a reference — do NOT free
        const av = body.getAngularVelocity(); // a reference — do NOT free
        const state: BodyState = {
          position: [o.x(), o.y(), o.z()],
          orientation: [r.x(), r.y(), r.z(), r.w()],
          linearVelocity: [lv.x(), lv.y(), lv.z()],
          angularVelocity: [av.x(), av.y(), av.z()],
        };
        m.destroy(r);
        return state;
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
    if (this.disposed) return; // idempotent — never double-free the wasm objects
    this.disposed = true;
    const m = this.mod;
    const world = this.world;
    if (world) {
      // Teardown obeys Bullet's manual ownership and reference order: constraints
      // come off the world and are freed FIRST (deleting a body still referenced by a
      // live constraint is undefined behaviour), then the bodies, then the world
      // itself. None of those destructors cascades to the objects the world/bodies
      // only point at, so the motion states, collision shapes, and the dispatch stack
      // (solver/broadphase/dispatcher/config) are freed explicitly afterwards.
      for (const c of this.constraints) {
        world.removeConstraint(c);
        m.destroy(c);
      }
      for (const body of this.bodies) {
        world.removeRigidBody(body);
        m.destroy(body);
      }
      m.destroy(world);
    }
    for (const motion of this.motionStates) m.destroy(motion);
    for (const shape of this.shapes) m.destroy(shape);
    if (this.solver) m.destroy(this.solver);
    if (this.broadphase) m.destroy(this.broadphase);
    if (this.dispatcher) m.destroy(this.dispatcher);
    if (this.collisionConfig) m.destroy(this.collisionConfig);
    m.destroy(this.tmp);
    m.destroy(this.childTransform);
    this.world = null;
    this.bodies = [];
    this.constraints = [];
    this.motionStates = [];
    this.shapes = [];
    this.solver = null;
    this.broadphase = null;
    this.dispatcher = null;
    this.collisionConfig = null;
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
