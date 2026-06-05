// Material manager (SPEC-4 FR-22): binds bodies (by name) to materials and
// resolves them — both to the full `Material` (for structural queries and the
// renderer) and to the manifest `MaterialData` the sim seam consumes (FR-26).
// An unassigned body fails loudly: a missing material is never silently defaulted.

import type { MaterialData } from "../lower/manifest.js";
import { defaultLibrary } from "./library.js";
import type { MaterialLibrary } from "./library.js";
import { type Material, toMaterialData } from "./properties.js";

export class MaterialManager {
  private readonly assignments = new Map<string, string>();

  constructor(readonly library: MaterialLibrary = defaultLibrary()) {}

  /** Assign `materialName` (must exist in the library) to a body. */
  assign(bodyName: string, materialName: string): void {
    // Resolve eagerly so an unknown material is caught at assignment time.
    this.library.require(materialName);
    this.assignments.set(bodyName, materialName);
  }

  /** The full material assigned to a body, throwing if none/unknown (NFR-3). */
  materialFor(bodyName: string): Material {
    const name = this.assignments.get(bodyName);
    if (name === undefined) {
      throw new Error(`no material assigned to body: ${bodyName}`);
    }
    return this.library.require(name);
  }

  /** The lowered `MaterialData` for a body — the sim-seam projection (FR-26). */
  dataFor(bodyName: string): MaterialData {
    return toMaterialData(this.materialFor(bodyName));
  }
}
