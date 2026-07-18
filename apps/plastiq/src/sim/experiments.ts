// Physics experiment recipes (UX layer on top of @plastiq/sim).
// Pure transforms of a lowered SimManifest so the user can run meaningful
// experiments directly on their CAD geometry — drop tests, free fall, rest on
// ground, zero-g — without hand-authoring manifests.

import type { SimManifest, ManifestBody, HullCollider } from "@plastiq/sim";
import { quatRotate, type Quat, type Vec3 } from "../assembly/model.js";

export type SimExperimentKind = "free-fall" | "drop-test" | "rest" | "zero-g";

export type SimBackendChoice = "default" | "mujoco" | "rapier" | "ammo" | "cannon";

export interface SimExperimentConfig {
  kind: SimExperimentKind;
  /** Multiplier on the manifest gravity vector (1 = Earth, 0.16 ≈ Moon). */
  gravityScale: number;
  /** Extra lift (metres) applied to dynamic bodies for drop-test / free-fall. */
  dropHeight: number;
  /** Inject a large static ground slab under the lowest body (when the kind allows it). */
  ground: boolean;
  /** Physics backend (`default` → MuJoCo). */
  backend: SimBackendChoice;
}

export const DEFAULT_SIM_EXPERIMENT: SimExperimentConfig = {
  kind: "drop-test",
  gravityScale: 1,
  dropHeight: 0.15,
  ground: true,
  backend: "default",
};

export interface BodyTelemetry {
  id: string;
  /** World COM position (m). */
  position: [number, number, number];
  /** |linear velocity| (m/s). */
  speed: number;
  /** Vertical COM (Z-up). */
  z: number;
  fixed: boolean;
}

export interface SimTelemetry {
  /** Elapsed sim time (s). */
  time: number;
  /** Experiment kind that produced this run. */
  kind: SimExperimentKind;
  bodies: BodyTelemetry[];
  /** Max |speed| across dynamic bodies this tick. */
  maxSpeed: number;
  /** Lowest dynamic-body Z (for ground-contact intuition). */
  minDynamicZ: number | null;
  /** True when all dynamic bodies are nearly still (settled after a drop). */
  settled: boolean;
}

const EARTH_G: [number, number, number] = [0, 0, -9.81];

/** Speed below which a dynamic body is considered at rest (m/s). */
export const SETTLED_SPEED = 0.02;

/** Thin ground slab hull (half-extents), COM-centred. */
function groundHull(hx: number, hy: number, hz: number): HullCollider {
  return {
    points: [
      -hx, -hy, -hz, hx, -hy, -hz, hx, hy, -hz, -hx, hy, -hz, -hx, -hy, hz, hx, -hy, hz, hx, hy, hz,
      -hx, hy, hz,
    ],
    faces: [
      [0, 3, 2],
      [0, 2, 1],
      [4, 5, 6],
      [4, 6, 7],
      [0, 1, 5],
      [0, 5, 4],
      [3, 7, 6],
      [3, 6, 2],
      [0, 4, 7],
      [0, 7, 3],
      [1, 2, 6],
      [1, 6, 5],
    ],
  };
}

function scaleGravity(
  g: readonly [number, number, number],
  scale: number,
): [number, number, number] {
  return [g[0] * scale, g[1] * scale, g[2] * scale];
}

function asVec3(g: readonly number[] | undefined): [number, number, number] {
  if (g && g.length >= 3 && Number.isFinite(g[0]) && Number.isFinite(g[1]) && Number.isFinite(g[2])) {
    return [g[0]!, g[1]!, g[2]!];
  }
  return [...EARTH_G];
}

function bodyMinMaxZ(b: ManifestBody): { min: number; max: number } {
  // Vertical extent from hull points + COM. Collider points are COM-local, so
  // each point is rotated by the body's spawn orientation before its world z is
  // read (§2.11.5 — the unrotated extent was wrong for any rotated instance:
  // a tall part lying on its side got the standing part's ground height).
  const [qx, qy, qz, qw] = b.orientation;
  const identity = qx === 0 && qy === 0 && qz === 0 && qw === 1;
  const q = b.orientation as Quat;
  let min = Infinity;
  let max = -Infinity;
  for (const c of b.colliders) {
    for (let i = 2; i < c.points.length; i += 3) {
      const local: Vec3 = [c.points[i - 2]!, c.points[i - 1]!, c.points[i]!];
      const z = b.com[2] + (identity ? local[2] : quatRotate(q, local)[2]);
      if (z < min) min = z;
      if (z > max) max = z;
    }
  }
  if (!Number.isFinite(min)) {
    min = b.com[2];
    max = b.com[2];
  }
  return { min, max };
}

/**
 * Whether this experiment injects a static ground plane under the CAD geometry.
 * Drop-test and rest always need one; free-fall and zero-g never inject it.
 */
export function experimentWantsGround(cfg: Pick<SimExperimentConfig, "kind" | "ground">): boolean {
  if (cfg.kind === "drop-test" || cfg.kind === "rest") return true;
  if (cfg.kind === "free-fall" || cfg.kind === "zero-g") return false;
  return cfg.ground;
}

/**
 * Apply an experiment recipe to a lowered CAD manifest. Returns a new manifest
 * (does not mutate the input). Dynamic bodies may be lifted; gravity rewritten;
 * optional static ground injected.
 */
export function applyExperiment(
  manifest: SimManifest,
  cfg: SimExperimentConfig,
): SimManifest {
  const srcG = asVec3(manifest.gravity);
  const srcLen = Math.hypot(srcG[0], srcG[1], srcG[2]);
  const gravity: [number, number, number] =
    cfg.kind === "zero-g"
      ? [0, 0, 0]
      : scaleGravity(srcLen > 1e-9 ? srcG : EARTH_G, cfg.gravityScale);

  const lift =
    cfg.kind === "drop-test" || cfg.kind === "free-fall"
      ? Math.max(0, cfg.dropHeight)
      : cfg.kind === "rest"
        ? Math.max(0, cfg.dropHeight) * 0.25 // small clearance so contact settles
        : 0;

  const bodies: ManifestBody[] = manifest.bodies.map((b) => {
    if (b.fixed) {
      return {
        ...b,
        com: [...b.com] as [number, number, number],
        orientation: [...b.orientation] as [number, number, number, number],
        colliders: b.colliders.map((c) => ({
          points: [...c.points],
          faces: c.faces.map((f) => [...f]),
        })),
      };
    }
    return {
      ...b,
      com: [b.com[0], b.com[1], b.com[2] + lift] as [number, number, number],
      orientation: [...b.orientation] as [number, number, number, number],
      colliders: b.colliders.map((c) => ({
        points: [...c.points],
        faces: c.faces.map((f) => [...f]),
      })),
    };
  });

  if (experimentWantsGround(cfg)) {
    // Place ground just under the lowest dynamic extent (after lift).
    let lowest = Infinity;
    for (const b of bodies) {
      if (b.fixed) continue;
      const { min } = bodyMinMaxZ(b);
      if (min < lowest) lowest = min;
    }
    if (!Number.isFinite(lowest)) {
      // No dynamics — still add a ground under the fixed parts for visuals.
      for (const b of bodies) {
        const { min } = bodyMinMaxZ(b);
        if (min < lowest) lowest = min;
      }
    }
    if (!Number.isFinite(lowest)) lowest = 0;
    const groundHalfH = 0.02;
    const groundTop = lowest - 0.005; // small gap so they fall onto contact
    const groundComZ = groundTop - groundHalfH;
    // Wide enough for typical parts (metres).
    bodies.push({
      id: "__experiment_ground",
      mass: 0,
      com: [0, 0, groundComZ],
      orientation: [0, 0, 0, 1],
      colliders: [groundHull(2, 2, groundHalfH)],
      fixed: true,
    });
  }

  return {
    version: 1,
    source: `${manifest.source}|exp:${cfg.kind}`,
    gravity,
    bodies,
    constraints: manifest.constraints.map((c) => ({ ...c })),
  };
}

/** Human labels for the experiment picker. */
export const EXPERIMENT_LABELS: Record<SimExperimentKind, string> = {
  "free-fall": "Free fall (no ground)",
  "drop-test": "Drop test (lift + ground)",
  rest: "Rest on ground",
  "zero-g": "Zero gravity",
};

/** Short help text shown in the experiments panel. */
export const EXPERIMENT_HELP: Record<SimExperimentKind, string> = {
  "drop-test":
    "Lifts your part above a ground plane and drops it — watch impact and bounce settle.",
  "free-fall": "Lifts the part and falls under gravity with no ground plane (unbounded drop).",
  rest: "Places the part just above ground so contact settles with minimal drop.",
  "zero-g": "Clears gravity — useful for checking joints and free-body motion.",
};

/**
 * Build telemetry from body poses + optional speeds (m/s). `fixedIds` marks
 * static bodies (ground / Fix) so the UI can de-emphasize them.
 */
export function buildTelemetry(
  time: number,
  kind: SimExperimentKind,
  bodies: {
    id: string;
    position: [number, number, number];
    speed: number;
    fixed: boolean;
  }[],
): SimTelemetry {
  let maxSpeed = 0;
  let minDynamicZ: number | null = null;
  let anyDynamic = false;
  let allSettled = true;
  for (const b of bodies) {
    if (b.speed > maxSpeed) maxSpeed = b.speed;
    if (!b.fixed) {
      anyDynamic = true;
      if (minDynamicZ === null || b.position[2] < minDynamicZ) minDynamicZ = b.position[2];
      if (b.speed > SETTLED_SPEED) allSettled = false;
    }
  }
  return {
    time,
    kind,
    bodies: bodies.map((b) => ({
      id: b.id,
      position: b.position,
      speed: b.speed,
      z: b.position[2],
      fixed: b.fixed,
    })),
    maxSpeed,
    minDynamicZ,
    settled: anyDynamic && allSettled && time > 0.05,
  };
}
