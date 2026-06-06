// Loft (ThruSections) through stacked section profiles, and sweep (MakePipeShell)
// of a profile along a spine.

import type { BRepBuilderAPI_TransitionMode } from "opencascade.js";

import type { Occt } from "../oc/init.js";
import { Solid } from "../solid/solid.js";
import type { Sketch } from "../sketch/sketch.js";
import { buildSpineWire, type SpinePath } from "../sketch/spine.js";

export interface LoftOptions {
  /** Ruled (straight) transitions between sections instead of smooth. */
  readonly ruled: boolean;
}

/** Loft a solid through ≥2 section profiles. */
export function loft(oc: Occt, sketches: readonly Sketch[], opts: LoftOptions): Solid {
  if (sketches.length < 2) throw new Error("loft: needs at least 2 section profiles");
  const maker = new oc.BRepOffsetAPI_ThruSections(true, opts.ruled, 1e-6);
  const wires = sketches.map((s) => s.toWire(oc));
  for (const w of wires) maker.AddWire(w);
  const progress = new oc.Message_ProgressRange_1();
  maker.Build(progress);
  const shape = maker.Shape();
  maker.delete();
  progress.delete();
  for (const w of wires) w.delete();
  if (shape.IsNull()) throw new Error("loft: produced an empty shape");
  return new Solid(oc, shape);
}

/**
 * Sweep a profile along a spine path into a solid pipe.
 *
 * Uses `BRepOffsetAPI_MakePipeShell` (not the simpler `BRepOffsetAPI_MakePipe`)
 * so MULTI-EDGE / cornered polyline spines sweep the FULL path: `MakePipe` only
 * follows the first edge of a multi-edge spine and silently drops the rest.
 * MakePipeShell is driven with a corrected-Frenet frame (a stable section
 * orientation that survives corners) and a `RightCorner` transition (adjacent
 * swept sections are intersected into a clean miter at each corner), then capped
 * into a solid. A straight/collinear spine sweeps identically to before.
 */
export function sweep(oc: Occt, sketch: Sketch, path: SpinePath): Solid {
  const spine = buildSpineWire(oc, path);
  const profile = sketch.toWire(oc); // MakePipeShell sweeps a wire, then caps it
  const maker = new oc.BRepOffsetAPI_MakePipeShell(spine);
  const progress = new oc.Message_ProgressRange_1();
  const cleanup = (): void => {
    maker.delete();
    progress.delete();
    profile.delete();
    spine.delete();
  };
  const fail = (msg: string): never => {
    cleanup();
    throw new Error(msg);
  };

  maker.SetMode_1(false); // corrected Frenet: stable orientation along the spine
  maker.SetTransitionMode(
    oc.BRepBuilderAPI_TransitionMode.BRepBuilderAPI_RightCorner as unknown as BRepBuilderAPI_TransitionMode,
  );
  maker.Add_1(profile, false, false);

  if (!maker.IsReady()) fail("sweep: the profile/spine are not ready to sweep");
  maker.Build(progress);
  if (!maker.IsDone()) fail("sweep: MakePipeShell failed to build the swept shell");
  if (!maker.MakeSolid()) fail("sweep: could not cap the swept shell into a solid");
  const shape = maker.Shape();
  if (shape.IsNull()) fail("sweep: produced an empty shape");
  cleanup();
  return new Solid(oc, shape);
}
