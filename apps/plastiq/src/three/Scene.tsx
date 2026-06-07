// The r3f scene contents: lighting, ground grid, the built part, orbit controls —
// the exact stage the legacy SceneController set up (same light rig, same grid
// colours/size, same Z-up orbit target), expressed declaratively.

import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { Part } from "./Part.js";
import { Picking } from "./Picking.js";
import { TransformGizmo } from "./gizmos/transform.gizmo.js";
import { ViewCubeGizmo } from "./gizmos/viewCube.gizmo.js";
import { OriginGizmo } from "./gizmos/origin.gizmo.js";
import { ObjectCenterGizmo } from "./gizmos/objectCenter.gizmo.js";
import { PlaneGizmo } from "./gizmos/plane.gizmo.js";
import { ConstructionGeometryGizmo } from "./gizmos/constructionGeometry.gizmo.js";
import { SectionAnalysisGizmo } from "./gizmos/sectionAnalysis.gizmo.js";
import { OffsetGizmo } from "./gizmos/offset.gizmo.js";
import { SketchCamera } from "./SketchCamera.js";
import { Section } from "./Section.js";
import { Assembly, type InstanceBody } from "./Assembly.js";
import type { DatumPlane } from "@plastiq/cad";
import { GRID_CENTER, GRID_CELL } from "./colors.js";
import { buildPart, disposePart, type BuiltPart } from "../viewport/buildMesh.js";
import { applyPlacement, findPlacement, placementFromFeature } from "../viewport/placement.js";
import { useCadStore } from "../store/store.js";
import type { TransferMesh } from "../worker/protocol.js";

interface ViewportGlobal {
  builtPart: BuiltPart | null;
  fitToView?: () => void;
  /** Orient the camera to look along `dir` (target → camera), keeping framing. */
  setView?: (dir: readonly [number, number, number]) => void;
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

export function Scene({
  mesh,
  sketchFrame,
  instances,
}: {
  mesh: TransferMesh | null;
  sketchFrame: DatumPlane | null;
  instances: InstanceBody[] | null;
}): React.JSX.Element {
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

  // Position the part group from the document's placement feature (FR-11), and
  // keep it in sync as that feature changes (gizmo write-back / undo / panel).
  useEffect(() => {
    if (!part) return;
    const apply = (): void =>
      applyPlacement(part.group, placementFromFeature(findPlacement(useCadStore.getState().features)));
    apply();
    return useCadStore.subscribe((s, prev) => {
      if (s.features !== prev.features) apply();
    });
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
    // Orient to a standard-view direction (named view buttons + FR-12), keeping
    // the current target + framing distance — the legacy setViewDirection.
    vp.setView = (dir): void => {
      const target = controls?.target ?? new THREE.Vector3(0, 0, 0.02);
      const radius = camera.position.distanceTo(target) || 0.2;
      const d = new THREE.Vector3(dir[0], dir[1], dir[2]).normalize();
      camera.position.copy(target.clone().addScaledVector(d, radius));
      if (controls) controls.update();
      camera.lookAt(target);
    };
    return () => {
      delete vp.fitToView;
      delete vp.setView;
    };
  }, [camera, controls]);

  return (
    <>
      <ambientLight intensity={0.55} />
      <directionalLight intensity={1.1} position={[0.3, -0.4, 0.6]} />
      <directionalLight intensity={0.35} color={0x88aaff} position={[-0.3, 0.3, 0.2]} />
      {/* GridHelper is XZ by default → rotate to the XY ground plane (Z-up). */}
      <gridHelper args={[0.4, 40, GRID_CENTER, GRID_CELL]} rotation={[Math.PI / 2, 0, 0]} />
      {/* Base part shows for a bare single body; the assembly layer takes over
          when instances exist (M4) or a simulation is running (M6). */}
      {instances == null && <Part part={part} />}
      <Assembly mesh={mesh} instances={instances} />
      <Picking part={part} />
      <Section part={part} />
      <OriginGizmo />
      <PlaneGizmo />
      <ConstructionGeometryGizmo />
      <ObjectCenterGizmo />
      <SectionAnalysisGizmo part={part} />
      <OffsetGizmo />
      <TransformGizmo part={part} />
      <ViewCubeGizmo />
      {/* While sketching, render through the plane-locked ortho camera and lock
          orbit (the 2D overlay owns interaction). */}
      <SketchCamera frame={sketchFrame} />
      <OrbitControls makeDefault enableDamping enabled={sketchFrame == null} target={[0, 0, 0.02]} />
    </>
  );
}
