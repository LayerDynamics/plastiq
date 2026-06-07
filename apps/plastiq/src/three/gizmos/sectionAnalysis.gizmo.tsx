// Section-analysis gizmo: a translucent quad showing WHERE the section cut sits,
// sized to the part and positioned at the cut along the section axis. Driven by
// the store section (the toolbar's axis/offset slider moves it). Orange, the
// section accent. Interactive drag-to-move is a follow-up (the slider drives it).

import { useMemo } from "react";
import * as THREE from "three";
import { useCadStore } from "../../store/store.js";
import { SELECT_ORANGE } from "../colors.js";
import { useGizmoPresence } from "./presence.js";
import type { BuiltPart } from "../../viewport/buildMesh.js";

const AXIS_NORMAL: Record<"x" | "y" | "z", [number, number, number]> = {
  x: [1, 0, 0],
  y: [0, 1, 0],
  z: [0, 0, 1],
};

export function SectionAnalysisGizmo({ part }: { part: BuiltPart | null }): React.JSX.Element | null {
  const section = useCadStore((s) => s.section);
  const show = section != null && part != null;
  useGizmoPresence("sectionAnalysis", show);

  const frame = useMemo(() => {
    if (!section || !part) return null;
    const box = new THREE.Box3().setFromObject(part.group);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const { axis, t } = section;
    const min = axis === "x" ? box.min.x : axis === "y" ? box.min.y : box.min.z;
    const max = axis === "x" ? box.max.x : axis === "y" ? box.max.y : box.max.z;
    const offset = min + t * (max - min);
    const pos = center.clone();
    if (axis === "x") pos.x = offset;
    else if (axis === "y") pos.y = offset;
    else pos.z = offset;
    const span = axis === "x" ? [size.y, size.z] : axis === "y" ? [size.x, size.z] : [size.x, size.y];
    const q = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 0, 1),
      new THREE.Vector3(...AXIS_NORMAL[axis]),
    );
    return {
      position: pos.toArray() as [number, number, number],
      quaternion: [q.x, q.y, q.z, q.w] as [number, number, number, number],
      w: Math.max(span[0]! * 1.15, 1e-3),
      h: Math.max(span[1]! * 1.15, 1e-3),
    };
  }, [section, part]);

  if (!show || !frame) return null;
  return (
    <mesh position={frame.position} quaternion={frame.quaternion} renderOrder={1}>
      <planeGeometry args={[frame.w, frame.h]} />
      <meshBasicMaterial
        color={SELECT_ORANGE}
        transparent
        opacity={0.16}
        side={THREE.DoubleSide}
        depthWrite={false}
      />
    </mesh>
  );
}
