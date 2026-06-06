// The built part, rendered in r3f. Reuses buildMesh.buildPart so the faces, edges,
// corners AND their materials/colours (light-grey face, blue hover, orange select)
// are byte-identical to the legacy viewport — we only change HOW the group is
// mounted (declaratively, via <primitive>), not what it looks like.

import { useEffect, useMemo } from "react";
import { buildPart, disposePart, type BuiltPart } from "../viewport/buildMesh.js";
import type { TransferMesh } from "../worker/protocol.js";

/** Expose the built part on the global the E2E render seams read (builtPart). */
function publishBuiltPart(part: BuiltPart | null): void {
  (globalThis as { __plastiqViewport?: { builtPart: BuiltPart | null } }).__plastiqViewport ??= {
    builtPart: null,
  };
  (globalThis as { __plastiqViewport?: { builtPart: BuiltPart | null } }).__plastiqViewport!.builtPart =
    part;
}

export function Part({ mesh }: { mesh: TransferMesh | null }): React.JSX.Element | null {
  // Rebuild the three.js group only when the tessellation changes.
  const part = useMemo(() => (mesh ? buildPart(mesh) : null), [mesh]);

  useEffect(() => {
    publishBuiltPart(part);
    return () => {
      if (part) disposePart(part); // free GPU buffers when the part swaps/unmounts
      publishBuiltPart(null);
    };
  }, [part]);

  if (!part) return null;
  return <primitive object={part.group} />;
}
