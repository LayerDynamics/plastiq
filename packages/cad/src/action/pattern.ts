// Pattern operations — produce N independent placed copies of a base solid. The
// caller (rebuild loop) fuses them and deletes each copy.

import type { Occt } from "../oc/init.js";
import type { Vec3 } from "../math/index.js";
import { normalize, scale } from "../math/index.js";
import type { Solid } from "../solid/solid.js";
import { rotate, translate } from "./transform.js";

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
  if (count < 1) throw new Error("linearPattern: count must be ≥ 1");
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
  if (count < 1) throw new Error("circularPattern: count must be ≥ 1");
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
