// Plane gizmo: a translucent quad + outline on the ACTIVE sketch's plane, so you
// can see the plane you're drawing on in 3D (S1–S3). Oriented by the resolved
// DatumPlane frame (origin/normal/xAxis) and offset.
//
// Works for BOTH plane kinds. A base datum resolves synchronously here; a
// FACE-derived plane needs the solid, so the viewport resolves it through the
// geometry worker and publishes it as `sketchStore.resolvedFrame`, which this
// reads. That matters now that a sketch started with no explicit offset lands on
// the model's outer face by default (§13.8 P0) — the common case is a face
// plane, and hiding the gizmo for it would leave the most common sketch with no
// visible plane at all.

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
  const resolved = useSketchStore((s) => s.resolvedFrame);
  // A face plane can only be drawn once the worker has resolved it; until then
  // there is no honest frame to draw, so the quad waits rather than flashing at
  // the wrong place.
  const show = active && (!onFace || resolved != null);

  const frame = useMemo(() => {
    const dp = onFace && resolved ? resolved : resolveDatumPlane(plane, offset);
    const x = new THREE.Vector3(dp.xAxis[0], dp.xAxis[1], dp.xAxis[2]);
    const z = new THREE.Vector3(dp.normal[0], dp.normal[1], dp.normal[2]);
    const y = new THREE.Vector3().crossVectors(z, x);
    const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
    return {
      position: [dp.origin[0], dp.origin[1], dp.origin[2]] as [number, number, number],
      quaternion: [q.x, q.y, q.z, q.w] as [number, number, number, number],
    };
  }, [plane, offset, onFace, resolved]);

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
