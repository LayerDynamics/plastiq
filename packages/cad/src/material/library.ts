// Material library (SPEC-4 FR-22): the registry that resolves a material name to
// its `Material`. Seeded from the built-in presets and extensible with custom
// materials; a `require` lookup fails loudly rather than returning a default.

import { MATERIAL_PRESETS } from "./presets.js";
import type { Material } from "./properties.js";

export class MaterialLibrary {
  private readonly byName = new Map<string, Material>();

  /** Register a material (overwrites any existing entry with the same name). */
  add(material: Material): Material {
    this.byName.set(material.name, material);
    return material;
  }

  /** Look up a material by name, or `undefined` if not registered. */
  get(name: string): Material | undefined {
    return this.byName.get(name);
  }

  /** Look up a material by name, throwing a typed error if unknown (NFR-3). */
  require(name: string): Material {
    const m = this.byName.get(name);
    if (!m) throw new Error(`unknown material: ${name}`);
    return m;
  }

  /** Registered material names, sorted (deterministic — NFR-2). */
  names(): string[] {
    return [...this.byName.keys()].sort();
  }
}

/** A library pre-seeded with every built-in preset. */
export function defaultLibrary(): MaterialLibrary {
  const lib = new MaterialLibrary();
  for (const m of Object.values(MATERIAL_PRESETS)) lib.add(m);
  return lib;
}
