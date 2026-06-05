// SimManifest — the lowered, physics-ready description of an assembly. This is
// the contract between @plastiq/cad (producer, via exportForSim) and @plastiq/sim
// (consumer, via spawnManifest). It is plain JSON: bodies are box-collider rigid
// bodies posed by their world centre of mass; constraints are hinge/fixed joints.

export interface ManifestBody {
  /** Render-group / instance id (body order in the manifest = spawn order). */
  readonly id: string;
  /** Mass in kg (volume × material density). */
  readonly mass: number;
  /** World position of the body's centre of mass at spawn. */
  readonly com: readonly [number, number, number];
  /** World orientation (quaternion x,y,z,w) at spawn. */
  readonly orientation: readonly [number, number, number, number];
  /** Local box-collider half-extents (from the part's bounding box). */
  readonly halfExtents: readonly [number, number, number];
  /** A fixed body is static (does not fall). */
  readonly fixed?: boolean;
}

export interface ManifestConstraint {
  readonly kind: "hinge" | "fixed";
  readonly bodyA: string;
  readonly bodyB: string;
  readonly origin: readonly [number, number, number];
  readonly axis: readonly [number, number, number];
}

export interface SimManifest {
  readonly version: 1;
  readonly source: string;
  readonly gravity: readonly [number, number, number];
  readonly bodies: ManifestBody[];
  readonly constraints: ManifestConstraint[];
}

/** Structural validation of a parsed/untrusted manifest. */
export function isSimManifest(x: unknown): x is SimManifest {
  if (typeof x !== "object" || x === null) return false;
  const m = x as Record<string, unknown>;
  if (m["version"] !== 1) return false;
  if (typeof m["source"] !== "string") return false;
  if (!Array.isArray(m["gravity"]) || m["gravity"].length !== 3) return false;
  if (!Array.isArray(m["bodies"]) || !Array.isArray(m["constraints"])) return false;
  for (const b of m["bodies"] as unknown[]) {
    const body = b as Record<string, unknown>;
    if (typeof body["id"] !== "string" || typeof body["mass"] !== "number") return false;
    if (!Array.isArray(body["com"]) || !Array.isArray(body["orientation"])) return false;
    if (!Array.isArray(body["halfExtents"])) return false;
  }
  return true;
}
