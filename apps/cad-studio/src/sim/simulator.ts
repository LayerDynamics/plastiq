// In-editor Simulate (SPEC-5 M6.1, FR-41). Spawns the model's SimManifest into
// the in-browser physics engine (@plastiq/sim) and steps it under gravity; each frame
// the live body poses are mapped back to the render groups. This is transient
// VIEW state — it never writes to the document, so "return to edit" is just
// re-deriving the render from the (untouched) document.
//
// The sim reports each body's world CENTRE OF MASS + orientation; the render
// group is the part's local-origin geometry, so the render-back inverts the
// lowering's COM composition: groupPos = comPos − R(ori)·localCom.

import { initSim, PredictionSim } from "@plastiq/sim";
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

const TICK_RATE_HZ = 120;
const SEED = 1n;

export class Simulator {
  private sim: PredictionSim | null = null;

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

  /** Load the sim wasm + spawn the manifest. Returns the body count. */
  async start(): Promise<number> {
    await initSim();
    const sim = new PredictionSim(TICK_RATE_HZ, SEED);
    const count = sim.spawnManifest(this.manifestJson);
    this.sim = sim;
    return count;
  }

  /** Advance `n` fixed ticks under gravity (deterministic; no wall-clock scaling). */
  step(n = 1): void {
    for (let i = 0; i < n; i++) this.sim?.stepDynamics();
  }

  /** Current render poses for each spawned body (COM-frame → group origin). */
  poses(): BodyRenderPose[] {
    const sim = this.sim;
    if (!sim) return [];
    const out: BodyRenderPose[] = [];
    for (let i = 0; i < sim.bodyCount; i++) {
      const id = this.instanceIds[i];
      if (id === undefined) continue;
      const p = sim.bodyPosition(i) as Vec3;
      const o = sim.bodyOrientation(i) as Quat;
      out.push({ id, ...bodyPoseToGroup(p, o, this.localCom) });
    }
    return out;
  }

  /** Drop the sim (return-to-edit re-derives the render from the document). */
  stop(): void {
    this.sim = null;
  }
}
