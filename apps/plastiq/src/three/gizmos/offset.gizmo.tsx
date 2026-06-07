// Offset gizmo: an arrow from the base datum origin along its normal to the
// active sketch's offset plane, visualising the offset distance in 3D. Shown when
// sketching on a datum with a non-zero offset. (Section offset is shown by the
// section-analysis gizmo; drag-to-set is a follow-up — the toolbar input drives it.)

import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { useSketchStore } from "../../sketch/sketchStore.js";
import { resolveDatumPlane } from "../../worker/sketchPlane.js";
import { ACCENT_BLUE } from "../colors.js";
import { useGizmoPresence } from "./presence.js";

export function OffsetGizmo(): React.JSX.Element | null {
  const active = useSketchStore((s) => s.active);
  const onFace = useSketchStore((s) => s.model.face != null);
  const plane = useSketchStore((s) => s.model.plane);
  const offset = useSketchStore((s) => s.model.offset ?? 0);
  const show = active && !onFace && Math.abs(offset) > 1e-9;
  useGizmoPresence("offset", show);

  const arrow = useMemo(() => {
    if (!show) return null;
    const base = resolveDatumPlane(plane, 0); // base datum (offset 0)
    const sign = offset >= 0 ? 1 : -1;
    const dir = new THREE.Vector3(
      base.normal[0] * sign,
      base.normal[1] * sign,
      base.normal[2] * sign,
    );
    const origin = new THREE.Vector3(base.origin[0], base.origin[1], base.origin[2]);
    const helper = new THREE.ArrowHelper(dir, origin, Math.abs(offset), ACCENT_BLUE, 0.006, 0.004);
    return helper;
  }, [show, plane, offset]);

  useEffect(() => {
    return () => {
      arrow?.dispose();
    };
  }, [arrow]);

  if (!show || !arrow) return null;
  return <primitive object={arrow} />;
}
