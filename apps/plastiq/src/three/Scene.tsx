// The r3f scene contents: lighting, ground grid, the built part, orbit controls —
// the exact stage the legacy SceneController set up (same light rig, same grid
// colours/size, same Z-up orbit target), expressed declaratively.

import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { useFrame, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { Part } from "./Part.js";
import { Picking } from "./Picking.js";
import { TransformGizmo } from "./gizmos/transform.gizmo.js";
import { OriginGizmo } from "./gizmos/origin.gizmo.js";
import { ObjectCenterGizmo } from "./gizmos/objectCenter.gizmo.js";
import { PlaneGizmo } from "./gizmos/plane.gizmo.js";
import { ConstructionGeometryGizmo } from "./gizmos/constructionGeometry.gizmo.js";
import { SectionAnalysisGizmo } from "./gizmos/sectionAnalysis.gizmo.js";
import {
  orientationChanged,
  projectionChanged,
  useCameraOrientation,
  type Quat,
} from "../viewport/cameraOrientation.js";
import { FeatureEditGizmo } from "./gizmos/featureEdit.gizmo.js";
import { OffsetGizmo } from "./gizmos/offset.gizmo.js";
import { RightClickDropdownGizmo } from "./gizmos/rightClickDropdown.gizmo.js";
import { SketchCamera } from "./SketchCamera.js";
import { Section } from "./Section.js";
import { Assembly, type InstanceBody } from "./Assembly.js";
import { localToWorld } from "../assembly/model.js";
import { VoxelSculpt } from "./VoxelSculpt.js";
import { MeshEditing } from "./MeshEditing.js";
import { SketchScene } from "../sketch/SketchScene.js";
import { setProjectableEdgePolylines } from "../sketch/projectableEdges.js";
import type { DatumPlane } from "@plastiq/cad";
import { GRID_CENTER, GRID_CELL } from "./colors.js";
import { buildPart, buildMeshBody, disposePart, type BuiltPart, type BuiltMeshBody } from "../viewport/buildMesh.js";
import { buildPointCloud, type BuiltPointCloud } from "../viewport/buildPointCloud.js";
import { applyPlacement, findPlacement, placementFromFeature } from "../viewport/placement.js";
import { useCadStore } from "../store/store.js";
import { useVoxelStore } from "../voxel/voxelStore.js";
import type { TransferMesh } from "../worker/protocol.js";
import type { MeshBody } from "../mesh/meshBody.js";
import type { PointCloudDoc } from "../store/types.js";

/**
 * The two accumulated mate endpoints, marked on the model (M4.2).
 *
 * Mate picks are stored INSTANCE-LOCAL, so each marker is placed through the
 * instance's live rendered pose (mate-solved / exploded / simulating) rather
 * than the document pose. Without this the only feedback for a pick is a
 * "Picking n/2" counter — the user cannot see WHAT they picked. The two picks
 * are coloured differently because a mate is directional (a → b).
 */
function MatePickGizmo({
  instances,
}: {
  instances: readonly InstanceBody[] | null;
}): React.JSX.Element | null {
  const mateMode = useCadStore((s) => s.mateMode);
  const matePicks = useCadStore((s) => s.matePicks);
  if (!mateMode || !instances || matePicks.length === 0) return null;
  return (
    <>
      {matePicks.map((p, i) => {
        const body = instances.find((b) => b.id === p.instanceId);
        if (!body) return null;
        const world = localToWorld(
          { position: body.position, orientation: body.orientation },
          p.point,
        );
        return (
          <mesh key={`${p.instanceId}-${i}`} position={world} renderOrder={999}>
            <sphereGeometry args={[0.003, 16, 16]} />
            {/* depthTest off so a marker on a far face stays visible. */}
            <meshBasicMaterial color={i === 0 ? 0x4ade80 : 0x60a5fa} depthTest={false} />
          </mesh>
        );
      })}
    </>
  );
}

/** Static ground slab visual for physics experiments (matches applyExperiment half-height 0.02). */
function ExperimentGround(): React.JSX.Element | null {
  const simulating = useCadStore((s) => s.simulating);
  const telemetry = useCadStore((s) => s.simTelemetry);
  const ground = telemetry?.bodies.find((b) => b.id === "__experiment_ground");
  if (!simulating || !ground) return null;
  // Hull half-height is 0.02 m; surface sits at COM.z + halfH.
  const halfH = 0.02;
  const surfaceZ = ground.z + halfH;
  return (
    <mesh
      position={[0, 0, surfaceZ - 0.002]}
      userData={{ experimentGround: true }}
      // Non-pickable decoration.
      raycast={() => null}
    >
      <boxGeometry args={[4, 4, 0.004]} />
      <meshStandardMaterial
        color="#3d5266"
        transparent
        opacity={0.55}
        metalness={0.05}
        roughness={0.85}
      />
    </mesh>
  );
}

interface ViewportGlobal {
  builtPart: BuiltPart | null;
  /** Number of rendered mesh-document bodies (SPEC-6 R4.2); 0 in the parametric path. */
  meshBodyCount?: number;
  /** The rendered dense point cloud (SPEC-13), or null. Published so fitToView frames it — a
   * photogrammetry cloud is not centred at the origin, so the default box would leave it off-screen. */
  builtPointCloud?: THREE.Points | null;
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
  /** The DOM element OrbitControls binds pointer events to (the r3f event
   * source — the canvas's parent, NOT the canvas itself). */
  domElement?: Element;
}

/**
 * Feed the view cube the live camera orientation (FR-12).
 *
 * The cube is a DOM overlay outside the Canvas, so it cannot read the camera —
 * it needs the orientation as React state. Sampling happens here, inside the
 * frame loop, because OrbitControls mutates the camera directly and emits no
 * React-visible change; a `useEffect` would never see an orbit.
 *
 * The store is written ONLY when the orientation actually moved, so a resting
 * camera costs one quaternion comparison per frame and no re-render at all.
 */
function CameraOrientationPublisher(): null {
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);
  const vp = useMemo(() => new THREE.Matrix4(), []);
  useFrame(() => {
    const st = useCameraOrientation.getState();
    const q = camera.quaternion;
    const next: Quat = [q.x, q.y, q.z, q.w];
    if (orientationChanged(st.quat, next)) st.setQuat(next);
    // The full transform, for anything that must sit ON world geometry (the
    // sketch overlay's glyphs and dimensions). Sampled here for the same reason
    // as the orientation: OrbitControls moves the camera outside React.
    vp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    const m = vp.elements as unknown as number[];
    if (
      projectionChanged(st.viewProjection, m) ||
      st.canvas.w !== size.width ||
      st.canvas.h !== size.height
    ) {
      st.setProjection([...m], size.width, size.height);
    }
  });
  return null;
}

export function Scene({
  mesh,
  meshBodies,
  pointCloud,
  sketchFrame,
  instances,
  onMeshBodiesChange,
}: {
  mesh: TransferMesh | null;
  meshBodies: MeshBody[] | null;
  pointCloud: PointCloudDoc | null;
  sketchFrame: DatumPlane | null;
  instances: InstanceBody[] | null;
  onMeshBodiesChange: (bodies: MeshBody[], persist?: boolean) => void;
}): React.JSX.Element {
  // §13.3 project-edges: publish edge polylines for the sketch "Project edges"
  // action without threading mesh through the sketch store.
  useEffect(() => {
    setProjectableEdgePolylines(mesh ? mesh.edges.map((e) => e.positions) : null);
    return () => setProjectableEdgePolylines(null);
  }, [mesh]);

  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as OrbitLike | null;
  // The open voxel sculpt (ADR-0010), or null. Non-null swaps the scene to the
  // voxel branch below, exactly as builtBodies does for a mesh document.
  const voxelDoc = useVoxelStore((s) => s.doc);
  /** Mate authoring armed (M4.2) — gates the instance pick handler below. */
  const mateMode = useCadStore((s) => s.mateMode);
  const addMatePick = useCadStore((s) => s.addMatePick);

  // three-stdlib's OrbitControls calls `domElement.releasePointerCapture(id)` on
  // pointerup even though it never calls setPointerCapture — so for any pointerup
  // with no live capture (the common case here) the Pointer Events spec makes that
  // throw `NotFoundError`. Guard the EXACT element OrbitControls uses (its
  // `domElement`, the r3f-connected parent — not gl.domElement) so it only releases
  // a capture that actually exists. Restored on teardown.
  useEffect(() => {
    const el = controls?.domElement;
    if (!el) return;
    const native = el.releasePointerCapture.bind(el);
    el.releasePointerCapture = (id: number): void => {
      if (el.hasPointerCapture(id)) native(id);
    };
    return () => {
      el.releasePointerCapture = native;
    };
  }, [controls]);

  // A mesh document renders its triangle-soup bodies directly (SPEC-6 R4.2), bypassing
  // the OCCT B-rep path. Built once per body set; disposed + count published on swap.
  const builtBodies = useMemo<BuiltMeshBody[] | null>(
    () => (meshBodies && meshBodies.length > 0 ? meshBodies.map(buildMeshBody) : null),
    [meshBodies],
  );
  useEffect(() => {
    const vp = ((globalThis as { __plastiqViewport?: ViewportGlobal }).__plastiqViewport ??= {
      builtPart: null,
    });
    vp.meshBodyCount = builtBodies?.length ?? 0;
    return () => {
      if (builtBodies) for (const b of builtBodies) b.dispose();
      const v = (globalThis as { __plastiqViewport?: ViewportGlobal }).__plastiqViewport;
      if (v) v.meshBodyCount = 0;
    };
  }, [builtBodies]);

  // A dense point-cloud document (SPEC-13) renders as one THREE.Points cloud, bypassing both the
  // OCCT B-rep path and the mesh-body path. Built once per doc; published so fitToView frames it,
  // and disposed on swap.
  const builtCloud = useMemo<BuiltPointCloud | null>(
    () => (pointCloud ? buildPointCloud(pointCloud) : null),
    [pointCloud],
  );
  useEffect(() => {
    const vp = ((globalThis as { __plastiqViewport?: ViewportGlobal }).__plastiqViewport ??= {
      builtPart: null,
    });
    vp.builtPointCloud = builtCloud?.points ?? null;
    // The auto-fit is triggered from the fitToView effect below (which OWNS vp.fitToView and lists
    // builtCloud in its deps) — doing it here would no-op on first mount, since that effect runs
    // later and vp.fitToView is still undefined when this one fires (e.g. a recovery-restored cloud).
    return () => {
      builtCloud?.dispose();
      const v = (globalThis as { __plastiqViewport?: ViewportGlobal }).__plastiqViewport;
      if (v) v.builtPointCloud = null;
    };
  }, [builtCloud]);

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
      if (vp.builtPointCloud) box.expandByObject(vp.builtPointCloud);
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
    // A point cloud is not centred at the origin, so frame it once it (and fitToView) exist — on
    // first mount AND whenever the open cloud changes (builtCloud is in the deps). This is the sole
    // auto-fit call, so it fires correctly even for a crash-recovered cloud open at mount.
    if (builtCloud) vp.fitToView();
    return () => {
      delete vp.fitToView;
      delete vp.setView;
    };
  }, [camera, controls, builtCloud]);

  // A voxel sculpt (ADR-0010): the standard stage, the VoxelSculpt component (surface
  // mesh + sculpt tools + hover preview), and NONE of the B-rep editor surfaces —
  // mirroring the mesh-document branch below (FR-18). LEFT is the sculpt button, so
  // orbit moves to RIGHT (rotate) + MIDDLE (pan); there is no context menu here.
  if (voxelDoc) {
    return (
      <>
        <ambientLight intensity={0.55} />
        <directionalLight intensity={1.1} position={[0.3, -0.4, 0.6]} />
        <directionalLight intensity={0.35} color={0x88aaff} position={[-0.3, 0.3, 0.2]} />
        <gridHelper args={[0.4, 40, GRID_CENTER, GRID_CELL]} rotation={[Math.PI / 2, 0, 0]} />
        <VoxelSculpt />
        <OrbitControls
          makeDefault
          enableDamping
          target={[0, 0, 0.02]}
          mouseButtons={{ RIGHT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN }}
        />
      </>
    );
  }

  // A mesh document is non-B-rep triangle geometry (decision 20): B-rep-only tools
  // stay off, but raw mesh vertices and segments are selectable/editable directly.
  if (builtBodies) {
    return (
      <>
        <ambientLight intensity={0.55} />
        <directionalLight intensity={1.1} position={[0.3, -0.4, 0.6]} />
        <directionalLight intensity={0.35} color={0x88aaff} position={[-0.3, 0.3, 0.2]} />
        <gridHelper args={[0.4, 40, GRID_CENTER, GRID_CELL]} rotation={[Math.PI / 2, 0, 0]} />
        <group name="mesh-document">
          {builtBodies.map((b, i) => (
            <group key={i} name={`mesh-body-${i}`}>
              <primitive object={b.mesh} />
              {b.edges.map((edge, j) => (
                <primitive key={j} object={edge} />
              ))}
              <primitive object={b.vertexPoints} />
            </group>
          ))}
        </group>
        <MeshEditing bodies={meshBodies ?? []} builtBodies={builtBodies} onBodiesChange={onMeshBodiesChange} />
        {/* Right-click here surfaces the mesh→CAD actions (Reconstruct / Fit NURBS). The menu is
            doc-mode-filtered (contextOptions.isActionVisible) so it shows ONLY those, not the
            parametric create/sketch actions. No B-rep part, so pick-under-cursor is null. */}
        <RightClickDropdownGizmo part={null} />
        <OrbitControls
          makeDefault
          enableDamping
          target={[0, 0, 0.02]}
          mouseButtons={{ LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN }}
        />
      </>
    );
  }

  // A dense point cloud (SPEC-13): shown as a THREE.Points cloud on the same stage. Like the mesh
  // and voxel branches, none of the B-rep editor surfaces apply (FR-18); it is a viewing/hand-off
  // mode (cloud→mesh via capture, or completion) driven from the context menu / ribbon.
  if (builtCloud) {
    return (
      <>
        <ambientLight intensity={0.55} />
        <directionalLight intensity={1.1} position={[0.3, -0.4, 0.6]} />
        <directionalLight intensity={0.35} color={0x88aaff} position={[-0.3, 0.3, 0.2]} />
        <gridHelper args={[0.4, 40, GRID_CENTER, GRID_CELL]} rotation={[Math.PI / 2, 0, 0]} />
        <group name="point-cloud-document">
          <primitive object={builtCloud.points} />
        </group>
        {/* Right-click surfaces the cloud→mesh actions (Point cloud → mesh / Complete partial scan),
            doc-mode-filtered to just those. */}
        <RightClickDropdownGizmo part={null} />
        <OrbitControls
          makeDefault
          enableDamping
          target={[0, 0, 0.02]}
          mouseButtons={{ LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN }}
        />
      </>
    );
  }

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
      {/* Mate authoring (M4.2): the pick handler is armed ONLY while mateMode is
          on, so instances stay inert (and orbiting unaffected) the rest of the
          time. This is the input path AssemblyTree's "Picking n/2" counter and
          every mate menu item depend on. */}
      <Assembly
        mesh={mesh}
        instances={instances}
        {...(mateMode ? { onMatePick: addMatePick } : {})}
      />
      {/* Keeps the DOM view cube pointing where the camera points (FR-12). */}
      <CameraOrientationPublisher />
      <MatePickGizmo instances={instances} />
      <ExperimentGround />
      <Picking part={part} />
      <Section part={part} />
      <OriginGizmo />
      <PlaneGizmo />
      <ConstructionGeometryGizmo />
      <ObjectCenterGizmo />
      <SectionAnalysisGizmo part={part} />
      <FeatureEditGizmo part={part} />
      <OffsetGizmo />
      <TransformGizmo part={part} />
      {/* Right-click context menu: reads the same part for pick-under-cursor;
          renders a world-anchored DOM dropdown of the actions for the target. */}
      <RightClickDropdownGizmo part={part} />
      {/* In-place sketch (ADR-0014): 3D curves + plane pick on the resolved frame.
          Orbit stays enabled so the user can look around while drawing on the plane. */}
      <SketchScene frame={sketchFrame} />
      {/* Optional Look-At ortho (still available); free orbit is the default. */}
      <SketchCamera frame={null} />
      {/* Left = orbit when not sketch-tooling; middle = pan, wheel = zoom.
          While sketching, left-drag on the sketch plane is consumed by SketchPlanePick;
          empty space still orbits. RIGHT stays free for the context menu. */}
      <OrbitControls
        makeDefault
        enableDamping
        enabled
        target={[0, 0, 0.02]}
        mouseButtons={{ LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN }}
      />
    </>
  );
}
