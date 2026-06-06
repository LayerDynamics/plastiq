// The r3f scene contents: lighting, ground grid, the built part, orbit controls —
// the exact stage the legacy SceneController set up (same light rig, same grid
// colours/size, same Z-up orbit target), expressed declaratively.

import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { Part } from "./Part.js";
import { Picking } from "./Picking.js";
import { GRID_CENTER, GRID_CELL } from "./colors.js";
import { buildPart, disposePart, type BuiltPart } from "../viewport/buildMesh.js";
import type { TransferMesh } from "../worker/protocol.js";

interface ViewportGlobal {
  builtPart: BuiltPart | null;
  fitToView?: () => void;
  gpuPickFace?: (ndc: { x: number; y: number }) => number | null;
}

/** Publish the built part on the global the E2E seams + tools read. */
function publishBuiltPart(part: BuiltPart | null): void {
  const vp = ((globalThis as { __plastiqViewport?: ViewportGlobal }).__plastiqViewport ??= {
    builtPart: null,
  });
  vp.builtPart = part;
}

/** Minimal shape of the drei OrbitControls instance we touch. */
interface OrbitLike {
  target: THREE.Vector3;
  update(): void;
}

export function Scene({ mesh }: { mesh: TransferMesh | null }): React.JSX.Element {
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as OrbitLike | null;

  // Build the renderable part once per tessellation; shared by render + picking +
  // highlight (same object), and published for the test seams. Disposed on swap.
  const part = useMemo(() => (mesh ? buildPart(mesh) : null), [mesh]);
  useEffect(() => {
    publishBuiltPart(part);
    return () => {
      if (part) disposePart(part);
      publishBuiltPart(null);
    };
  }, [part]);

  // Frame the part (or the grid) so it fills the view — the legacy fitToView,
  // set instantly (deterministic for tests). Published on the viewport global the
  // E2E seams call.
  useEffect(() => {
    const vp = ((globalThis as { __plastiqViewport?: ViewportGlobal }).__plastiqViewport ??= {
      builtPart: null,
    });
    vp.fitToView = (): void => {
      const part = vp.builtPart;
      const box = new THREE.Box3();
      if (part) box.setFromObject(part.group);
      if (box.isEmpty())
        box.setFromCenterAndSize(new THREE.Vector3(), new THREE.Vector3(0.1, 0.1, 0.1));
      const center = box.getCenter(new THREE.Vector3());
      const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 1e-3);
      const persp = camera as THREE.PerspectiveCamera;
      const dist = (radius * 1.6) / Math.sin((persp.fov * Math.PI) / 360);
      const dir = camera.position
        .clone()
        .sub(controls?.target ?? center)
        .normalize();
      if (dir.lengthSq() < 1e-9) dir.set(0.6, 0.5, 0.8).normalize();
      camera.position.copy(center.clone().addScaledVector(dir, dist));
      if (controls) {
        controls.target.copy(center);
        controls.update();
      }
      camera.lookAt(center);
    };
    return () => {
      delete vp.fitToView;
    };
  }, [camera, controls]);

  return (
    <>
      <ambientLight intensity={0.55} />
      <directionalLight intensity={1.1} position={[0.3, -0.4, 0.6]} />
      <directionalLight intensity={0.35} color={0x88aaff} position={[-0.3, 0.3, 0.2]} />
      {/* GridHelper is XZ by default → rotate to the XY ground plane (Z-up). */}
      <gridHelper args={[0.4, 40, GRID_CENTER, GRID_CELL]} rotation={[Math.PI / 2, 0, 0]} />
      <Part part={part} />
      <Picking part={part} />
      <OrbitControls makeDefault enableDamping target={[0, 0, 0.02]} />
    </>
  );
}
