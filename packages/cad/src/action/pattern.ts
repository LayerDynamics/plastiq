// Pattern operations — produce N independent placed copies of a base solid. The
// caller (rebuild loop) fuses them and deletes each copy.

import type { TopoDS_Wire } from "opencascade.js";

import type { Occt } from "../oc/init.js";
import type { Vec3 } from "../math/index.js";
import { cross, dot, length, normalize, scale } from "../math/index.js";
import { buildSpineWire, type SpinePath } from "../sketch/spine.js";
import type { Solid } from "../solid/solid.js";
import { rotate, transformRigid, translate } from "./transform.js";

/**
 * Upper bound on a pattern's instance count (§2.10.4).
 *
 * Each instance is a placed copy that the caller then fuses; the app runs this on
 * a SINGLE geometry worker, so an unbounded count (the audit's `count: 1e6`)
 * hangs it and freezes every interactive rebuild WITHOUT ever erroring. 10 000 is
 * far above any realistic pattern (a dense perforation is a few hundred) yet
 * bounds the work — a pathological request now fails loudly instead of wedging
 * the worker. Enforced in the kernel so every caller (UI, AI probe, headless) is
 * covered by one guard.
 */
const MAX_PATTERN_COUNT = 10_000;

/** Arc-length sampling tolerance for {@link patternAlongPath} (SI metres). */
const PATH_SAMPLE_TOL = 1e-7;

/** Reject a non-positive or pathologically large instance count. */
function checkCount(name: string, count: number): void {
  if (count < 1) throw new Error(`${name}: count must be ≥ 1`);
  if (count > MAX_PATTERN_COUNT) {
    throw new Error(
      `${name}: count ${count} exceeds the maximum of ${MAX_PATTERN_COUNT} — a larger pattern would freeze the geometry worker`,
    );
  }
}

/** Unit quaternion that rotates vector `from` onto `to` (both non-zero). */
function quatFromTo(from: Vec3, to: Vec3): readonly [number, number, number, number] {
  const f = normalize(from);
  const t = normalize(to);
  const d = dot(f, t);
  if (d > 1 - 1e-12) return [0, 0, 0, 1];
  if (d < -1 + 1e-12) {
    // 180° about any axis perpendicular to `from`.
    const axis =
      Math.abs(f[0]) < 0.9 ? normalize(cross(f, [1, 0, 0])) : normalize(cross(f, [0, 1, 0]));
    return [axis[0], axis[1], axis[2], 0];
  }
  const c = cross(f, t);
  // Half-angle form: q = [f×t, 1 + f·t], then normalize.
  const n = Math.hypot(c[0], c[1], c[2], 1 + d) || 1;
  return [c[0] / n, c[1] / n, c[2] / n, (1 + d) / n];
}

function isSpinePath(spine: TopoDS_Wire | SpinePath): spine is SpinePath {
  return typeof spine === "object" && spine !== null && "kind" in spine;
}

export interface PathPatternOptions {
  /**
   * When true, each copy is rotated so the solid's local +X aligns with the path
   * tangent at the sample (then translated so the solid origin lands on the point).
   * When false (default), only translation is applied.
   */
  readonly align?: boolean;
}

/** `count` copies of `base`, each offset by `spacing` along `dir` (i = 0…count−1).
 * `dir` is unitized so a non-unit authoring vector does not silently scale the
 * spacing (G11). A zero-length direction throws. */
export function linearPattern(
  oc: Occt,
  base: Solid,
  dir: Vec3,
  spacing: number,
  count: number,
): Solid[] {
  checkCount("linearPattern", count);
  // Zero spacing places every copy on top of the base (§4.6): the subsequent
  // fuse collapses them back to the base, so the pattern silently "does nothing".
  // Reject it rather than return a lie — a single copy is `count: 1`, which needs
  // no spacing. (Non-finite is rejected for the same reason.)
  if (count > 1 && (!Number.isFinite(spacing) || spacing === 0)) {
    throw new Error("linearPattern: spacing must be non-zero for count > 1");
  }
  const unit = normalize(dir);
  const copies: Solid[] = [];
  for (let i = 0; i < count; i++) {
    copies.push(translate(oc, base, scale(unit, spacing * i)));
  }
  return copies;
}

/**
 * `count` copies of `base` evenly rotated about (origin, axis), spread "over"
 * `angle`.
 *
 * The spacing depends on whether `angle` closes a full revolution:
 * - **Full turn** (`angle` ≈ a multiple of 2π): step = `angle / count`. The copy
 *   that would land at `angle` coincides with the one at 0, so the endpoint is
 *   EXCLUDED — N copies evenly fill the circle with no duplicate.
 * - **Partial arc** (`angle` < a full turn): step = `angle / (count − 1)`. The
 *   first and last copies sit at 0 and exactly `angle`, so the copies span the
 *   WHOLE requested arc (endpoint INCLUDED) — the Fusion/SolidWorks convention.
 *   Using `angle / count` here (the old behavior) under-filled the arc, leaving
 *   the last copy at `angle·(count−1)/count` instead of `angle`.
 */
export function circularPattern(
  oc: Occt,
  base: Solid,
  origin: Vec3,
  axis: Vec3,
  count: number,
  angle: number,
): Solid[] {
  checkCount("circularPattern", count);
  // A zero total angle gives step 0 → every copy coincident with the base (§4.6),
  // which the fuse collapses back to the base: the pattern silently does nothing.
  // Reject for count > 1 (count 1 is just the base and needs no angle).
  if (count > 1 && (!Number.isFinite(angle) || angle === 0)) {
    throw new Error("circularPattern: angle must be non-zero for count > 1");
  }
  const FULL_TURN = 2 * Math.PI;
  // angle is (within tolerance) a non-zero multiple of 2π → a closed full turn.
  const closesFullTurn = angle !== 0 && Math.abs(((angle % FULL_TURN) + FULL_TURN) % FULL_TURN) < 1e-9;
  const step = count === 1 ? 0 : closesFullTurn ? angle / count : angle / (count - 1);
  const copies: Solid[] = [];
  for (let i = 0; i < count; i++) {
    copies.push(rotate(oc, base, origin, axis, step * i));
  }
  return copies;
}

/**
 * `count` copies of `solid` placed at uniform arc-length samples along `spine`
 * (FablesFindings §13.2 `patternAlongPath`).
 *
 * Sampling uses `GCPnts_UniformAbscissa` over a `BRepAdaptor_CompCurve` of the
 * spine wire, so a multi-edge polyline is treated as one continuous path. The
 * first sample is at the path start and the last at the path end (inclusive).
 *
 * `spine` may be a built `TopoDS_Wire` (caller retains ownership) or a
 * {@link SpinePath} (built and freed here via {@link buildSpineWire}).
 *
 * Placement maps the solid's local origin to each sample point. With
 * `{ align: true }`, the solid is also rotated so local +X follows the path
 * tangent before that translation.
 */
export function patternAlongPath(
  oc: Occt,
  solid: Solid,
  spine: TopoDS_Wire | SpinePath,
  count: number,
  opts?: PathPatternOptions,
): Solid[] {
  checkCount("patternAlongPath", count);

  const ownsWire = isSpinePath(spine);
  const wire = ownsWire ? buildSpineWire(oc, spine) : spine;
  const align = opts?.align === true;
  const trash: Array<{ delete(): void }> = [];
  const copies: Solid[] = [];

  try {
    // KnotByCurvilinearAbcissa = true so composite-curve parameters track arc
    // length; UniformAbscissa still enforces equal spacing either way.
    const curve = new oc.BRepAdaptor_CompCurve_2(wire, true);
    trash.push(curve);

    // Reusable D1 outputs when aligning.
    const pnt = new oc.gp_Pnt_1();
    trash.push(pnt);
    const tan = new oc.gp_Vec_1();
    trash.push(tan);

    /** Place one copy of `solid` at curve parameter `u`. */
    const placeAt = (u: number, sampleIndex: number): Solid => {
      if (align) {
        curve.D1(u, pnt, tan);
        const tx = tan.X();
        const ty = tan.Y();
        const tz = tan.Z();
        if (!Number.isFinite(tx + ty + tz) || length([tx, ty, tz]) === 0) {
          throw new Error(
            `patternAlongPath: zero tangent at sample ${sampleIndex} (parameter ${u})`,
          );
        }
        // Local +X → path tangent; origin → sample point (R·p + T via transformRigid).
        const q = quatFromTo([1, 0, 0], [tx, ty, tz]);
        return transformRigid(oc, solid, q, [pnt.X(), pnt.Y(), pnt.Z()]);
      }
      const p = curve.Value(u);
      try {
        return translate(oc, solid, [p.X(), p.Y(), p.Z()]);
      } finally {
        p.delete();
      }
    };

    // NbPoints < 2 is rejected by GCPnts_UniformAbscissa (opaque wasm fault); a
    // single instance simply sits at the path start — same honesty as count=1
    // for linear/circular (no spacing/angle required).
    if (count === 1) {
      copies.push(placeAt(curve.FirstParameter(), 1));
      return copies;
    }

    const sampler = new oc.GCPnts_UniformAbscissa_1();
    trash.push(sampler);
    // Initialize_3(curve, NbPoints, tol) — places NbPoints including both ends.
    sampler.Initialize_3(curve, count, PATH_SAMPLE_TOL);
    if (!sampler.IsDone() || sampler.NbPoints() < 1) {
      throw new Error(
        "patternAlongPath: failed to sample the spine uniformly by arc length (degenerate path?)",
      );
    }

    const n = sampler.NbPoints();
    for (let i = 1; i <= n; i++) {
      copies.push(placeAt(sampler.Parameter(i), i));
    }

    // If the sampler returned fewer points than requested (degenerate spine), fail
    // rather than silently under-count — same honesty as linear/circular guards.
    if (copies.length !== count) {
      throw new Error(
        `patternAlongPath: expected ${count} samples but the spine yielded ${copies.length}`,
      );
    }
    return copies;
  } catch (e) {
    for (const c of copies) c.delete();
    throw e;
  } finally {
    for (let i = trash.length - 1; i >= 0; i--) trash[i]!.delete();
    if (ownsWire) wire.delete();
  }
}
