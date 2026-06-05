// SimManifest export (SPEC-4 FR-25/FR-26). The full hierarchy-walking export is
// Task 3.4; this provides the real box→manifest path the M0 E2E (Task 0.9) and
// early integration use. It computes genuine mass properties from the exact
// B-rep and emits a centred-box collision shape placed at the solid's centre.

import { add, quatRotate, type Vec3 } from "../math/index.js";
import type { Component } from "../hierarchy/component.js";
import type { MaterialLibrary } from "../material/library.js";
import { toMaterialData } from "../material/properties.js";
import { makeBox } from "../solid/primitives.js";
import type { Occt } from "../oc/init.js";
import { massProperties } from "./massprops.js";
import { lowerShape, type LowerShapeOptions } from "./shape.js";
import {
  SIM_MANIFEST_VERSION,
  type BoundBodyData,
  type LoweredConstraint,
  type MaterialData,
  type SimManifest,
} from "./manifest.js";

/**
 * Build a one-body SimManifest for an axis-aligned box of SI dimensions
 * (dx, dy, dz). The collision shape is a centred box (half-extents) placed at
 * the box centre; mass/inertia come from the exact B-rep × the material density.
 */
export function boxToManifest(
  oc: Occt,
  name: string,
  dx: number,
  dy: number,
  dz: number,
  material: MaterialData,
): SimManifest {
  const solid = makeBox(oc, dx, dy, dz);
  try {
    const mass = massProperties(oc, solid, material.density);
    const body: BoundBodyData = {
      name,
      shape: { kind: "box", halfExtents: [dx / 2, dy / 2, dz / 2] },
      // makeBox places a corner at the origin → the centre (and COM) sits at the
      // half-dimensions; place the centred collision box there.
      translation: mass.com,
      orientation: [0, 0, 0, 1],
      material,
      mass,
    };
    return {
      version: SIM_MANIFEST_VERSION,
      source: `box:${name}`,
      bodies: [body],
      constraints: [],
    };
  } finally {
    solid.delete();
  }
}

export interface ExportOptions {
  /** Forwarded to shape lowering (tessellation deflection, fit tolerance). */
  readonly shape?: LowerShapeOptions;
  /**
   * Lowered assembly constraints (Task 4.4) to embed in `manifest.constraints`.
   * Produced by `lowerJoints` from the assembly's joints; every referenced body
   * name must exist in the exported bodies (validated by `isSimManifest`).
   */
  readonly constraints?: readonly LoweredConstraint[];
}

/**
 * Export a model (a component hierarchy) to a `SimManifest` (FR-25/FR-26).
 *
 * Walks every body in the tree with its composed world placement and, per body:
 *   • computes exact mass properties (volume, mass, central inertia) from the
 *     B-rep × the material density;
 *   • lowers the geometry to a collision `ShapeData` (Task 3.3);
 *   • resolves the material (by the body's `material` name) via `library`.
 *
 * FRAME: each body's frame origin is its **world centre of mass** and its axes
 * are the world orientation, so `translation = world COM`, `orientation = world
 * orientation`, and the body-frame `com` is the origin (`[0,0,0]`); the shape
 * geometry and central inertia are expressed in those body-local axes. This is
 * the invariant the bridge (Task 3.5) and geo-bindgen rely on.
 *
 * `constraints` is empty here; assembly→sim joint lowering (Task 4.4) populates
 * it. Throws if a body lacks geometry or material, or if body names collide
 * (names are the manifest's constraint reference keys and must be unique).
 */
export function exportForSim(
  oc: Occt,
  root: Component,
  library: MaterialLibrary,
  source: string,
  opts: ExportOptions = {},
): SimManifest {
  const bodies: BoundBodyData[] = [];
  const seen = new Set<string>();

  for (const placed of root.placedBodies()) {
    const { body, world } = placed;
    if (!body.geometry) {
      throw new Error(`cannot export body "${body.name}": no geometry attached`);
    }
    if (!body.material) {
      throw new Error(`cannot export body "${body.name}": no material assigned`);
    }
    if (seen.has(body.name)) {
      throw new Error(`duplicate body name "${body.name}" (body names must be unique)`);
    }
    seen.add(body.name);

    const material = library.require(body.material);
    const mp = massProperties(oc, body.geometry, material.density);
    const shape = lowerShape(oc, body.geometry, opts.shape);

    // Compose the local COM up through the body's world placement.
    const localCom: Vec3 = [mp.com[0], mp.com[1], mp.com[2]];
    const worldCom = add(world.position, quatRotate(world.orientation, localCom));

    bodies.push({
      name: body.name,
      shape,
      translation: worldCom,
      orientation: world.orientation,
      material: toMaterialData(material),
      mass: {
        volume: mp.volume,
        mass: mp.mass,
        // The body frame is COM-centred (origin = COM).
        com: [0, 0, 0],
        inertia: mp.inertia,
      },
    });
  }

  return {
    version: SIM_MANIFEST_VERSION,
    source,
    bodies,
    constraints: opts.constraints ? [...opts.constraints] : [],
  };
}
