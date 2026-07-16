// Loft (ThruSections) through stacked section profiles, and sweep (MakePipeShell)
// of a profile along a spine.

import type { BRepBuilderAPI_TransitionMode, TopoDS_Wire } from "opencascade.js";

import type { Occt } from "../oc/init.js";
import { Solid } from "../solid/solid.js";
import type { Sketch } from "../sketch/sketch.js";
import { buildSpineWire, type SpinePath } from "../sketch/spine.js";

export interface LoftOptions {
  /** Ruled (straight) transitions between sections instead of smooth. */
  readonly ruled: boolean;
}

/** Transition mode at corners of a multi-edge spine (MakePipeShell). */
export type SweepTransition = "right" | "round" | "transformed";

export interface SweepOptions {
  /**
   * Section frame along the spine.
   * - `correctedFrenet` (default): stable orientation that survives corners.
   * - `frenet`: pure Frenet frame (can flip at inflection).
   * (`fixed` was removed: it was not distinct from corrected Frenet — T17/C8.)
   */
  readonly mode?: "correctedFrenet" | "frenet";
  /**
   * How adjacent swept sections meet at spine corners.
   * - `right` (default): miter / RightCorner.
   * - `round`: RoundCorner blend.
   * - `transformed`: Transformed (no intersection at corners).
   */
  readonly transition?: SweepTransition;
}

/** Loft a solid through ≥2 section profiles. */
export function loft(oc: Occt, sketches: readonly Sketch[], opts: LoftOptions): Solid {
  if (sketches.length < 2) throw new Error("loft: needs at least 2 section profiles");
  const maker = new oc.BRepOffsetAPI_ThruSections(true, opts.ruled, 1e-6);
  const progress = new oc.Message_ProgressRange_1();
  // Wires are built inside the try so a throw from `toWire`/`Build`/`Shape` (a
  // Standard_Failure on a degenerate profile is reachable in normal editing) still
  // frees the maker, the progress range, and every wire created so far.
  const wires: TopoDS_Wire[] = [];
  try {
    for (const s of sketches) {
      const w = s.toWire(oc);
      wires.push(w);
      maker.AddWire(w);
    }
    maker.Build(progress);
    const shape = maker.Shape();
    // The null `Shape()` handle is itself an owned allocation — free it before the
    // throw. On success the returned Solid owns it, so it is freed exactly once.
    if (shape.IsNull()) {
      shape.delete();
      throw new Error("loft: produced an empty shape");
    }
    return new Solid(oc, shape);
  } finally {
    maker.delete();
    progress.delete();
    for (const w of wires) w.delete();
  }
}

/**
 * Sweep a profile along a spine path into a solid pipe.
 *
 * Uses `BRepOffsetAPI_MakePipeShell` (not the simpler `BRepOffsetAPI_MakePipe`)
 * so MULTI-EDGE / cornered polyline spines sweep the FULL path: `MakePipe` only
 * follows the first edge of a multi-edge spine and silently drops the rest.
 * Defaults: corrected-Frenet frame + RightCorner transition (miter). Override
 * via {@link SweepOptions} (G8). Then capped into a solid.
 */
export function sweep(oc: Occt, sketch: Sketch, path: SpinePath, opts?: SweepOptions): Solid {
  const spine = buildSpineWire(oc, path);
  const profile = sketch.toWire(oc); // MakePipeShell sweeps a wire, then caps it
  const maker = new oc.BRepOffsetAPI_MakePipeShell(spine);
  const progress = new oc.Message_ProgressRange_1();
  // The maker/progress/profile/spine are freed in a finally so a Standard_Failure
  // thrown by `Add_1`/`Build`/`MakeSolid`/`Shape` (reachable on a profile/spine the
  // sweep can't resolve) frees them too — a manual closure called only on the
  // explicit `if (!…)` branches would be bypassed by such a throw.
  try {
    const mode = opts?.mode ?? "correctedFrenet";
    // SetMode_1(IsFrenet): true = Frenet, false = corrected Frenet.
    if (mode === "frenet") maker.SetMode_1(true);
    else maker.SetMode_1(false);

    const transition = opts?.transition ?? "right";
    const TM = oc.BRepBuilderAPI_TransitionMode;
    const tm =
      transition === "round"
        ? TM.BRepBuilderAPI_RoundCorner
        : transition === "transformed"
          ? TM.BRepBuilderAPI_Transformed
          : TM.BRepBuilderAPI_RightCorner;
    maker.SetTransitionMode(tm as unknown as BRepBuilderAPI_TransitionMode);
    maker.Add_1(profile, false, false);

    if (!maker.IsReady()) throw new Error("sweep: the profile/spine are not ready to sweep");
    maker.Build(progress);
    if (!maker.IsDone()) throw new Error("sweep: MakePipeShell failed to build the swept shell");
    if (!maker.MakeSolid()) throw new Error("sweep: could not cap the swept shell into a solid");
    const shape = maker.Shape();
    // The null `Shape()` handle is itself an owned allocation — free it before the
    // throw. On success the returned Solid owns it, so it is freed exactly once.
    if (shape.IsNull()) {
      shape.delete();
      throw new Error("sweep: produced an empty shape");
    }
    return new Solid(oc, shape);
  } finally {
    maker.delete();
    progress.delete();
    profile.delete();
    spine.delete();
  }
}
