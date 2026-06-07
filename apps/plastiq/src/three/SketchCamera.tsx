// "Normal to" sketch camera (S2 parity, in r3f). While a sketch is active the
// scene renders through an orthographic camera locked to the sketch plane + the
// overlay's 2D view, so the model behind the transparent overlay coincides with
// the 2D sketch. Reuses the pure, unit-tested sketchOrthoFrame; only the camera
// swap is r3f (drei OrthographicCamera makeDefault).

import { useEffect, useRef } from "react";
import type * as THREE from "three";
import { useThree, useFrame } from "@react-three/fiber";
import { OrthographicCamera } from "@react-three/drei";
import { useSketchStore } from "../sketch/sketchStore.js";
import { sketchOrthoFrame } from "../viewport/sketchCamera.js";
import type { DatumPlane } from "@plastiq/cad";

function SketchCameraRig({ frame }: { frame: DatumPlane }): React.JSX.Element {
  const camRef = useRef<THREE.OrthographicCamera>(null);
  const size = useThree((s) => s.size);

  // Re-derive the frustum + pose every frame from the live overlay view (pan/zoom)
  // and the current canvas size, so the 3D plane stays pixel-coincident with the 2D.
  useFrame(() => {
    const cam = camRef.current;
    if (!cam) return;
    const f = sketchOrthoFrame(frame, useSketchStore.getState().view, size.width, size.height);
    cam.position.set(f.position[0], f.position[1], f.position[2]);
    cam.up.set(f.up[0], f.up[1], f.up[2]);
    cam.left = f.left;
    cam.right = f.right;
    cam.top = f.top;
    cam.bottom = f.bottom;
    cam.near = f.near;
    cam.far = f.far;
    cam.lookAt(f.target[0], f.target[1], f.target[2]);
    cam.updateProjectionMatrix();
  });

  return <OrthographicCamera ref={camRef} makeDefault manual />;
}

export function SketchCamera({ frame }: { frame: DatumPlane | null }): React.JSX.Element | null {
  useEffect(() => {
    const g = globalThis as { __plastiqViewport?: { sketchCameraActive?: boolean } };
    (g.__plastiqViewport ??= {}).sketchCameraActive = frame != null;
    return () => {
      if (g.__plastiqViewport) g.__plastiqViewport.sketchCameraActive = false;
    };
  }, [frame]);
  if (!frame) return null;
  return <SketchCameraRig frame={frame} />;
}
