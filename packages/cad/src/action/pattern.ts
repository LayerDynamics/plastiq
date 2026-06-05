// Pattern operations — produce N independent placed copies of a base solid. The
// caller (rebuild loop) fuses them and deletes each copy.

import type { Occt } from "../oc/init.js";
import type { Vec3 } from "../math/index.js";
import { scale } from "../math/index.js";
import type { Solid } from "../solid/solid.js";
import { rotate, translate } from "./transform.js";

/** `count` copies of `base`, each offset by `spacing` along `dir` (i = 0…count−1). */
export function linearPattern(
  oc: Occt,
  base: Solid,
  dir: Vec3,
  spacing: number,
  count: number,
): Solid[] {
  if (count < 1) throw new Error("linearPattern: count must be ≥ 1");
  const copies: Solid[] = [];
  for (let i = 0; i < count; i++) {
    copies.push(translate(oc, base, scale(dir, spacing * i)));
  }
  return copies;
}

/** `count` copies of `base` evenly rotated about (origin, axis) over `angle`. */
export function circularPattern(
  oc: Occt,
  base: Solid,
  origin: Vec3,
  axis: Vec3,
  count: number,
  angle: number,
): Solid[] {
  if (count < 1) throw new Error("circularPattern: count must be ≥ 1");
  const step = angle / count;
  const copies: Solid[] = [];
  for (let i = 0; i < count; i++) {
    copies.push(rotate(oc, base, origin, axis, step * i));
  }
  return copies;
}
