// Assembly instance layer (M4) in r3f. Renders N copies of the part at the given
// body poses (mate-solved + exploded, or live simulation poses), reusing buildPart
// so each instance has the exact materials. Geometry is rebuilt only when the set
// of instance ids changes; per-frame pose updates (simulation) are just transform
// props, so stepping never re-tessellates.

import { useEffect, useMemo } from "react";
import type * as THREE from "three";
import type { ThreeEvent } from "@react-three/fiber";
import { buildPart, disposePart } from "../viewport/buildMesh.js";
import { resolveMatePick, type MatePickHit } from "../viewport/matePick.js";
import type { TransferMesh } from "../worker/protocol.js";
import type { Quat, Vec3 } from "../assembly/model.js";

export interface InstanceBody {
  id: string;
  position: Vec3;
  orientation: Quat;
}

export function Assembly({
  mesh,
  instances,
  onMatePick,
}: {
  mesh: TransferMesh | null;
  instances: readonly InstanceBody[] | null;
  /**
   * Called when an instance FACE is left-clicked while mate authoring is armed
   * (M4.2). Passing it is what makes mate picking reachable at all — without a
   * handler the instances stay inert, which is why "Add mate → 0/2" could never
   * advance. Left undefined outside mate mode so normal orbiting is unaffected.
   */
  onMatePick?: (hit: MatePickHit) => void;
}): React.JSX.Element | null {
  const ids = instances ? instances.map((b) => b.id).join("|") : "";
  // One BuiltPart per instance id; stable across pose-only updates.
  // Rebuild only when the mesh or the id set changes (not on pose updates).
  const parts = useMemo(
    () => (mesh && instances ? instances.map(() => buildPart(mesh)) : []),
    [mesh, ids],
  );
  useEffect(() => {
    return () => {
      for (const p of parts) disposePart(p);
    };
  }, [parts]);

  // Tag each instance group with its id and publish the group list so the canvas
  // right-click menu can raycast them to resolve which instance was clicked (the
  // base Part isn't rendered while instances exist). Ids are stable with `parts`.
  useEffect(() => {
    const vp = ((globalThis as { __plastiqViewport?: { instanceGroups?: unknown[] } })
      .__plastiqViewport ??= {});
    if (instances && parts.length === instances.length) {
      instances.forEach((b, i) => {
        parts[i]!.group.userData["instanceId"] = b.id;
      });
      vp.instanceGroups = parts.map((p) => p.group);
    } else {
      vp.instanceGroups = [];
    }
    return () => {
      vp.instanceGroups = [];
    };
  }, [parts, instances]);

  /** Route an instance click through the pure resolver (viewport/matePick.ts). */
  const handlePointerDown = (e: ThreeEvent<PointerEvent>, instanceId: string): void => {
    if (!onMatePick) return; // not authoring a mate: leave orbit/zoom alone
    const pick = resolveMatePick({
      instanceId,
      button: e.button,
      faceIndex: e.faceIndex,
      object: e.object as THREE.Mesh,
      point: e.point,
    });
    if (!pick) return;
    e.stopPropagation(); // only the nearest instance takes the pick
    onMatePick(pick);
  };

  if (!instances || parts.length !== instances.length) return null;
  return (
    <>
      {instances.map((b, i) => (
        <primitive
          key={b.id}
          object={parts[i]!.group}
          position={b.position}
          quaternion={b.orientation}
          onPointerDown={(e: ThreeEvent<PointerEvent>) => handlePointerDown(e, b.id)}
        />
      ))}
    </>
  );
}
