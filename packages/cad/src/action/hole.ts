// A real, fully-parameterized hole feature (§13.2, replacing the bore-only
// cylinder-cut composition the app performed at rebuild-time — registry.ts:157-195,
// rebuild.ts:142).
//
// A hole is NOT a new OCCT binding: OCCT ships no BRepFeat draft-prism/hole feature
// in this wasm (§2.4, §13.2). It is COMPOSED from the round primitives
// (makeCylinder/makeCone) and a boolean subtract — exactly how the app already
// builds holes, lifted here into a proper kernel op that carries every parameter:
//
//   • simple      — a straight cylindrical bore.
//   • counterbore — a larger flat-bottomed coaxial cylinder cut at the mouth.
//   • countersink — a coaxial cone (chamfer) cut at the mouth.
//   • spotface    — a shallow flat counterbore (same geometry, small depth).
//
// The bore is either blind (a fixed `depth`) or `throughAll` (overshoots the body's
// bounding box like extrude.ts's up-to overshoot, so the cut removes the full run).
// A blind hole may carry a drill-point `tipAngle` (a cone at the bottom).
//
// COMPOSITION. Every tool piece (bore, mouth feature, tip) is built coaxial to the
// hole axis, unioned into ONE tool, and cut from the base in a single subtract.
// A single cut with a pre-fused tool gives the cleanest mouth topology — the same
// UnifySameDomain merge every boolean runs (boolean.ts:150-169) then leaves the
// hole walls as whole analytic faces, which is what §2.1 per-surface FaceRefs need.
//
// Inputs are validated with NAMED errors BEFORE any OCCT allocation (the
// revolve.ts:20-38 pattern), and every OCCT-owning Solid is freed on EVERY exit via
// a try/finally trash list — the base and the returned Solid are the only survivors.

import type { Occt } from "../oc/init.js";
import { type Vec3, add, scale } from "../math/index.js";
import type { Solid } from "../solid/solid.js";
import { makeCylinder, makeCone } from "../solid/primitives.js";
import { subtract, unionAll } from "./boolean.js";

/** The four hole geometries this feature builds. */
export type HoleKind = "simple" | "counterbore" | "countersink" | "spotface";

/**
 * A fully-parameterized hole. The bore runs from `origin` (a point on the face,
 * the mouth) along the unit `axis` (the drilling direction, INTO the material).
 */
export interface HoleSpec {
  /** The hole-axis start point on the face — the mouth of the bore. */
  readonly origin: Vec3;
  /** The drilling direction (into the material), a UNIT vector. */
  readonly axis: Vec3;
  /** The through-bore diameter. */
  readonly diameter: number;
  /** Blind-hole depth from the mouth. Mutually exclusive with `throughAll`. */
  readonly depth?: number;
  /** When true the bore overshoots the body's bounding box — a through hole. */
  readonly throughAll?: boolean;
  /** Which mouth treatment (if any) to cut in addition to the bore. */
  readonly kind: HoleKind;
  /** Counterbore / spotface: the larger coaxial cylinder's diameter (> `diameter`). */
  readonly counterboreDiameter?: number;
  /** Counterbore / spotface: how deep the larger cylinder is cut from the mouth. */
  readonly counterboreDepth?: number;
  /** Countersink: the cone's diameter at the face (> `diameter`). */
  readonly countersinkDiameter?: number;
  /** Countersink: the cone's full included angle (radians, < π). */
  readonly countersinkAngle?: number;
  /** Blind only: full included angle of a drill-point cone at the bottom (< π). */
  readonly tipAngle?: number;
}

/** Reject a value that is not a positive, finite number, with a NAMED error. */
function assertPositiveFinite(v: number | undefined, label: string): asserts v is number {
  if (v === undefined || !Number.isFinite(v) || !(v > 0)) {
    throw new Error(`hole: ${label} must be a positive finite number`);
  }
}

/**
 * Cut a real, fully-parameterized hole in `base` per `spec`, returning a new Solid.
 *
 * `base` is NOT consumed (the boolean runs NonDestructive); the caller still owns
 * and frees it. Every intermediate tool solid is freed here; only the returned
 * Solid escapes.
 */
export function hole(oc: Occt, base: Solid, spec: HoleSpec): Solid {
  // ---- Validate everything BEFORE allocating any OCCT object (revolve.ts:20-38). ----
  const { origin, axis, diameter, kind } = spec;

  if (!origin.every((c) => Number.isFinite(c))) {
    throw new Error("hole: origin must be a finite point");
  }
  const axisLen = Math.hypot(axis[0], axis[1], axis[2]);
  // Guard finiteness FIRST: a NaN component makes axisLen NaN, and `NaN > 1e-6` is
  // false — a non-finite axis would slip a bare unit check.
  if (!Number.isFinite(axisLen)) {
    throw new Error("hole: axis must be a finite vector");
  }
  if (Math.abs(axisLen - 1) > 1e-6) {
    throw new Error("hole: axis must be a unit vector");
  }
  assertPositiveFinite(diameter, "diameter");

  const throughAll = spec.throughAll === true;
  if (!throughAll) {
    // A blind hole needs a real depth; a zero/absent depth with no throughAll is
    // the classic "nothing to cut" mistake — fail loudly.
    assertPositiveFinite(spec.depth, "depth");
  }

  if (kind === "counterbore" || kind === "spotface") {
    assertPositiveFinite(spec.counterboreDiameter, "counterboreDiameter");
    assertPositiveFinite(spec.counterboreDepth, "counterboreDepth");
    if (!(spec.counterboreDiameter > diameter)) {
      throw new Error("hole: counterboreDiameter must exceed the bore diameter");
    }
  }
  if (kind === "countersink") {
    assertPositiveFinite(spec.countersinkDiameter, "countersinkDiameter");
    assertPositiveFinite(spec.countersinkAngle, "countersinkAngle");
    if (!(spec.countersinkDiameter > diameter)) {
      throw new Error("hole: countersinkDiameter must exceed the bore diameter");
    }
    if (!(spec.countersinkAngle < Math.PI)) {
      throw new Error("hole: countersinkAngle must be less than π");
    }
  }
  if (spec.tipAngle !== undefined) {
    assertPositiveFinite(spec.tipAngle, "tipAngle");
    if (!(spec.tipAngle < Math.PI)) {
      throw new Error("hole: tipAngle must be less than π");
    }
  }

  // ---- Geometry. dir is unit (validated); r is the bore radius. ----
  const dir = axis;
  const r = diameter / 2;

  // Size the through-all overshoot and a small mouth back-off off the body's own
  // bounding-box diagonal — the same "clear the whole body" margin extrude.ts uses.
  const { min, max } = base.boundingBox();
  const diag = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  // Back the mouth pieces off ABOVE the face by a hair so the cut tool pokes out of
  // the opening rather than ending flush with it (a flush tool face is coincident
  // with the body face — a tolerance-grazing boolean). The back-off region is
  // outside the body, so it removes NO material: blind/through volumes stay exact.
  const backoff = diag * 1e-3;
  // The tool start, backed off along -dir (i.e. out of the mouth).
  const mouth = add(origin, scale(dir, -backoff));

  // Distance the bore runs from `mouth`: to the blind bottom, or well past the far
  // side for a through hole. 1.5·diag from the mouth clears any body along any axis.
  const boreRun = throughAll ? diag * 1.5 : (spec.depth as number);
  const boreHeight = backoff + boreRun;

  // Track every OCCT-owning Solid; free all of them on EVERY exit. The final cut
  // result is the ONLY solid that escapes (it is never pushed here).
  const trash: Solid[] = [];
  const track = <T extends Solid>(s: T): T => {
    trash.push(s);
    return s;
  };

  try {
    const pieces: Solid[] = [];

    // The straight bore, common to every kind.
    pieces.push(track(makeCylinder(oc, r, boreHeight, { origin: mouth, axis: dir })));

    // Mouth treatment.
    if (kind === "counterbore" || kind === "spotface") {
      // A flat-bottomed larger coaxial cylinder cut at the mouth. A spotface is the
      // same geometry with a small depth — a shallow flat seat — so they share this.
      const rCb = (spec.counterboreDiameter as number) / 2;
      const cbHeight = backoff + (spec.counterboreDepth as number);
      pieces.push(track(makeCylinder(oc, rCb, cbHeight, { origin: mouth, axis: dir })));
    } else if (kind === "countersink") {
      // A coaxial cone that is `countersinkDiameter` wide at the face and tapers
      // DOWN to the bore radius `r` over the depth the half-angle demands, then the
      // straight bore continues. Extend the cone up through the back-off so its wide
      // rim pokes out of the mouth too (same slope), keeping the in-body taper exact:
      // radius(face) == countersinkDiameter/2 and radius(delta below) == r.
      const rCs = (spec.countersinkDiameter as number) / 2;
      const tanHalf = Math.tan((spec.countersinkAngle as number) / 2);
      const delta = (rCs - r) / tanHalf; // depth below the face where the cone meets the bore
      const topR = rCs + backoff * tanHalf; // widened rim at the backed-off start
      pieces.push(track(makeCone(oc, topR, r, backoff + delta, { origin: mouth, axis: dir })));
    }

    // A drill-point tip: a cone at the blind bottom, from the full bore radius down
    // to a point deeper into the material. Meaningless on a through hole (no bottom).
    if (!throughAll && spec.tipAngle !== undefined) {
      const tipHeight = r / Math.tan((spec.tipAngle as number) / 2);
      const bottom = add(origin, scale(dir, spec.depth as number));
      pieces.push(track(makeCone(oc, r, 0, tipHeight, { origin: bottom, axis: dir })));
    }

    // Fuse the tool pieces into ONE tool, then cut once. A single piece (a simple
    // blind/through bore) is its own tool — unionAll would only deep-copy it.
    let tool: Solid;
    if (pieces.length === 1) {
      tool = pieces[0]!;
    } else {
      const fused = unionAll(oc, pieces);
      if (!fused.ok) {
        throw new Error(`hole: could not fuse the hole tool (${fused.error})`);
      }
      tool = track(fused.solid);
    }

    const cutResult = subtract(oc, base, tool);
    if (!cutResult.ok) {
      throw new Error(`hole: could not cut the hole (${cutResult.error})`);
    }
    return cutResult.solid;
  } finally {
    // Reverse order for symmetry with construction; delete() is idempotent.
    for (let i = trash.length - 1; i >= 0; i--) trash[i]!.delete();
  }
}
