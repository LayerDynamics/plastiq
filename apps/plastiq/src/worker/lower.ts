// Assembly → SimManifest lowering (SPEC-5 M4.5, FR-35). Maps the editor's
// AssemblyModel onto the @plastiq/cad lowering path (Component hierarchy →
// exportForSim + lowerJoints). Every instance becomes one body posed into the
// COM frame (a grounded instance — the editor's "Fix" toggle — becomes a static
// body); every joint kind lowers to a constraint (revolute → hinge,
// prismatic → slider, cylindrical → cylindrical, ball → ball, planar → planar,
// fixed → fixed). The isLowerable guard (and the skippedJoints report) remains
// as the extension point should a future joint kind arrive without a
// physics-layer equivalent. Runs in the geometry worker (needs OCCT).

import {
  Component,
  defaultLibrary,
  exportForSim,
  isLowerable,
  lowerJoints,
  makeBody,
  makeJoint,
  massProperties,
  type Occt,
  type Solid,
  type JointBinding,
  type SimManifest,
} from "@plastiq/cad";
import type { AssemblyModel, Vec3 } from "../assembly/model.js";

const DEFAULT_MATERIAL = "structural-steel";

/** Result of a lowering attempt: the manifest + any joints that couldn't lower. */
export interface LowerResult {
  manifest: SimManifest;
  /** Joint ids skipped because their kind has no physics-layer equivalent.
   * Every CURRENT joint kind lowers, so this is empty today — it stays as the
   * report channel for any future non-lowerable kind. */
  skippedJoints: string[];
  /** The shared part's local centre of mass (for the simulate render-back). */
  localCom: Vec3;
}

/**
 * Lower an assembly (instances of one shared `solid` + their joints) to a
 * SimManifest. Each instance → a body at its world pose; every joint → a
 * constraint. Throws if there are no instances.
 */
export function lowerAssembly(
  oc: Occt,
  solid: Solid,
  assembly: AssemblyModel,
  source: string,
): LowerResult {
  if (assembly.instances.length === 0) {
    throw new Error("lowerAssembly: the assembly has no component instances");
  }

  // One Component per instance (placement = the instance's world pose), each
  // holding a body that shares the part geometry. exportForSim composes each
  // body's local COM up through its placement (COM-frame invariant).
  const root = new Component("assembly");
  for (const inst of assembly.instances) {
    const comp = new Component(inst.id);
    comp.placement = {
      position: [...inst.pose.position],
      orientation: [...inst.pose.orientation],
    };
    // The editor's "Fix (ground)" toggle → a static sim body (ManifestBody.fixed),
    // so grounded assemblies don't free-fall under gravity.
    comp.fixed = inst.fixed === true;
    const body = makeBody(inst.id, DEFAULT_MATERIAL);
    body.geometry = solid; // shared geometry; exportForSim reads it read-only
    comp.addBody(body);
    root.addChild(comp);
  }

  // Lower the joints. Every current kind is lowerable; the guard stays as the
  // defensive report path for any future kind without a sim equivalent.
  const skippedJoints: string[] = [];
  const bindings: JointBinding[] = [];
  for (const j of assembly.joints) {
    if (!isLowerable(j.kind)) {
      skippedJoints.push(j.id);
      continue;
    }
    bindings.push({
      // parent/child indices are unused by lowerJoint (it keys off kind+frame);
      // the body-name refs are what the manifest constraint carries.
      joint: makeJoint(j.kind, 0, 0, { origin: [...j.origin], axis: [...j.axis] }),
      bodyA: j.parent,
      bodyB: j.child,
    });
  }
  const constraints = lowerJoints(bindings);

  const manifest = exportForSim(oc, root, defaultLibrary(), source, { constraints });
  // The shared part's local COM (geometric centroid; density-independent) — the
  // simulate loop maps each sim body's world COM back to the render group with it.
  const com = massProperties(oc, solid, 1).com;
  return { manifest, skippedJoints, localCom: [com[0], com[1], com[2]] };
}
