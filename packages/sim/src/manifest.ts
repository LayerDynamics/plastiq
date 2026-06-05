// SimManifest — the physics-ready description produced by @plastiq/cad's
// exportForSim and consumed here. Structurally identical to the kernel's type
// (kept in sync deliberately; the two packages stay decoupled — no import).

export interface ManifestBody {
  id: string;
  mass: number;
  com: [number, number, number];
  orientation: [number, number, number, number];
  halfExtents: [number, number, number];
  fixed?: boolean;
}

export interface ManifestConstraint {
  kind: "hinge" | "fixed";
  bodyA: string;
  bodyB: string;
  origin: [number, number, number];
  axis: [number, number, number];
}

export interface SimManifest {
  version: 1;
  source: string;
  gravity: [number, number, number];
  bodies: ManifestBody[];
  constraints: ManifestConstraint[];
}

/** Parse + validate a manifest JSON string. */
export function parseManifest(json: string): SimManifest {
  const m = JSON.parse(json) as SimManifest;
  if (m.version !== 1) throw new Error(`unsupported SimManifest version ${m.version}`);
  if (!Array.isArray(m.bodies) || !Array.isArray(m.constraints)) {
    throw new Error("SimManifest: missing bodies/constraints");
  }
  return m;
}
