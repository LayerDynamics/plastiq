// Assembly instance layer (M4) in r3f. Renders N copies of the part at the given
// body poses (mate-solved + exploded, or live simulation poses), reusing buildPart
// so each instance has the exact materials. Geometry is rebuilt only when the set
// of instance ids changes; per-frame pose updates (simulation) are just transform
// props, so stepping never re-tessellates.

import { useEffect, useMemo } from "react";
import { buildPart, disposePart } from "../viewport/buildMesh.js";
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
}: {
  mesh: TransferMesh | null;
  instances: readonly InstanceBody[] | null;
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

  if (!instances || parts.length !== instances.length) return null;
  return (
    <>
      {instances.map((b, i) => (
        <primitive
          key={b.id}
          object={parts[i]!.group}
          position={b.position}
          quaternion={b.orientation}
        />
      ))}
    </>
  );
}
