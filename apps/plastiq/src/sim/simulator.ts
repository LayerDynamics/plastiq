// In-editor Simulate (SPEC-5 M6.1, FR-41). Spawns the model's SimManifest into
// the in-browser physics engine (@plastiq/sim) and steps it under gravity; each frame
// the live body poses are mapped back to the render groups. This is transient
// VIEW state — it never writes to the document, so "return to edit" is just
// re-deriving the render from the (untouched) document.
//
// The sim reports each body's world CENTRE OF MASS + orientation; the render
// group is the part's local-origin geometry, so the render-back inverts the
// lowering's COM composition: groupPos = comPos − R(ori)·localCom.

import { initSim, PredictionSim, type BackendName } from "@plastiq/sim";
import { quatRotate, type Quat, type Vec3 } from "../assembly/model.js";

export interface BodyRenderPose {
  id: string;
  position: Vec3;
  orientation: Quat;
}

/** Map a sim body's world-COM pose to its render group's origin pose (pure). */
export function bodyPoseToGroup(
  comPos: Vec3,
  orientation: Quat,
  localCom: Vec3,
): {
  position: Vec3;
  orientation: Quat;
} {
  const r = quatRotate(orientation, localCom);
  return {
    position: [comPos[0] - r[0], comPos[1] - r[1], comPos[2] - r[2]],
    orientation: [...orientation],
  };
}

/** Fixed integration rate (Hz). Exposed so the UI can show elapsed sim-time. */
export const SIM_TICK_RATE_HZ = 120;
const SEED = 1n;

export class Simulator {
  private sim: PredictionSim | null = null;
  /** State captured right after spawn, so playback can rewind to the start. */
  private initialSnapshot: ReturnType<PredictionSim["snapshot"]> | null = null;
  /** Fixed ticks advanced since start (or the last rewind) — drives the readout. */
  private ticksAdvanced = 0;

  /**
   * @param manifestJson the lowered SimManifest (JSON)
   * @param localCom     the shared part's local centre of mass
   * @param instanceIds  render-group ids in manifest body order (body i ↔ id i)
   */
  constructor(
    private readonly manifestJson: string,
    private readonly localCom: Vec3,
    private readonly instanceIds: readonly string[],
  ) {}

  /**
   * Load the sim backend (default MuJoCo; pass `backend` to use rapier, ammo or
   * cannon) + spawn the manifest. Returns the body count.
   */
  async start(backend?: BackendName): Promise<number> {
    await initSim(backend ? { backend } : undefined);
    const sim = new PredictionSim(SIM_TICK_RATE_HZ, SEED);
    const count = sim.spawnManifest(this.manifestJson);
    this.sim = sim;
    // Capture the spawned state so rewind() can return to it exactly.
    this.initialSnapshot = sim.snapshot();
    this.ticksAdvanced = 0;
    return count;
  }

  /** Advance `n` fixed ticks under gravity (deterministic; no wall-clock scaling). */
  step(n = 1): void {
    if (!this.sim) return;
    for (let i = 0; i < n; i++) this.sim.stepDynamics();
    this.ticksAdvanced += n;
  }

  /** Rewind to the spawned state (restores pose + velocity) and reset the clock. */
  rewind(): void {
    if (!this.sim || !this.initialSnapshot) return;
    this.sim.restore(this.initialSnapshot);
    this.ticksAdvanced = 0;
  }

  /** Fixed ticks advanced since start / last rewind. */
  get ticks(): number {
    return this.ticksAdvanced;
  }

  /** Elapsed sim-time in seconds (ticks / fixed rate). */
  get elapsedSeconds(): number {
    return this.ticksAdvanced / SIM_TICK_RATE_HZ;
  }

  /** Current render poses for each CAD instance body (COM-frame → group origin).
   * Experiment ground (if any) is a later body index and is not rendered as a part. */
  poses(): BodyRenderPose[] {
    const sim = this.sim;
    if (!sim) return [];
    const out: BodyRenderPose[] = [];
    const n = Math.min(sim.bodyCount, this.instanceIds.length);
    for (let i = 0; i < n; i++) {
      const id = this.instanceIds[i];
      if (id === undefined) continue;
      const p = sim.bodyPosition(i) as Vec3;
      const o = sim.bodyOrientation(i) as Quat;
      out.push({ id, ...bodyPoseToGroup(p, o, this.localCom) });
    }
    return out;
  }

  /**
   * Live body speeds from a full-state snapshot (m/s), all spawned bodies
   * including experiment ground. Used for experiment telemetry.
   */
  speeds(): number[] {
    const sim = this.sim;
    if (!sim) return [];
    const snap = sim.snapshot();
    return snap.bodies.map((b) => {
      const v = b.linearVelocity;
      return Math.hypot(v[0], v[1], v[2]);
    });
  }

  /** World COM positions (raw sim). All bodies including ground. */
  comPositions(): Vec3[] {
    const sim = this.sim;
    if (!sim) return [];
    const out: Vec3[] = [];
    for (let i = 0; i < sim.bodyCount; i++) out.push(sim.bodyPosition(i) as Vec3);
    return out;
  }

  /** Spawned body ids in index order (CAD instances + optional ground). */
  bodyIds(): string[] {
    const sim = this.sim;
    if (!sim) return [];
    const ids = [...this.instanceIds];
    // Experiment ground is appended after CAD bodies by applyExperiment.
    if (sim.bodyCount > ids.length) ids.push("__experiment_ground");
    return ids.slice(0, sim.bodyCount);
  }

  /** Drop the sim (return-to-edit re-derives the render from the document). */
  stop(): void {
    this.sim = null;
    this.initialSnapshot = null;
    this.ticksAdvanced = 0;
  }
}
