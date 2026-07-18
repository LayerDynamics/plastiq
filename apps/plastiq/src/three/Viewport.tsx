// React mount point for the r3f viewport (R0 of the SceneController→r3f rewrite).
// Owns the geometry worker, runs the rebuild loop, and feeds the freshly tessellated
// TransferMesh to the declarative <Viewport3D> scene. The worker bridge, sketch
// solve, and Zustand stores are unchanged — only the RENDERER moved to r3f.
//
// Capabilities still being ported in later stages (picking R1, gizmos R2/R3,
// sketch camera R4, section R5, assembly/sim R6) are not wired here yet.

import { useCallback, useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { useCadStore } from "../store/store.js";
import { PLACEMENT_TYPE, type CadDocument, type MeshDoc, type PointCloudDoc } from "../store/types.js";
import { GeometryClient, type BuildOutcome, type ExportResult } from "../worker/bridge.js";
import { useProjectsStore } from "../persistence/projectsStore.js";
import { importGltf } from "../mesh/importGltf.js";
import { meshBodiesToGlbBase64 } from "../mesh/glb.js";
import { deserializeMeshBody, serializeMeshBody } from "../mesh/meshBody.js";
import type { MeshBody } from "../mesh/meshBody.js";
import { Viewport3D } from "./Viewport3D.js";
import { resolveDatumPlane } from "../worker/sketchPlane.js";
import { createCoalescer } from "./coalesce.js";
import { useSketchStore } from "../sketch/sketchStore.js";
import { explodeInstances } from "../viewport/explode.js";
import { placementPoseOf } from "../viewport/placement.js";
import { ViewCubeOverlay } from "../viewport/ViewCube.js";
import { LoadingOverlay } from "./LoadingOverlay.js";
import { findClashes, type InstanceBox } from "../viewport/interference.js";
import { Simulator } from "../sim/simulator.js";
import { applyExperiment, buildTelemetry } from "../sim/experiments.js";
import { applyJointDrives, type AssemblyModel, type Quat, type Vec3 } from "../assembly/model.js";
import { activeBackend, type BackendName, type SimManifest } from "@plastiq/sim";
import type { InstanceBody } from "./Assembly.js";
import { describeOcctError, type DatumPlane } from "@plastiq/cad";
import type { TransferMesh } from "../worker/protocol.js";

/** Render bodies for the document assembly: mate-solved poses + joint drives,
 * then the exploded-view spread. Empty (null) for a bare single part. */
function explodedInstances(s: {
  assembly: AssemblyModel;
  jointDrive: Record<string, number>;
  explodeFactor: number;
}): InstanceBody[] | null {
  if (s.assembly.instances.length === 0) return null;
  const driven = applyJointDrives(s.assembly.instances, s.assembly.joints, s.jointDrive);
  const list = driven.map((i) => ({
    id: i.id,
    position: i.pose.position,
    orientation: i.pose.orientation,
  }));
  return explodeInstances(list, s.explodeFactor);
}

/** The bodies a simulation drives: the assembly instances, or one body at the
 * document's placement pose for a bare part — matching the worker's synthesized
 * body0 (§2.11.1, via the SAME placementPoseOf), so the sim render seed starts
 * the part exactly where the viewport shows it. */
function simBodies(state: {
  assembly: AssemblyModel;
  features: CadDocument["features"];
}): InstanceBody[] {
  if (state.assembly.instances.length > 0) {
    return state.assembly.instances.map((i) => ({
      id: i.id,
      position: i.pose.position,
      orientation: i.pose.orientation,
    }));
  }
  const pose = placementPoseOf(state.features);
  return [{ id: "body0", position: pose.position, orientation: pose.orientation }];
}

/** Local axis-aligned bounds of the part from its tessellation vertices. */
function localBounds(mesh: TransferMesh): { min: Vec3; max: Vec3 } {
  const v = mesh.vertices;
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < v.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      const c = v[i + a]!;
      if (c < min[a]!) min[a] = c;
      if (c > max[a]!) max[a] = c;
    }
  }
  return { min, max };
}

/** World AABB of the local box transformed by a body pose (rotate the 8 corners). */
function worldBox(id: string, local: { min: Vec3; max: Vec3 }, body: InstanceBody): InstanceBox {
  const q = new THREE.Quaternion(
    body.orientation[0],
    body.orientation[1],
    body.orientation[2],
    body.orientation[3],
  );
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  const corner = new THREE.Vector3();
  for (let cx = 0; cx < 2; cx++)
    for (let cy = 0; cy < 2; cy++)
      for (let cz = 0; cz < 2; cz++) {
        corner
          .set(
            cx ? local.max[0] : local.min[0],
            cy ? local.max[1] : local.min[1],
            cz ? local.max[2] : local.min[2],
          )
          .applyQuaternion(q);
        const w: Vec3 = [corner.x + body.position[0], corner.y + body.position[1], corner.z + body.position[2]];
        for (let a = 0; a < 3; a++) {
          if (w[a]! < min[a]!) min[a] = w[a]!;
          if (w[a]! > max[a]!) max[a] = w[a]!;
        }
      }
  return { id, min, max };
}

/** Features that actually build, honouring the rollback point (FR-25). */
function buildFeatures(s: {
  features: CadDocument["features"];
  rollbackIndex: number | null;
}): CadDocument["features"] {
  return s.rollbackIndex == null ? s.features : s.features.slice(0, s.rollbackIndex);
}

/** Signature of only the geometry-affecting features (placement excluded), so a
 * pure pose change doesn't trigger an OCCT rebuild but a rollback move does. */
function geometrySignature(s: {
  features: CadDocument["features"];
  rollbackIndex: number | null;
}): string {
  return JSON.stringify(buildFeatures(s).filter((f) => f.type !== PLACEMENT_TYPE));
}

/** Decode a base64 GLB to bytes (the MeshDoc stores the model inline; SPEC-6 R4.2). */
function decodeBase64(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

export function Viewport(): React.JSX.Element {
  const [mesh, setMesh] = useState<TransferMesh | null>(null);
  // The generated mesh document's bodies (SPEC-6 R4.2), re-derived from its inline GLB
  // via importGltf. Non-null ⇒ the viewport renders a mesh document (B-rep path off).
  const [meshBodies, setMeshBodies] = useState<MeshBody[] | null>(null);
  // The open dense point-cloud document (SPEC-13), rendered as a THREE.Points cloud on the same
  // canvas. Non-null ⇒ the viewport is in cloud mode (B-rep + mesh paths off).
  const [pointCloud, setPointCloud] = useState<PointCloudDoc | null>(null);
  // The resolved plane the active sketch is "normal to" (datum or, via the worker,
  // a model face) — drives the ortho sketch camera. null when not sketching.
  const [sketchFrame, setSketchFrame] = useState<DatumPlane | null>(null);
  // The bodies the assembly layer renders: doc poses + explode, or live sim poses.
  // null = a bare single part (the base Part shows instead).
  const [instances, setInstances] = useState<InstanceBody[] | null>(null);
  // Latest tessellation, for the interference local bounds (state closure is stale).
  const meshRef = useRef<TransferMesh | null>(null);
  const setStatus = useCadStore((s) => s.setStatus);
  const measuring = useCadStore((s) => s.measuring);
  const measureResult = useCadStore((s) => s.measureResult);
  const onMeshBodiesChange = useCallback((bodies: MeshBody[], persist = false): void => {
    setMeshBodies(bodies);
    if (!persist) return;
    const projects = useProjectsStore.getState();
    const doc = projects.activeMeshDoc;
    if (!doc) return;
    useProjectsStore.setState({
      activeMeshDoc: {
        ...doc,
        glb: meshBodiesToGlbBase64(bodies),
        editedBodies: bodies.map(serializeMeshBody),
      },
      status: "mesh edited",
    });
  }, []);

  useEffect(() => {
    const client = new GeometryClient();

    // Interchange export (M6.2/M6.3) + assembly lowering (M4.5) seams.
    (globalThis as { __plastiqLower?: () => Promise<unknown> }).__plastiqLower = () =>
      client.lower(useCadStore.getState().toDocument());
    (
      globalThis as { __plastiqExport?: (f: "gltf" | "step" | "iges") => Promise<ExportResult> }
    ).__plastiqExport = (format) =>
      client.exportFile(useCadStore.getState().toDocument(), format);

    // AI generation seam (SPEC-6 R2.4): off-thread build of an arbitrary document on
    // the ONE geometry worker — the build_part probe + inspect_geometry both use this
    // (no second OCCT worker), and the deterministic AI E2E drives it directly.
    (
      globalThis as { __plastiqBuild?: (doc: CadDocument) => Promise<BuildOutcome> }
    ).__plastiqBuild = (doc) => client.build(doc);

    // Projects (M5): start the store (loads SQLite, arms crash-recovery autosave,
    // FR-40) and let Save capture the viewport canvas as the thumbnail (M5.3).
    const projects = useProjectsStore.getState();
    projects.setThumbnailProvider(() => {
      const c = document.querySelector("#viewport-root canvas") as HTMLCanvasElement | null;
      return c ? c.toDataURL("image/png") : null;
    });
    void projects.init();

    let cancelled = false;
    let lastSig: string | null = null;

    // Collapse a burst of store changes (e.g. a gizmo drag emitting a tick per
    // frame) into one in-flight rebuild plus a single trailing rebuild on the
    // latest state. The building/pending machine lives in createCoalescer, which
    // is unit-tested in coalesce.test.ts (the trailing re-run is suppressed once
    // `cancelled` flips on unmount).
    const coalescer = createCoalescer(async (): Promise<void> => {
      setStatus("building");
      const state = useCadStore.getState();
      const full = state.toDocument();
      const doc: CadDocument = { features: buildFeatures(state), params: full.params };
      lastSig = geometrySignature(state);
      try {
        // Per-feature failures are isolated (FR-24): `mesh` is whatever geometry
        // survived and `statuses` says which features failed and why.
        const { mesh: built, statuses } = await client.build(doc);
        if (!cancelled) {
          setMesh(built);
          meshRef.current = built;
          const store = useCadStore.getState();
          const errors: Record<string, string> = {};
          // A build-level error carries no feature id (e.g. tessellation failed
          // AFTER every feature built). It has no tree row to badge, so it must
          // be surfaced in the status line — dropping it would report "empty",
          // which is precisely the silent-failure this section exists to kill.
          const buildErrors: string[] = [];
          for (const s of statuses) {
            if (s.status !== "error") continue;
            if (s.featureId) errors[s.featureId] = s.message ?? "failed";
            else buildErrors.push(s.message ?? "the build failed");
          }
          store.setFeatureErrors(errors);
          const failed = Object.keys(errors);
          setStatus(
            buildErrors.length > 0
              ? `rebuild failed: ${buildErrors[0]!}`
              : failed.length > 0
                ? `${failed.length} feature${failed.length === 1 ? "" : "s"} failed: ${errors[failed[0]!]!}`
                : built
                  ? "ready"
                  : "empty",
          );
          if (built) {
            // Capture the positional disambiguators (face centroid / edge midpoint)
            // alongside the normal signatures so a selection re-resolves to the
            // RIGHT same-normal face/edge after a parametric rebuild (FR-16).
            const faces: Record<
              number,
              { normal: [number, number, number]; centroid: [number, number, number] }
            > = {};
            for (const g of built.faceGroups) faces[g.faceId] = { normal: g.normal, centroid: g.centroid };
            const edges: Record<
              number,
              {
                faceNormals: (typeof built.edges)[number]["faceNormals"];
                midpoint: [number, number, number];
              }
            > = {};
            for (const e of built.edges) edges[e.edgeId] = { faceNormals: e.faceNormals, midpoint: e.midpoint };
            store.setSelectionRefs({ faces, edges });
          } else {
            store.setSelectionRefs({ faces: {}, edges: {} });
          }
          store.setMassProps(
            built && built.volume != null && built.com
              ? { volume: built.volume, com: built.com }
              : null,
          );
        }
      } catch (err) {
        // Reaching here means the whole RPC failed (worker died, timed out, OCCT
        // could not init) — per-FEATURE failures no longer land here, they come
        // back as `statuses` above.
        if (!cancelled) {
          // describeOcctError, not `(err as Error).message`: a raw OCCT
          // Standard_Failure is a pointer with no `.message`, which is what
          // rendered "rebuild failed: undefined".
          setStatus(`rebuild failed: ${describeOcctError(err)}`);
          // Drop the stale mesh: leaving the previous geometry on screen after a
          // failed rebuild is what made a broken op look like "nothing happened".
          setMesh(null);
          meshRef.current = null;
          const store = useCadStore.getState();
          store.setFeatureErrors({});
          store.setSelectionRefs({ faces: {}, edges: {} });
          store.setMassProps(null);
        }
      }
    }, () => cancelled);

    coalescer.schedule(); // initial build of whatever is already in the store
    const unsub = useCadStore.subscribe((state, prev) => {
      if (
        state.features === prev.features &&
        state.params === prev.params &&
        state.rollbackIndex === prev.rollbackIndex
      ) {
        return;
      }
      if (geometrySignature(state) === lastSig) return; // pure placement change
      coalescer.schedule();
    });

    // Resolve the active sketch's "normal to" plane for the ortho camera (S2/S3):
    // a base datum synchronously, or a model face via the worker (shifted by the
    // offset along the face normal). Stale async results are dropped.
    const resolveSketchFrame = (s: ReturnType<typeof useSketchStore.getState>): void => {
      if (!s.active) {
        setSketchFrame(null);
        return;
      }
      const face = s.model.face;
      if (face) {
        const off = s.model.offset ?? 0;
        void client.facePlane(useCadStore.getState().toDocument(), face).then((fr) => {
          const cur = useSketchStore.getState();
          if (cancelled || !cur.active || cur.model.face !== face) return;
          setSketchFrame(
            fr
              ? {
                  origin: [
                    fr.origin[0] + fr.normal[0] * off,
                    fr.origin[1] + fr.normal[1] * off,
                    fr.origin[2] + fr.normal[2] * off,
                  ],
                  normal: fr.normal,
                  xAxis: fr.xAxis,
                }
              : null,
          );
        });
        return;
      }
      setSketchFrame(resolveDatumPlane(s.model.plane, s.model.offset ?? 0));
    };
    resolveSketchFrame(useSketchStore.getState());
    const unsubSketch = useSketchStore.subscribe((s, prev) => {
      if (s.active !== prev.active || s.model !== prev.model) resolveSketchFrame(s);
    });

    // --- Assembly instances + explode + interference + simulation (M4/M6) -----
    let simulator: Simulator | null = null;
    let simBackend: BackendName | undefined;
    let raf = 0;
    let simTicks = 0; // elapsed fixed ticks of the running sim (FR-41 playback)
    const TICKS_PER_FRAME = 4;

    // Render the document assembly (mate-solved + joint drives + explode); a no-op
    // while simulating (the sim owns the poses).
    const renderDoc = (): void => {
      if (useCadStore.getState().simulating) return;
      setInstances(explodedInstances(useCadStore.getState()));
    };
    const updatePoses = (): void => {
      if (simulator) setInstances(simulator.poses());
    };
    /** Publish body poses + experiment telemetry from the live simulator. */
    const publishTelemetry = (): void => {
      if (!simulator) {
        useCadStore.getState().setSimTelemetry(null);
        return;
      }
      const st = useCadStore.getState();
      const ids = simulator.bodyIds();
      const coms = simulator.comPositions();
      const speeds = simulator.speeds();
      const fixedSet = new Set(
        // Ground is always fixed; assembly "Fix" instances too.
        [
          "__experiment_ground",
          ...st.assembly.instances.filter((i) => i.fixed).map((i) => i.id),
        ],
      );
      // Bare single-part path uses body0.
      if (ids.length === 0 && coms.length > 0) {
        // still publish whatever the sim has
      }
      const rows = ids.map((id, i) => ({
        id,
        position: (coms[i] ?? [0, 0, 0]) as [number, number, number],
        speed: speeds[i] ?? 0,
        fixed: fixedSet.has(id) || id === "__experiment_ground",
      }));
      st.setSimTelemetry(
        buildTelemetry(simulator.elapsedSeconds, st.simExperiment.kind, rows),
      );
    };
    // Lower the document, apply the experiment recipe, spawn the sim. Returns body count.
    const buildSimulator = async (): Promise<number> => {
      simTicks = 0; // a fresh run starts at t=0
      const state = useCadStore.getState();
      const { manifest, localCom } = await client.lower(state.toDocument());
      // Experiment layer: lift, gravity, ground — pure transform of the CAD lower.
      const prepared = applyExperiment(manifest as SimManifest, state.simExperiment);
      const bodies = simBodies(state);
      setInstances(bodies);
      // Experiment backend override (else last explicit setBackend / default MuJoCo).
      const expBackend =
        state.simExperiment.backend === "default" ? undefined : state.simExperiment.backend;
      simulator = new Simulator(JSON.stringify(prepared), localCom, bodies.map((b) => b.id));
      const count = await simulator.start(expBackend ?? simBackend);
      publishTelemetry();
      return count;
    };
    const loop = (): void => {
      if (!simulator) {
        raf = 0;
        return;
      }
      // Respect Pause (FR-41): keep the RAF alive so Resume/Step still work, but only
      // advance + publish the elapsed tick count while running.
      if (!useCadStore.getState().simPaused) {
        simulator.step(TICKS_PER_FRAME);
        simTicks += TICKS_PER_FRAME;
        useCadStore.getState().setSimTicks(simTicks);
        updatePoses();
        publishTelemetry();
      }
      raf = requestAnimationFrame(loop);
    };
    // Step exactly one frame (used while paused, FR-41).
    const stepOnce = (): void => {
      if (!simulator) return;
      simulator.step(TICKS_PER_FRAME);
      simTicks += TICKS_PER_FRAME;
      useCadStore.getState().setSimTicks(simTicks);
      updatePoses();
      publishTelemetry();
    };
    // Rewind to t=0 (FR-41): rebuild a fresh sim; the running loop picks up the new
    // simulator, and buildSimulator re-seeds the bodies + resets simTicks.
    const rewindSimulator = async (): Promise<void> => {
      const old = simulator;
      await buildSimulator();
      old?.stop();
      updatePoses();
      publishTelemetry();
    };
    const stopSimulator = (): void => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      simulator?.stop();
      simulator = null;
      useCadStore.getState().setSimTelemetry(null);
      renderDoc();
    };
    // Deterministic manual control for the strict E2E (no RAF) + backend select.
    (
      globalThis as {
        __plastiqSimulate?: {
          start: () => Promise<number>;
          step: (n: number) => void;
          rewind: () => void;
          poseOf: (id: string) => { position: Vec3; orientation: Quat } | null;
          stop: () => void;
          setBackend: (name: BackendName) => void;
          backend: () => BackendName | null;
        };
      }
    ).__plastiqSimulate = {
      start: buildSimulator,
      step: (n) => {
        if (!simulator) return;
        simulator.step(n);
        updatePoses();
      },
      // Snapshot+restore round-trip: rewind to the spawned state (restores pose AND
      // velocity from the snapshot captured at start), then republish the poses.
      rewind: () => {
        if (!simulator) return;
        simulator.rewind();
        updatePoses();
      },
      poseOf: (id) => simulator?.poses().find((p) => p.id === id) ?? null,
      stop: stopSimulator,
      setBackend: (name) => {
        simBackend = name;
      },
      backend: () => activeBackend(),
    };

    renderDoc(); // initial assembly render
    const unsubAssembly = useCadStore.subscribe((s, prev) => {
      // Simulate toggle (FR-41): start a RAF-driven sim, or stop and return to edit.
      if (s.simulating !== prev.simulating) {
        if (s.simulating) {
          void buildSimulator().then(() => {
            if (!cancelled && useCadStore.getState().simulating) raf = requestAnimationFrame(loop);
          });
        } else {
          stopSimulator();
        }
        return;
      }
      // Playback one-shots while simulating (FR-41): step one frame / rewind to t=0
      // / restart with a new experiment recipe.
      if (s.simStepReq !== prev.simStepReq) stepOnce();
      if (s.simRewindReq !== prev.simRewindReq && s.simulating) void rewindSimulator();
      if (s.simRestartReq !== prev.simRestartReq && s.simulating) void rewindSimulator();
      if (s.simulating) return; // the sim owns the poses
      if (
        s.assembly !== prev.assembly ||
        s.jointDrive !== prev.jointDrive ||
        s.explodeFactor !== prev.explodeFactor
      ) {
        renderDoc();
        if (s.interferences) useCadStore.getState().setInterferences(null); // moved → stale
      }
      // Interference check (FR-33): clashes from the ASSEMBLED instance AABBs.
      if (s.interferenceReq !== prev.interferenceReq) {
        const mesh = meshRef.current;
        const a = useCadStore.getState().assembly;
        if (mesh && a.instances.length > 0) {
          const local = localBounds(mesh);
          const boxes = a.instances.map((i) =>
            worldBox(i.id, local, {
              id: i.id,
              position: i.pose.position,
              orientation: i.pose.orientation,
            }),
          );
          useCadStore.getState().setInterferences(findClashes(boxes));
        } else {
          useCadStore.getState().setInterferences([]);
        }
      }
    });

    return () => {
      cancelled = true;
      unsub();
      unsubSketch();
      unsubAssembly();
      stopSimulator();
      delete (globalThis as { __plastiqSimulate?: unknown }).__plastiqSimulate;
      client.dispose();
      delete (globalThis as { __plastiqLower?: unknown }).__plastiqLower;
      delete (globalThis as { __plastiqExport?: unknown }).__plastiqExport;
      delete (globalThis as { __plastiqBuild?: unknown }).__plastiqBuild;
      useProjectsStore.getState().setThumbnailProvider(null);
    };
  }, [setStatus]);

  // Re-derive mesh-document geometry from its inline GLB whenever the open mesh project
  // changes (SPEC-6 R4.2 / decision 20). A mesh document renders main-thread (importGltf
  // → MeshBody → buildMeshBody), bypassing the OCCT worker; null ⇒ the parametric path.
  useEffect(() => {
    let cancelled = false;
    const load = (doc: MeshDoc | null): void => {
      if (!doc) {
        setMeshBodies(null);
        return;
      }
      if (doc.editedBodies) {
        setMeshBodies(doc.editedBodies.map(deserializeMeshBody));
        return;
      }
      void importGltf(decodeBase64(doc.glb))
        .then((bodies) => {
          if (!cancelled) setMeshBodies(bodies);
        })
        .catch(() => {
          if (!cancelled) setMeshBodies(null);
        });
    };
    load(useProjectsStore.getState().activeMeshDoc);
    const unsub = useProjectsStore.subscribe((s, prev) => {
      if (s.activeMeshDoc !== prev.activeMeshDoc) load(s.activeMeshDoc);
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, []);

  // Mirror the open point-cloud document (SPEC-13) into local state so the Scene renders it. Unlike
  // a mesh document there is no GLB decode — the cloud's buffers ARE the render data — so it flows
  // straight through; null ⇒ not in cloud mode.
  useEffect(() => {
    setPointCloud(useProjectsStore.getState().activePointCloudDoc);
    return useProjectsStore.subscribe((s, prev) => {
      if (s.activePointCloudDoc !== prev.activePointCloudDoc) setPointCloud(s.activePointCloudDoc);
    });
  }, []);

  return (
    <>
      <Viewport3D
        mesh={mesh}
        meshBodies={meshBodies}
        pointCloud={pointCloud}
        sketchFrame={sketchFrame}
        instances={instances}
        onMeshBodiesChange={onMeshBodiesChange}
      />
      {/* The first-party SVG view cube (viewport/ViewCube, top-right DOM overlay)
          owns click-to-orient via the setView seam; explicit named views + Fit live
          in the sidebar's Inspect panel (ViewControl + the fit-view action). No
          floating panel sits over the cube. */}
      <ViewCubeOverlay />
      {/* Wasm-boot / long-rebuild affordance (Review #17): shows immediately for
          the initial "loading" state and after 300 ms for a "building" rebuild
          (LoadingOverlay reads the same status this component sets above). */}
      <LoadingOverlay />
      {measuring && (
        <div
          data-testid="measure-readout"
          className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded border border-[#3a3420] bg-black/70 px-3 py-1 text-xs text-[#ffd34a] backdrop-blur"
        >
          {measureResult ?? "Click two points to measure"}
        </div>
      )}
    </>
  );
}
