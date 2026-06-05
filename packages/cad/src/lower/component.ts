// The component hierarchy + material library used to assemble a SimManifest.

import type { Solid } from "../solid/solid.js";

export interface Placement {
  position: readonly [number, number, number];
  orientation: readonly [number, number, number, number];
}

export const IDENTITY_PLACEMENT: Placement = { position: [0, 0, 0], orientation: [0, 0, 0, 1] };

/** A rigid body in the lowering hierarchy; `geometry` supplies its collider. */
export class Body {
  geometry: Solid | null = null;
  constructor(
    readonly id: string,
    readonly material: string,
  ) {}
}

export function makeBody(id: string, material: string): Body {
  return new Body(id, material);
}

/** A node in the assembly tree: an optional placement plus bodies and children. */
export class Component {
  placement: Placement | null = null;
  readonly bodies: Body[] = [];
  readonly children: Component[] = [];
  constructor(readonly name: string) {}

  addBody(body: Body): void {
    this.bodies.push(body);
  }
  addChild(child: Component): void {
    this.children.push(child);
  }
}

export interface MaterialLibrary {
  /** Density in kg/m³ for a material name (falls back to ~water for unknowns). */
  density(material: string): number;
}

const DENSITIES: Record<string, number> = {
  "structural-steel": 7850,
  steel: 7850,
  aluminum: 2700,
  aluminium: 2700,
  titanium: 4500,
  abs: 1040,
  pla: 1240,
  brass: 8500,
};

export function defaultLibrary(): MaterialLibrary {
  return { density: (material) => DENSITIES[material] ?? 1000 };
}
