// SimManifest — the lowered, physics-ready description of an assembly. This is
// the contract between @plastiq/cad (producer, via exportForSim) and @plastiq/sim
// (consumer, via spawnManifest). It is plain JSON: each body is a compound of one
// or more convex-hull colliders posed by its world centre of mass; constraints
// are hinge/slider/cylindrical/ball/planar/fixed joints. A convex part lowers to
// one collider; a concave part is decomposed into several convex pieces (see
// lower/decompose.ts).

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
  /**
   * The part's collision shape as one or more convex-hull pieces (a compound
   * collider), in the COM-local frame. One piece for a convex part; several for
   * a concave part (convex decomposition). Always non-empty.
   */
  readonly colliders: HullCollider[];
  /** A fixed body is static (does not fall). */
  readonly fixed?: boolean;
}

/**
 * The simulated-joint vocabulary. All frames are WORLD-space at spawn:
 *   hinge       — rotation about `axis` through `origin` (1 DOF).
 *   slider      — translation along `axis` only (1 DOF; rotation locked).
 *   cylindrical — rotation about AND translation along `axis` (2 DOF).
 *   ball        — free rotation about the point `origin` (3 DOF; `axis` unused).
 *   planar      — translation in the plane through `origin` with normal `axis`,
 *                 plus rotation about that normal (3 DOF).
 *   fixed       — all 6 DOF locked in the bodies' CURRENT relative pose.
 * The kind list is additive within manifest version 1: the per-constraint kind
 * check below rejects unknown kinds loudly, so an older parser meeting a newer
 * manifest fails at the offending constraint with a precise message — the
 * version gate is reserved for STRUCTURAL breaks, not vocabulary growth.
 */
export type ManifestConstraintKind = "hinge" | "slider" | "cylindrical" | "ball" | "planar" | "fixed";

export const MANIFEST_CONSTRAINT_KINDS: readonly ManifestConstraintKind[] = [
  "hinge",
  "slider",
  "cylindrical",
  "ball",
  "planar",
  "fixed",
];

export interface ManifestConstraint {
  readonly kind: ManifestConstraintKind;
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

/** A finite-number vector of exactly `n` components. */
function isVec(x: unknown, n: number): boolean {
  return (
    Array.isArray(x) &&
    x.length === n &&
    x.every((v) => typeof v === "number" && Number.isFinite(v))
  );
}

/**
 * Validate a parsed/untrusted manifest — structure AND numeric integrity. This is
 * the kernel-side trust boundary: a manifest that passes here must also survive
 * `@plastiq/sim`'s `parseManifest` (so non-finite vectors, malformed hulls, and
 * out-of-range face indices can never reach a physics backend). The two checks are
 * deliberately kept in lock-step — `@plastiq/sim` stays standalone (it never imports
 * the kernel; the manifest types are hand-mirrored), so the validation is duplicated
 * rather than shared, exactly like `hullVolume`/`meshVolume`. This guard is kept at
 * least as strict as `parseManifest`; if either's acceptance rules change, update the
 * other so the implication above still holds.
 */
export function isSimManifest(x: unknown): x is SimManifest {
  if (typeof x !== "object" || x === null) return false;
  const m = x as Record<string, unknown>;
  if (m["version"] !== 1) return false;
  if (typeof m["source"] !== "string") return false;
  if (!isVec(m["gravity"], 3)) return false;
  if (!Array.isArray(m["bodies"]) || !Array.isArray(m["constraints"])) return false;
  const bodyIds = new Set<string>();
  for (const b of m["bodies"] as unknown[]) {
    if (typeof b !== "object" || b === null) return false;
    const body = b as Record<string, unknown>;
    if (typeof body["id"] !== "string" || body["id"] === "") return false;
    if (bodyIds.has(body["id"])) return false; // duplicate body ids are ambiguous joint targets
    bodyIds.add(body["id"]);
    if (typeof body["mass"] !== "number" || !Number.isFinite(body["mass"]) || body["mass"] < 0)
      return false;
    if (!isVec(body["com"], 3) || !isVec(body["orientation"], 4)) return false;
    const colliders = body["colliders"];
    if (!Array.isArray(colliders) || colliders.length === 0) return false;
    for (const c of colliders) {
      if (typeof c !== "object" || c === null) return false;
      const hull = c as Record<string, unknown>;
      const points = hull["points"];
      if (!Array.isArray(points) || points.length < 12 || points.length % 3 !== 0) return false;
      const faces = hull["faces"];
      if (!Array.isArray(faces) || faces.length < 4) return false;
      // Every face must be a triangle of in-range vertex indices, or a backend
      // dereferences out of bounds deep inside spawn().
      const vertexCount = points.length / 3;
      for (const f of faces) {
        if (!Array.isArray(f) || f.length !== 3) return false;
        for (const idx of f) {
          if (!Number.isInteger(idx) || idx < 0 || idx >= vertexCount) return false;
        }
      }
    }
  }
  for (const c of m["constraints"] as unknown[]) {
    if (typeof c !== "object" || c === null) return false;
    const con = c as Record<string, unknown>;
    if (!(MANIFEST_CONSTRAINT_KINDS as readonly unknown[]).includes(con["kind"])) return false;
    if (typeof con["bodyA"] !== "string" || typeof con["bodyB"] !== "string") return false;
    // Referential integrity: every constraint must name declared bodies — the sim
    // side rejects dangling refs too (a joint cannot attach to nothing).
    if (!bodyIds.has(con["bodyA"]) || !bodyIds.has(con["bodyB"])) return false;
    if (!isVec(con["origin"], 3) || !isVec(con["axis"], 3)) return false;
  }
  return true;
}
