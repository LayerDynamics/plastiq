// Section-analysis gizmo (FR-14): a translucent quad showing WHERE the section cut
// sits, PLUS a transform handle you can drag along the section axis to move the cut
// (like moving a face with the gizmo). Dragging updates the store section `t`, which
// re-drives the clip plane (Section.tsx) live; the axis slider stays in sync.

import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { TransformControls } from "@react-three/drei";
import { useCadStore } from "../../store/store.js";
import { sectionTFromOffset } from "../../viewport/section.js";
import { SELECT_ORANGE } from "../colors.js";
import { useGizmoPresence } from "./presence.js";
import type { BuiltPart } from "../../viewport/buildMesh.js";

const hex = (n: number): string => `#${n.toString(16).padStart(6, "0")}`;
const AXIS_NORMAL: Record<"x" | "y" | "z", [number, number, number]> = {
  x: [1, 0, 0],
  y: [0, 1, 0],
  z: [0, 0, 1],
};

export function SectionAnalysisGizmo({ part }: { part: BuiltPart | null }): React.JSX.Element | null {
  const section = useCadStore((s) => s.section);
  const show = section != null && part != null;
  useGizmoPresence("sectionAnalysis", show);
  const handle = useRef<THREE.Mesh>(null);
  const dragging = useRef(false);

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
      min,
      max,
    };
  }, [section, part]);

  // Keep the drag handle at the cut centre when the cut moves from elsewhere (the
  // slider/axis change), but never while the user is actively dragging it.
  useEffect(() => {
    if (handle.current && frame && !dragging.current) handle.current.position.set(...frame.position);
  }, [frame]);

  // Drag → translate the handle along the axis → new `t` (clamped 0..1) → store.
  const onObjectChange = (): void => {
    if (!handle.current || !frame || !section) return;
    const p = handle.current.position;
    const v = section.axis === "x" ? p.x : section.axis === "y" ? p.y : p.z;
    const t = sectionTFromOffset(frame.min, frame.max, v);
    useCadStore.getState().setSection({ axis: section.axis, t });
  };

  if (!show || !frame || !section) return null;
  return (
    <>
      {/* The cut-plane quad (controlled by `t`). */}
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
      {/* Drag handle: a single-axis transform arrow on the cut, along the section
          normal. drei disables OrbitControls while dragging. */}
      <TransformControls
        mode="translate"
        showX={section.axis === "x"}
        showY={section.axis === "y"}
        showZ={section.axis === "z"}
        onMouseDown={() => {
          dragging.current = true;
        }}
        onMouseUp={() => {
          dragging.current = false;
        }}
        onObjectChange={onObjectChange}
      >
        <mesh ref={handle} renderOrder={2}>
          <sphereGeometry args={[0.005, 16, 16]} />
          <meshBasicMaterial color={hex(SELECT_ORANGE)} />
        </mesh>
      </TransformControls>
    </>
  );
}
