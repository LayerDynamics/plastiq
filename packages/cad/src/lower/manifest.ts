// The SimManifest contract — the frozen CAD→sim data seam (SPEC-4 FR-26/FR-30).
//
// This file is the SOURCE OF TRUTH for the contract. The Rust ingestion bridge
// (`crates/cad/src/manifest.rs`) mirrors these shapes with `serde`. Any change
// here is a deliberate, version-bumped, tested change on both sides.
//
// All coordinates/scalars are f64 in canonical SI (metres, kilograms, radians),
// matching `crates/sim` (SPEC-3). Quaternions are (x, y, z, w). Matrices are
// row-major 3x3.

export const SIM_MANIFEST_VERSION = 1 as const;

export type Vec3 = readonly [number, number, number];
export type Quat = readonly [number, number, number, number];
export type Mat3 = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

/** Collision shape variants — mirror `mechx_sim::collision::Shape` (SPEC-3). */
export type ShapeData =
  | { readonly kind: "sphere"; readonly center: Vec3; readonly radius: number }
  | { readonly kind: "capsule"; readonly a: Vec3; readonly b: Vec3; readonly radius: number }
  | { readonly kind: "box"; readonly halfExtents: Vec3 }
  | {
      readonly kind: "convexHull";
      readonly vertices: readonly Vec3[];
      readonly faces: readonly (readonly [number, number, number])[];
    };

export const SHAPE_KINDS = ["sphere", "capsule", "box", "convexHull"] as const;
export type ShapeKind = (typeof SHAPE_KINDS)[number];

/** Body-frame mass properties (SI), computed from the exact B-rep × density. */
export interface MassProperties {
  readonly volume: number; // m^3
  readonly mass: number; // kg
  readonly com: Vec3; // centre of mass, body frame, m
  readonly inertia: Mat3; // body-frame inertia tensor, kg·m^2, row-major
}

/** Resolves to `mechx_sim::Material { density, friction, restitution }`. */
export interface MaterialData {
  readonly name: string;
  readonly density: number; // kg/m^3
  readonly friction: number; // dimensionless, >= 0
  readonly restitution: number; // [0, 1]
}

export interface BoundBodyData {
  readonly name: string;
  readonly shape: ShapeData;
  readonly translation: Vec3; // world placement, m
  readonly orientation: Quat; // world orientation
  readonly material: MaterialData;
  readonly mass: MassProperties;
}

/** Lowered assembly constraints — mirror the SPEC-3 M5 joint vocabulary. */
export type LoweredConstraint =
  | {
      readonly kind: "hinge";
      readonly bodyA: string;
      readonly bodyB: string;
      readonly anchor: Vec3;
      readonly axis: Vec3;
    }
  | { readonly kind: "fixed"; readonly bodyA: string; readonly bodyB: string }
  | {
      readonly kind: "distance";
      readonly bodyA: string;
      readonly bodyB: string;
      readonly anchorA: Vec3;
      readonly anchorB: Vec3;
      readonly distance: number;
    }
  | {
      readonly kind: "spring";
      readonly bodyA: string;
      readonly bodyB: string;
      readonly anchorA: Vec3;
      readonly anchorB: Vec3;
      readonly rest: number;
      readonly stiffness: number;
    };

export const CONSTRAINT_KINDS = ["hinge", "fixed", "distance", "spring"] as const;
export type ConstraintKind = (typeof CONSTRAINT_KINDS)[number];

export interface SimManifest {
  readonly version: typeof SIM_MANIFEST_VERSION;
  readonly source: string;
  readonly bodies: readonly BoundBodyData[];
  readonly constraints: readonly LoweredConstraint[];
}

// ---------------------------------------------------------------------------
// Validation. The kernel and any consumer use `isSimManifest` to reject
// malformed/non-finite data BEFORE it crosses the seam (NFR-3). Finiteness is
// enforced everywhere a number appears: no NaN/Inf may reach the sim.
// ---------------------------------------------------------------------------

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isVec3(v: unknown): v is Vec3 {
  return Array.isArray(v) && v.length === 3 && v.every(isFiniteNumber);
}

function isQuat(v: unknown): v is Quat {
  return Array.isArray(v) && v.length === 4 && v.every(isFiniteNumber);
}

function isMat3(v: unknown): v is Mat3 {
  return Array.isArray(v) && v.length === 9 && v.every(isFiniteNumber);
}

function isShapeData(v: unknown): v is ShapeData {
  if (typeof v !== "object" || v === null) return false;
  const s = v as Record<string, unknown>;
  switch (s["kind"]) {
    case "sphere":
      return isVec3(s["center"]) && isFiniteNumber(s["radius"]) && (s["radius"] as number) > 0;
    case "capsule":
      return (
        isVec3(s["a"]) &&
        isVec3(s["b"]) &&
        isFiniteNumber(s["radius"]) &&
        (s["radius"] as number) > 0
      );
    case "box":
      return isVec3(s["halfExtents"]) && (s["halfExtents"] as Vec3).every((h) => h > 0);
    case "convexHull": {
      const verts = s["vertices"];
      const faces = s["faces"];
      if (!Array.isArray(verts) || verts.length < 4 || !verts.every(isVec3)) return false;
      if (!Array.isArray(faces) || faces.length < 4) return false;
      return faces.every(
        (f) =>
          Array.isArray(f) &&
          f.length === 3 &&
          f.every((i) => Number.isInteger(i) && i >= 0 && i < verts.length),
      );
    }
    default:
      return false;
  }
}

function isMassProperties(v: unknown): v is MassProperties {
  if (typeof v !== "object" || v === null) return false;
  const m = v as Record<string, unknown>;
  return (
    isFiniteNumber(m["volume"]) &&
    (m["volume"] as number) > 0 &&
    isFiniteNumber(m["mass"]) &&
    (m["mass"] as number) > 0 &&
    isVec3(m["com"]) &&
    isMat3(m["inertia"])
  );
}

function isMaterialData(v: unknown): v is MaterialData {
  if (typeof v !== "object" || v === null) return false;
  const m = v as Record<string, unknown>;
  return (
    typeof m["name"] === "string" &&
    isFiniteNumber(m["density"]) &&
    (m["density"] as number) > 0 &&
    isFiniteNumber(m["friction"]) &&
    (m["friction"] as number) >= 0 &&
    isFiniteNumber(m["restitution"]) &&
    (m["restitution"] as number) >= 0 &&
    (m["restitution"] as number) <= 1
  );
}

function isBoundBodyData(v: unknown): v is BoundBodyData {
  if (typeof v !== "object" || v === null) return false;
  const b = v as Record<string, unknown>;
  return (
    typeof b["name"] === "string" &&
    b["name"].length > 0 &&
    isShapeData(b["shape"]) &&
    isVec3(b["translation"]) &&
    isQuat(b["orientation"]) &&
    isMaterialData(b["material"]) &&
    isMassProperties(b["mass"])
  );
}

function isLoweredConstraint(v: unknown, bodyNames: ReadonlySet<string>): v is LoweredConstraint {
  if (typeof v !== "object" || v === null) return false;
  const c = v as Record<string, unknown>;
  const a = c["bodyA"];
  const b = c["bodyB"];
  if (typeof a !== "string" || typeof b !== "string") return false;
  // A constraint must reference bodies that exist in the manifest.
  if (!bodyNames.has(a) || !bodyNames.has(b)) return false;
  switch (c["kind"]) {
    case "hinge":
      return isVec3(c["anchor"]) && isVec3(c["axis"]);
    case "fixed":
      return true;
    case "distance":
      return (
        isVec3(c["anchorA"]) &&
        isVec3(c["anchorB"]) &&
        isFiniteNumber(c["distance"]) &&
        (c["distance"] as number) >= 0
      );
    case "spring":
      return (
        isVec3(c["anchorA"]) &&
        isVec3(c["anchorB"]) &&
        isFiniteNumber(c["rest"]) &&
        (c["rest"] as number) >= 0 &&
        isFiniteNumber(c["stiffness"]) &&
        (c["stiffness"] as number) > 0
      );
    default:
      return false;
  }
}

/** Structural + finiteness + referential validation of a SimManifest. */
export function isSimManifest(v: unknown): v is SimManifest {
  if (typeof v !== "object" || v === null) return false;
  const m = v as Record<string, unknown>;
  if (m["version"] !== SIM_MANIFEST_VERSION) return false;
  if (typeof m["source"] !== "string") return false;
  const bodies = m["bodies"];
  const constraints = m["constraints"];
  if (!Array.isArray(bodies) || !bodies.every(isBoundBodyData)) return false;
  if (!Array.isArray(constraints)) return false;
  // Body names must be unique (they are the constraint reference keys).
  const names = new Set<string>();
  for (const b of bodies as BoundBodyData[]) {
    if (names.has(b.name)) return false;
    names.add(b.name);
  }
  return constraints.every((c) => isLoweredConstraint(c, names));
}
