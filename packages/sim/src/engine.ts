// The pluggable physics contract. One PhysicsEngine interface, implemented by
// selectable backends (MuJoCo — the default — plus Rapier, ammo.js, cannon-es),
// chosen at init time.
//
// CONSTRAINT SUPPORT MATRIX — the backends are NOT uniformly interchangeable
// across the full constraint vocabulary. Every kind×backend cell is either
// implemented or fails LOUDLY at spawn() (a thrown error naming the backend and
// kind); nothing is silently dropped or approximated without saying so:
//
//   kind        │ mujoco                    │ rapier                     │ ammo                  │ cannon
//   ────────────┼───────────────────────────┼────────────────────────────┼───────────────────────┼──────────────────────
//   hinge       │ tree <joint type=hinge>;  │ native revolute when both  │ btHingeConstraint     │ HingeConstraint
//               │ loop-closing hinge = two  │ bodies see the same local  │ (per-body pivot+axis) │ (per-body pivot+axis)
//               │ <connect> equalities at   │ axis, else composed from   │                       │
//               │ two points on the axis    │ TWO spherical joints on    │                       │
//               │                           │ the axis (any orientation) │                       │
//   slider      │ tree <joint type=slide>;  │ native prismatic; THROWS   │ btSliderConstraint    │ THROWS (no sound
//               │ loop-closing slider =     │ for bodies whose spawn     │ (lin free, ang locked)│ slider exists in
//               │ <weld> (slide DOF lost —  │ orientations differ (the   │                       │ cannon-es primitives)
//               │ warned + documented)      │ single-frame API cannot    │                       │
//               │                           │ express it)                │                       │
//   cylindrical │ tree slide+hinge pair on  │ generic joint (LinY/LinZ/  │ btSliderConstraint    │ THROWS
//               │ the axis; loop-closing    │ AngY/AngZ locked); THROWS  │ with rotation         │
//               │ THROWS (inexpressible)    │ when the two bodies see    │ unlocked              │
//               │                           │ different local axes       │                       │
//   ball        │ tree <joint type=ball>;   │ native spherical (any      │ btPoint2Point-        │ PointToPoint-
//               │ loop-closing ball = one   │ orientation)               │ Constraint            │ Constraint
//               │ <connect> equality        │                            │                       │
//   planar      │ tree slide+slide+hinge    │ generic joint (LinX/AngY/  │ btGeneric6Dof-        │ THROWS
//               │ (in-plane axes + normal); │ AngZ locked); THROWS when  │ Constraint (X locked, │
//               │ loop-closing THROWS       │ the two bodies see         │ YZ free, AngX free)   │
//               │                           │ different local normals    │                       │
//   fixed       │ tree weld (no joint);     │ native fixed (per-body     │ btFixedConstraint     │ LockConstraint
//               │ loop-closing = <weld>     │ frames)                    │                       │
//
// Rapier's THROWS cells stem from @dimforge/rapier3d-compat's JointData API: its
// prismatic/generic constructors take ONE axis read in BOTH bodies' local frames
// (only JointData.fixed accepts per-body frames), so a slider/cylindrical/planar
// between bodies whose spawn orientations disagree about that axis cannot be
// expressed — spawn() throws rather than building a subtly wrong joint. Hinges and
// balls are composed from spherical joints, which need no frames, so they work for
// ANY orientations. Constraints that reference missing bodies and manifests with
// duplicate body ids are rejected by parseManifest/isSimManifest before any
// backend sees them; the backends keep a defensive throw for the same conditions.

import type { SimManifest } from "./manifest.js";

export interface PhysicsPose {
  position: [number, number, number];
  orientation: [number, number, number, number];
}

/** The full dynamic state of one body — pose AND velocities, so restoring it
 * reproduces the simulation forward from this point (pose alone would discard the
 * momentum and diverge). */
export interface BodyState {
  position: [number, number, number];
  orientation: [number, number, number, number];
  linearVelocity: [number, number, number];
  angularVelocity: [number, number, number];
}

/** A capture of every spawned body's full state, in spawn order. Snapshot a world,
 * step it, and `restore()` to rewind to that exact state (save/rewind/replay). */
export interface PhysicsSnapshot {
  readonly bodies: BodyState[];
}

export interface PhysicsEngine {
  /** Number of spawned bodies. */
  readonly bodyCount: number;
  /** Build the world from a manifest (gravity + bodies + constraints). Returns body count. */
  spawn(manifest: SimManifest): number;
  /** Advance one fixed timestep. */
  step(): void;
  /** Current world pose (COM position + orientation) of spawned body `index`. */
  pose(index: number): PhysicsPose;
  /** Capture every body's full dynamic state (pose + velocities), in spawn order. */
  snapshot(): PhysicsSnapshot;
  /** Restore every body to a previously captured snapshot (same body count). */
  restore(snapshot: PhysicsSnapshot): void;
  /** Release any native/wasm resources. */
  dispose(): void;
}

export type BackendName = "rapier" | "ammo" | "cannon" | "mujoco";

export interface PhysicsBackend {
  readonly name: BackendName;
  /** Load the backend (wasm init etc.). Idempotent. */
  init(): Promise<void>;
  /** Create a fresh engine bound to a fixed `timestep` (seconds). */
  createEngine(timestep: number): PhysicsEngine;
}
