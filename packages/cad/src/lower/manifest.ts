// SimManifest — the lowered, physics-ready description of an assembly. This is
// the contract between @plastiq/cad (producer, via exportForSim) and @plastiq/sim
// (consumer, via spawnManifest). It is plain JSON: bodies are box-collider rigid
// bodies posed by their world centre of mass; constraints are hinge/fixed joints.

/** A convex-hull collider in the body's local frame (centred at the COM). */
export interface HullCollider {
  /** Flat hull vertices `[x0,y0,z0, …]` (SI metres, COM-relative). */
  readonly points: number[];
  /** Triangular faces as index triples into `points`/3. */
  readonly faces: number[][];
}

export interface ManifestBody {
  /** Render-group / instance id (body order in the manifest = spawn order). */
  readonly id: string;
  /** Mass in kg (volume × material density). */
  readonly mass: number;
  /** World position of the body's centre of mass at spawn. */
  readonly com: readonly [number, number, number];
  /** World orientation (quaternion x,y,z,w) at spawn. */
  readonly orientation: readonly [number, number, number, number];
  /** The part's actual convex-hull collider (from its tessellation). */
  readonly hull: HullCollider;
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
    const hull = body["hull"] as Record<string, unknown> | undefined;
    if (!hull || !Array.isArray(hull["points"]) || !Array.isArray(hull["faces"])) return false;
  }
  return true;
}
