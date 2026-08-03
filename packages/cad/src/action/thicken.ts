// Thicken an open face/shell into a solid plate of wall `thickness` (§13.2, §14).
//
// This is the surface pillar's solidifier: the bridge from an open sheet body
// (a face or shell) back to a closed solid the rest of the kernel can boolean,
// mass, and export. It offsets the surface into a slab of the requested wall.
//
// Route note (verified in oc/makeOffsetShape.pin.test.ts): §13.2 first proposed
// `BRepOffsetAPI_MakeOffsetShape.PerformByJoin`, but that call is a NON-thickening
// offset — on a face/shell it returns only the offset SKIN (a zero-volume shell),
// never a solid. The thickening route in this trimmed wasm is
// `BRepOffsetAPI_MakeThickSolid.MakeThickSolidBySimple(shape, offset)` (the same
// class shell() already uses), which turns an open face/shell into a closed solid
// of volume ≈ area × |thickness|. That is what this op calls.

import type { Occt } from "../oc/init.js";
import { Solid } from "../solid/solid.js";

export interface ThickenOptions {
  /**
   * Distribute the wall SYMMETRICALLY about the surface — the input surface ends
   * up on the solid's mid-plane, with half the wall grown to each side. The total
   * wall thickness (and hence the volume) is unchanged; only WHERE the material
   * sits relative to the surface differs. Default `false` grows the whole wall to
   * one side of the surface.
   */
  readonly bothSides?: boolean;
}

/**
 * Thicken an open sheet body — a `Solid` whose underlying shape is a face or
 * shell (§14 body kinds `"face" | "shell"`) — into a closed solid of wall
 * `thickness` (SI metres).
 *
 * The SIGN of `thickness` chooses which side of the surface the material grows
 * toward (negative grows the other way); only a zero / non-finite wall is
 * rejected. `opts.bothSides` centres the wall on the surface instead.
 */
export function thicken(
  oc: Occt,
  surface: Solid,
  thickness: number,
  opts?: ThickenOptions,
): Solid {
  // Magnitude pre-validation BEFORE any OCCT allocation (revolve.ts:20 pattern):
  // a zero, NaN, or infinite wall makes MakeThickSolidBySimple raise an opaque
  // Standard_Failure (or hand back an empty shape) after temporaries exist. Fail
  // here with a NAMED error while there is nothing to clean up. The sign is
  // meaningful (it selects the side), so only zero / non-finite is rejected.
  if (!Number.isFinite(thickness) || thickness === 0) {
    throw new Error(`thicken: thickness must be a finite non-zero number (got ${thickness})`);
  }

  const bothSides = opts?.bothSides ?? false;
  // Every OCCT temporary is freed on EVERY exit (incl. a Standard_Failure from the
  // offset solver on a self-intersecting wall), in reverse allocation order.
  const trash: Array<{ delete(): void }> = [];
  try {
    // The shape the thick-solid is built FROM. One-sided: the input surface
    // itself. Both-sides: the surface first offset by HALF the wall to one side
    // (PerformBySimple → an offset skin), so the ORIGINAL surface lands on the
    // finished solid's mid-plane once the full wall is grown from that skin.
    let base = surface.shape;
    if (bothSides) {
      const off = new oc.BRepOffsetAPI_MakeOffsetShape();
      trash.push(off);
      off.PerformBySimple(surface.shape, -thickness / 2);
      const skin = off.Shape();
      trash.push(skin);
      if (skin.IsNull()) {
        throw new Error("thicken: could not offset the surface to its mid-plane");
      }
      base = skin;
    }

    const maker = new oc.BRepOffsetAPI_MakeThickSolid();
    trash.push(maker);
    maker.MakeThickSolidBySimple(base, thickness);
    if (!maker.IsDone()) {
      throw new Error("thicken: the offset solver did not complete (wall too thick for the surface?)");
    }
    const shape = maker.Shape();
    // The Shape() handle is an owned allocation: free it before any throw, and on
    // success hand it (or its reversed twin) to the returned Solid, which frees it.
    if (shape.IsNull()) {
      shape.delete();
      throw new Error("thicken: produced an empty shape");
    }

    // Guarantee a POSITIVELY-oriented solid. Depending on the input face's
    // orientation, MakeThickSolidBySimple can return a topologically valid solid
    // whose faces point inward — its signed volume is negative, so Solid.volume()
    // (props.Mass(), which is SIGNED) would report a negative volume and every
    // downstream mass/boolean would misbehave. Reverse the orientation — same
    // geometry, same side, sign flipped positive — when that happens.
    const props = new oc.GProp_GProps_1();
    let signed: number;
    try {
      oc.BRepGProp.VolumeProperties_1(shape, props, false, false, false);
      signed = props.Mass();
    } finally {
      props.delete();
    }
    if (signed < 0) {
      const rev = shape.Reversed();
      shape.delete();
      return new Solid(oc, rev);
    }
    return new Solid(oc, shape);
  } finally {
    for (let i = trash.length - 1; i >= 0; i--) trash[i]!.delete();
  }
}
