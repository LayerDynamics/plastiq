// exportForSim — walk a component hierarchy and emit a SimManifest. Each body's
// world centre-of-mass pose is composed down through its component placements;
// its collider is the part's convex shape — one convex hull for a convex part,
// or several convex pieces (convex decomposition) for a concave one. A component
// marked `fixed` grounds its whole subtree: those bodies emit `fixed: true` and
// spawn static.

import type { Occt } from "../oc/init.js";
import { quatMul, quatRotate, vAdd, type Quat, type Vec3 } from "../assembly/quat.js";
import { tessellateTagged } from "../mesh/tessellate.js";
import { bodyKindOf } from "../solid/bodyKind.js";
import { IDENTITY_PLACEMENT, type Component, type MaterialLibrary, type Placement } from "./component.js";
import { collidersFor } from "./decompose.js";
import { massProperties } from "./massprops.js";
import type { ManifestBody, ManifestConstraint, SimManifest } from "./manifest.js";

const GRAVITY: readonly [number, number, number] = [0, 0, -9.81];

// Collision meshes only need the part's surface, so a coarse tessellation
// (0.5 mm) is plenty for the convex hull(s) / decomposition.
const HULL_DEFLECTION = 5e-4;

/** Compose a child placement under a parent (parent ∘ child). */
function compose(parent: Placement, child: Placement): Placement {
  const pPos = parent.position as Vec3;
  const pOri = parent.orientation as Quat;
  const cPos = child.position as Vec3;
  return {
    position: vAdd(pPos, quatRotate(pOri, cPos)),
    orientation: quatMul(pOri, child.orientation as Quat),
  };
}

export interface ExportOptions {
  constraints?: ManifestConstraint[];
}

/** Lower a component tree (+ joint constraints) to a SimManifest. */
export function exportForSim(
  oc: Occt,
  root: Component,
  library: MaterialLibrary,
  source: string,
  opts?: ExportOptions,
): SimManifest {
  const bodies: ManifestBody[] = [];

  const walk = (comp: Component, parent: Placement, parentFixed: boolean): void => {
    const here = comp.placement ? compose(parent, comp.placement) : parent;
    // Grounding composes down the tree like the placement does: a fixed
    // ancestor anchors every body in its subtree.
    const fixed = parentFixed || comp.fixed;
    for (const body of comp.bodies) {
      const solid = body.geometry;
      // K5 — a Body reaching lowering with no geometry is a WIRING BUG, not a
      // legitimate case: every producing path assigns `body.geometry` (the
      // synthesized body0 wrapping the bare part, and each assembly instance in
      // worker/lower.ts share the part solid). Silently `continue`-ing made a
      // mis-wired body VANISH from the SimManifest with no error; name it and
      // throw instead so the defect surfaces at lowering rather than as a body
      // that never spawns.
      if (!solid) {
        throw new Error(
          `exportForSim: body '${body.id}' in component '${comp.name}' has no geometry — it cannot be lowered to a sim body`,
        );
      }
      // Sim lowering needs a closed solid (volume → mass, convex hull colliders).
      // Shells/faces (§14) are first-class CAD bodies but must not silently become
      // zero-mass rigid bodies — reject with a named error (R8 / §17).
      const kind = bodyKindOf(oc, solid);
      if (kind !== "solid") {
        throw new Error(
          `exportForSim: body '${body.id}' in component '${comp.name}' is a ${kind}, not a solid — only solids can be lowered to sim`,
        );
      }
      const density = library.density(body.material);
      const mp = massProperties(oc, solid, density);
      const localCom: Vec3 = [mp.com[0], mp.com[1], mp.com[2]];

      // Build the collider(s) from the part's actual tessellation, expressed in
      // the body-local frame (centred on the COM): one convex hull for a convex
      // part, or a convex decomposition for a concave one.
      const mesh = tessellateTagged(oc, solid, { linearDeflection: HULL_DEFLECTION });
      const local: number[] = new Array<number>(mesh.vertices.length);
      for (let k = 0; k < mesh.vertices.length; k += 3) {
        local[k] = mesh.vertices[k]! - localCom[0];
        local[k + 1] = mesh.vertices[k + 1]! - localCom[1];
        local[k + 2] = mesh.vertices[k + 2]! - localCom[2];
      }
      const colliders = collidersFor(local, mesh.indices, mp.volume);

      const worldCom = vAdd(here.position as Vec3, quatRotate(here.orientation as Quat, localCom));
      bodies.push({
        id: body.id,
        mass: mp.mass,
        com: worldCom,
        orientation: here.orientation,
        colliders,
        // A grounded body spawns static; mass stays the real volume × density
        // (backends key static purely off `fixed`).
        ...(fixed ? { fixed: true } : {}),
      });
    }
    for (const child of comp.children) walk(child, here, fixed);
  };
  walk(root, IDENTITY_PLACEMENT, false);

  return {
    version: 1,
    source,
    gravity: GRAVITY,
    bodies,
    constraints: opts?.constraints ?? [],
  };
}
