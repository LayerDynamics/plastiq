// Tiny seam so E2Es can assert which gizmos are mounted (they live in the WebGL
// canvas, not the DOM). Each gizmo flags itself on __plastiqViewport.gizmos.

import { useEffect } from "react";

interface ViewportGlobal {
  gizmos?: Record<string, boolean>;
}

export function useGizmoPresence(name: string, active = true): void {
  useEffect(() => {
    const vp = ((globalThis as { __plastiqViewport?: ViewportGlobal }).__plastiqViewport ??= {});
    (vp.gizmos ??= {})[name] = active;
    return () => {
      if (vp.gizmos) vp.gizmos[name] = false;
    };
  }, [name, active]);
}
