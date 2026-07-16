// Section-analysis gizmo (FR-14 / Fusion-style): a translucent quad showing WHERE
// the cut sits, PLUS a transform handle you can drag along the section normal to
// move the cut. Dragging updates the store; the axis slider / flip stay in sync.

import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { TransformControls } from "@react-three/drei";
import { useCadStore } from "../../store/store.js";
import {
  isAxisSection,
  sectionHandlePosition,
  sectionTFromOffset,
  type SectionAnalysis,
} from "../../viewport/section.js";
import { SELECT_ORANGE } from "../colors.js";
import { useGizmoPresence } from "./presence.js";
import type { BuiltPart } from "../../viewport/buildMesh.js";

const hex = (n: number): string => `#${n.toString(16).padStart(6, "0")}`;

function unitNormal(section: SectionAnalysis): [number, number, number] {
  if (isAxisSection(section)) {
    const n: [number, number, number] =
      section.axis === "x" ? [1, 0, 0] : section.axis === "y" ? [0, 1, 0] : [0, 0, 1];
    return section.flip ? ([-n[0], -n[1], -n[2]] as [number, number, number]) : n;
  }
  const n = section.normal;
  const len = Math.hypot(n[0], n[1], n[2]) || 1;
  const u: [number, number, number] = [n[0] / len, n[1] / len, n[2] / len];
  return section.flip ? ([-u[0], -u[1], -u[2]] as [number, number, number]) : u;
}

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
    const bbox = {
      min: [box.min.x, box.min.y, box.min.z] as [number, number, number],
      max: [box.max.x, box.max.y, box.max.z] as [number, number, number],
    };
    const pos = sectionHandlePosition(section, bbox);
    const n = unitNormal(section);
    // Quad spans the two axes orthogonal to the cut normal.
    const absN = n.map(Math.abs) as [number, number, number];
    const major = absN[0] >= absN[1] && absN[0] >= absN[2] ? "x" : absN[1] >= absN[2] ? "y" : "z";
    const span =
      major === "x"
        ? [size.y, size.z]
        : major === "y"
          ? [size.x, size.z]
          : [size.x, size.y];
    const q = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 0, 1),
      new THREE.Vector3(...n),
    );
    return {
      position: pos,
      quaternion: [q.x, q.y, q.z, q.w] as [number, number, number, number],
      w: Math.max(span[0]! * 1.15, 1e-3),
      h: Math.max(span[1]! * 1.15, 1e-3),
      bbox,
      normal: n,
    };
  }, [section, part]);

  useEffect(() => {
    if (handle.current && frame && !dragging.current) handle.current.position.set(...frame.position);
  }, [frame]);

  const onObjectChange = (): void => {
    if (!handle.current || !frame || !section) return;
    const p = handle.current.position;
    if (isAxisSection(section)) {
      const v = section.axis === "x" ? p.x : section.axis === "y" ? p.y : p.z;
      const min =
        section.axis === "x"
          ? frame.bbox.min[0]
          : section.axis === "y"
            ? frame.bbox.min[1]
            : frame.bbox.min[2];
      const max =
        section.axis === "x"
          ? frame.bbox.max[0]
          : section.axis === "y"
            ? frame.bbox.max[1]
            : frame.bbox.max[2];
      const t = sectionTFromOffset(min, max, v);
      useCadStore.getState().setSection({ ...section, t });
      return;
    }
    // Plane section: project handle motion onto the normal → new offset.
    const o = section.origin;
    const n = unitNormal({ ...section, flip: false }); // use unflipped normal for offset sense
    const dx = p.x - o[0];
    const dy = p.y - o[1];
    const dz = p.z - o[2];
    const offset = dx * n[0] + dy * n[1] + dz * n[2];
    useCadStore.getState().setSection({ ...section, offset });
  };

  if (!show || !frame || !section) return null;

  const showX = Math.abs(frame.normal[0]) > 0.5;
  const showY = Math.abs(frame.normal[1]) > 0.5;
  const showZ = Math.abs(frame.normal[2]) > 0.5;

  return (
    <>
      {/* The cut-plane quad. */}
      <mesh position={frame.position} quaternion={frame.quaternion} renderOrder={1}>
        <planeGeometry args={[frame.w, frame.h]} />
        <meshBasicMaterial
          color={SELECT_ORANGE}
          transparent
          opacity={0.18}
          side={THREE.DoubleSide}
          depthWrite={false}
        />
      </mesh>
      {/* Drag handle along the section normal (Fusion manipulator). */}
      <TransformControls
        mode="translate"
        showX={showX}
        showY={showY}
        showZ={showZ}
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
