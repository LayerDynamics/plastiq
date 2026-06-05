// Loft feature (SPEC-4 FR-12): a solid spanning a sequence of section profiles,
// via OCCT BRepOffsetAPI_ThruSections. Sections are sketches (each on its own
// datum plane); the loft interpolates between their profile wires — ruled
// (straight segments between sections) or smooth (a C2 surface).

import type { Occt } from "../oc/init.js";
import type { Sketch } from "../sketch/sketch.js";
import { Solid } from "../solid/solid.js";

export interface LoftOptions {
  /** Straight (ruled) transitions between sections; otherwise a smooth surface. */
  readonly ruled?: boolean;
  /** Build a closed solid (default) rather than an open shell. */
  readonly solid?: boolean;
  /** 3D presentation tolerance for the smooth case (m). */
  readonly tolerance?: number;
}

/**
 * Loft through `sections` (≥ 2 profile sketches, in order). Each section's
 * closed wire becomes a cross-section; the result is a solid spanning them.
 */
export function loft(oc: Occt, sections: readonly Sketch[], opts: LoftOptions = {}): Solid {
  if (sections.length < 2) {
    throw new Error(`loft needs ≥ 2 sections, got ${sections.length}`);
  }
  const solid = opts.solid ?? true;
  const ruled = opts.ruled ?? false;
  const tolerance = opts.tolerance ?? 1e-6;

  const ts = new oc.BRepOffsetAPI_ThruSections(solid, ruled, tolerance);
  const wires = sections.map((s) => s.toWire(oc));
  const range = new oc.Message_ProgressRange_1();
  try {
    for (const w of wires) ts.AddWire(w);
    ts.Build(range);
    const result = new Solid(oc, ts.Shape());
    if (!result.isValid()) {
      result.delete();
      throw new Error("loft produced an invalid solid");
    }
    return result;
  } finally {
    range.delete();
    for (const w of wires) w.delete();
    ts.delete();
  }
}
