// Loft (ThruSections) through stacked section profiles, and sweep (MakePipe)
// of a profile along a spine.

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

/** Sweep a profile face along a spine path, producing a solid pipe. */
export function sweep(oc: Occt, sketch: Sketch, path: SpinePath): Solid {
  const spine = buildSpineWire(oc, path);
  const profile = sketch.toFace(oc);
  const maker = new oc.BRepOffsetAPI_MakePipe_1(spine, profile);
  const shape = maker.Shape();
  maker.delete();
  profile.delete();
  spine.delete();
  if (shape.IsNull()) throw new Error("sweep: produced an empty shape");
  return new Solid(oc, shape);
}
