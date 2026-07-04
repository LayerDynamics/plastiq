// Plane gizmo: a translucent quad + outline on the ACTIVE sketch's datum plane,
// so you can see the plane you're drawing on in 3D (S1–S3). Oriented by the
// resolved DatumPlane frame (origin/normal/xAxis) and offset. Shown while
// sketching on a datum; face-derived sketch planes (model.face) are a follow-up
// (their frame is resolved in the worker, not the store).

import { useMemo } from "react";
import * as THREE from "three";
import { useSketchStore } from "../../sketch/sketchStore.js";
import { resolveDatumPlane } from "../../worker/sketchPlane.js";
import { ACCENT_BLUE } from "../colors.js";
import { useGizmoPresence } from "./presence.js";

const SIZE = 0.12; // 120 mm — comfortably larger than a centimetre-scale part

// Source quad for the outline's <edgesGeometry>, hoisted to a module singleton
// (it's a fixed size). Inline `new THREE.PlaneGeometry(...)` in the JSX changed
// the args identity every render, making r3f rebuild the EdgesGeometry each
// render from a fresh, never-disposed PlaneGeometry. With a stable arg, r3f
// builds the EdgesGeometry once per mount and disposes it on unmount; this one
// small shared source quad intentionally lives for the app's lifetime (same as
// the other gizmos' constant-args geometries).
const OUTLINE_SOURCE = new THREE.PlaneGeometry(SIZE, SIZE);

export function PlaneGizmo(): React.JSX.Element | null {
  const active = useSketchStore((s) => s.active);
  const plane = useSketchStore((s) => s.model.plane);
  const offset = useSketchStore((s) => s.model.offset ?? 0);
  const onFace = useSketchStore((s) => s.model.face != null);
  const show = active && !onFace;

  const frame = useMemo(() => {
    const dp = resolveDatumPlane(plane, offset);
    const x = new THREE.Vector3(dp.xAxis[0], dp.xAxis[1], dp.xAxis[2]);
    const z = new THREE.Vector3(dp.normal[0], dp.normal[1], dp.normal[2]);
    const y = new THREE.Vector3().crossVectors(z, x);
    const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
    return {
      position: [dp.origin[0], dp.origin[1], dp.origin[2]] as [number, number, number],
      quaternion: [q.x, q.y, q.z, q.w] as [number, number, number, number],
    };
  }, [plane, offset]);

  useGizmoPresence("plane", show);
  if (!show) return null;
  return (
    <group position={frame.position} quaternion={frame.quaternion}>
      <mesh renderOrder={1}>
        <planeGeometry args={[SIZE, SIZE]} />
        <meshBasicMaterial
          color={ACCENT_BLUE}
          transparent
          opacity={0.1}
          side={THREE.DoubleSide}
          depthWrite={false}
        />
      </mesh>
      {/* Plane outline. */}
      <lineSegments>
        <edgesGeometry args={[OUTLINE_SOURCE]} />
        <lineBasicMaterial color={ACCENT_BLUE} transparent opacity={0.5} />
      </lineSegments>
    </group>
  );
}
