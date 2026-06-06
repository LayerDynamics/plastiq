// React mount point for the three.js viewport (SPEC-5 M0.5/M1). It owns the
// SceneController lifetime, subscribes to the document in the Zustand store,
// rebuilds the geometry through the worker when the feature tree changes, and
// bridges typed selection + the transform gizmo (FR-8/FR-11) to the store.
// Rendering itself lives in SceneController; this component is just the bridge
// between React state and the imperative three.js scene.

import { useEffect, useRef } from "react";
import { useCadStore } from "../store/store.js";
import { PLACEMENT_TYPE } from "../store/types.js";
import type { CadDocument } from "../store/types.js";
import { GeometryClient } from "../worker/bridge.js";
import { SceneController } from "./SceneController.js";
import { ViewCube } from "./ViewCube.js";
import { cubeDirection, type CubeAxes } from "./cubeView.js";
import { findPlacement, placementFromFeature, placementParams } from "./placement.js";
import { useProjectsStore } from "../persistence/projectsStore.js";
import { applyJointDrives, type AssemblyModel, type Quat, type Vec3 } from "../assembly/model.js";
import { Simulator } from "../sim/simulator.js";
import { explodeInstances } from "./explode.js";
import { useSketchStore } from "../sketch/sketchStore.js";
import { resolveDatumPlane } from "../worker/sketchPlane.js";
import { activeBackend, type BackendName } from "@plastiq/sim";

/** The instance poses the scene renders: the mate-solved poses with any active
 * joint drives applied (motion preview, FR-36). */
function instanceList(
  assembly: AssemblyModel,
  jointDrive: Record<string, number>,
): { id: string; position: Vec3; orientation: Quat }[] {
  const driven = applyJointDrives(assembly.instances, assembly.joints, jointDrive);
  return driven.map((i) => ({
    id: i.id,
    position: i.pose.position,
    orientation: i.pose.orientation,
  }));
}

/** The instance render poses with the active exploded-view spread applied (FR-33). */
function explodedInstances(s: {
  assembly: AssemblyModel;
  jointDrive: Record<string, number>;
  explodeFactor: number;
}): { id: string; position: Vec3; orientation: Quat }[] {
  return explodeInstances(instanceList(s.assembly, s.jointDrive), s.explodeFactor);
}

/** The features that actually build, honoring the rollback point (FR-25). */
function buildFeatures(s: {
  features: CadDocument["features"];
  rollbackIndex: number | null;
}): CadDocument["features"] {
  return s.rollbackIndex == null ? s.features : s.features.slice(0, s.rollbackIndex);
}

/** A signature of only the geometry-affecting features (placement excluded, and
 * past the rollback point), so a pure pose change doesn't trigger an OCCT
 * rebuild but a rollback move does. */
function geometrySignature(s: {
  features: CadDocument["features"];
  rollbackIndex: number | null;
}): string {
  return JSON.stringify(buildFeatures(s).filter((f) => f.type !== PLACEMENT_TYPE));
}

export function Viewport(): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<SceneController | null>(null);
  const clientRef = useRef<GeometryClient | null>(null);
  const setStatus = useCadStore((s) => s.setStatus);
  const measuring = useCadStore((s) => s.measuring);
  const measureResult = useCadStore((s) => s.measureResult);

  // Mount the scene + worker once.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const scene = new SceneController(host);
    const client = new GeometryClient();
    sceneRef.current = scene;
    clientRef.current = client;
    // Expose the live scene so the M0/M1 E2Es can drive the real pick + gizmo
    // paths. Harmless in production; it's just a handle to the scene.
    (globalThis as { __plastiqScene?: SceneController }).__plastiqScene = scene;
    // Expose the GPU colour-id face pick (NFR-4) for the strict E2E.
    (
      globalThis as { __plastiqGpuPick?: (ndcX: number, ndcY: number) => number | null }
    ).__plastiqGpuPick = (ndcX, ndcY) => scene.gpuPickFace({ x: ndcX, y: ndcY });
    // Expose assembly→SimManifest lowering (M4.5) for the Export-to-Sim action +
    // the strict E2E: lowers the current document's assembly via the worker.
    (globalThis as { __plastiqLower?: () => Promise<unknown> }).__plastiqLower = () =>
      client.lower(useCadStore.getState().toDocument());
    // Interchange export (M6.2/M6.3): serialize the part to glTF/STEP/IGES.
    (
      globalThis as { __plastiqExport?: (f: "gltf" | "step" | "iges") => Promise<string> }
    ).__plastiqExport = (format) =>
      client.exportFile(useCadStore.getState().toDocument(), format);

    // Projects (M5): load the SQLite store + let Save capture the viewport.
    const projects = useProjectsStore.getState();
    projects.setThumbnailProvider(() => sceneRef.current?.captureThumbnail() ?? null);
    void projects.init();

    // --- Simulate (M6.1) -----------------------------------------------------
    // The render groups the sim drives: the assembly instances, or one identity
    // body for a bare part (matching the worker's synthesized body0).
    let simulator: Simulator | null = null;
    // Which physics backend the next sim run uses (default Rapier). Selectable at
    // runtime — the pluggable design's whole point; the E2E suite drives ammo and
    // cannon through here to prove all three engines run in the browser.
    let simBackend: BackendName | undefined;
    // One "frame" of playback advances this many fixed ticks (matches the RAF
    // loop's batch); the Step button advances exactly one such frame.
    const TICKS_PER_FRAME = 4;
    // Render the assembly instances with the active exploded-view spread applied.
    const renderInstances = (s: {
      assembly: AssemblyModel;
      jointDrive: Record<string, number>;
      explodeFactor: number;
    }): void => scene.setInstances(explodedInstances(s));
    const simBodies = (): { id: string; position: Vec3; orientation: Quat }[] => {
      const a = useCadStore.getState().assembly;
      return a.instances.length > 0
        ? a.instances.map((i) => ({
            id: i.id,
            position: i.pose.position,
            orientation: i.pose.orientation,
          }))
        : [{ id: "body0", position: [0, 0, 0], orientation: [0, 0, 0, 1] }];
    };
    /** Lower the document, spawn the sim, and render its bodies. Returns body count. */
    const buildSimulator = async (): Promise<number> => {
      const { manifest, localCom } = await client.lower(useCadStore.getState().toDocument());
      const bodies = simBodies();
      scene.setInstances(bodies);
      simulator = new Simulator(
        JSON.stringify(manifest),
        localCom,
        bodies.map((b) => b.id),
      );
      return simulator.start(simBackend);
    };
    const stopSimulator = (): void => {
      scene.setSimulation(null);
      simulator?.stop();
      simulator = null;
      const s = useCadStore.getState();
      renderInstances(s); // re-derive from doc
    };
    // E2E hook: deterministic manual control (no RAF). setBackend selects the
    // physics engine (rapier|ammo|cannon) for the next run; backend() reports the
    // active one after start.
    (
      globalThis as {
        __plastiqSimulate?: {
          start: () => Promise<number>;
          step: (n: number) => void;
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
        scene.setInstancePoses(simulator.poses());
      },
      poseOf: (id) => simulator?.poses().find((p) => p.id === id) ?? null,
      stop: stopSimulator,
      setBackend: (name) => {
        simBackend = name;
      },
      backend: () => activeBackend(),
    };

    const initial = useCadStore.getState();
    scene.setSelectionMode(initial.selMode);
    scene.setPicks(initial.picks);
    scene.setTransformMode(initial.gizmoMode);
    scene.setPlacement(placementFromFeature(findPlacement(initial.features)));
    scene.showGizmo(initial.picks.length > 0);
    scene.setMeasuring(initial.measuring);
    scene.setMeasureHandler((result) => useCadStore.getState().setMeasureResult(result));
    scene.setSection(initial.section);
    renderInstances(initial);
    // Mate authoring: a click on an instance face records a mate endpoint (M4.2).
    const syncMateMode = (on: boolean): void =>
      scene.setInstancePickHandler(on ? (p) => useCadStore.getState().addMatePick(p) : null);
    syncMateMode(initial.mateMode);

    // Click → selection (additive on Shift/Ctrl; a bare miss clears).
    scene.setPickHandler((p, additive) => {
      const store = useCadStore.getState();
      if (p) store.pick(p, additive);
      else if (!additive) store.clearPicks();
    });
    // Rubber-band box select (FR-10): Shift-drag selects every entity in the rect.
    scene.setBoxSelectHandler((picks, additive) => {
      const store = useCadStore.getState();
      if (picks.length === 0 && !additive) store.clearPicks();
      else store.setPicks(picks, additive);
    });
    // Gizmo drag-release → persist the new pose as a parametric placement (FR-11).
    scene.setTransformHandler((placement) => {
      useCadStore.getState().upsertPlacement(placementParams(placement));
    });

    // Push store selection/mode/placement changes back into the imperative scene.
    const unsubSel = useCadStore.subscribe((s, prev) => {
      if (s.selMode !== prev.selMode) scene.setSelectionMode(s.selMode);
      if (s.picks !== prev.picks) {
        scene.setPicks(s.picks);
        scene.showGizmo(s.picks.length > 0);
      }
      if (s.gizmoMode !== prev.gizmoMode) scene.setTransformMode(s.gizmoMode);
      if (s.measuring !== prev.measuring) scene.setMeasuring(s.measuring);
      if (s.section !== prev.section) scene.setSection(s.section);
      if (s.features !== prev.features) {
        scene.setPlacement(placementFromFeature(findPlacement(s.features)));
      }
      // While simulating, the sim owns the instance poses — don't re-derive.
      if (
        !s.simulating &&
        (s.assembly !== prev.assembly ||
          s.jointDrive !== prev.jointDrive ||
          s.explodeFactor !== prev.explodeFactor)
      ) {
        renderInstances(s);
        // Instances moved → any prior interference result is stale.
        if (s.interferences) useCadStore.getState().setInterferences(null);
      }
      // Interference check (FR-33): compute clashes on request, publish to the store.
      if (s.interferenceReq !== prev.interferenceReq) {
        useCadStore.getState().setInterferences(scene.findInterferences());
      }
      if (s.mateMode !== prev.mateMode) syncMateMode(s.mateMode);
      // Simulate (FR-41): start a RAF-driven sim, or stop and return to edit.
      if (s.simulating !== prev.simulating) {
        if (s.simulating) {
          void buildSimulator().then(() => {
            if (!simulator || !useCadStore.getState().simulating) return;
            scene.setSimulation({
              ticksPerFrame: TICKS_PER_FRAME,
              step: (n) => {
                // Playback: skip advancing while paused (poses() still renders the
                // frozen state each frame). Mirror elapsed ticks into the store.
                if (useCadStore.getState().simPaused) return;
                simulator!.step(n);
                useCadStore.getState().setSimTicks(simulator!.ticks);
              },
              poses: () => simulator!.poses(),
            });
          });
        } else {
          stopSimulator();
        }
      }
      // One-shot playback commands (FR-41), applied to the live simulator.
      if (s.simStepReq !== prev.simStepReq && simulator) {
        simulator.step(TICKS_PER_FRAME); // advance one frame while paused
        scene.setInstancePoses(simulator.poses());
        useCadStore.getState().setSimTicks(simulator.ticks);
      }
      if (s.simRewindReq !== prev.simRewindReq && simulator) {
        simulator.rewind(); // restore the spawned state (pose + velocity), t=0
        scene.setInstancePoses(simulator.poses());
        useCadStore.getState().setSimTicks(0);
      }
    });

    // "Normal to" sketch view (M3): while a sketch is active, render the scene
    // through an ortho camera locked to the sketch plane + the overlay's 2D view,
    // so the model behind the transparent overlay coincides with the sketch.
    const applySketchView = (s: ReturnType<typeof useSketchStore.getState>): void => {
      const plane = s.active ? resolveDatumPlane(s.model.plane, s.model.offset ?? 0) : null;
      scene.setSketchView(plane, s.view);
    };
    applySketchView(useSketchStore.getState());
    const unsubSketch = useSketchStore.subscribe((s, prev) => {
      if (s.active !== prev.active || s.model !== prev.model || s.view !== prev.view) {
        applySketchView(s);
      }
    });

    return () => {
      unsubSel();
      unsubSketch();
      simulator?.stop();
      client.dispose();
      scene.dispose();
      sceneRef.current = null;
      clientRef.current = null;
      delete (globalThis as { __plastiqScene?: SceneController }).__plastiqScene;
      delete (globalThis as { __plastiqLower?: () => Promise<unknown> }).__plastiqLower;
      delete (globalThis as { __plastiqExport?: unknown }).__plastiqExport;
      delete (globalThis as { __plastiqSimulate?: unknown }).__plastiqSimulate;
      useProjectsStore.getState().setThumbnailProvider(null);
    };
  }, []);

  // Rebuild whenever a geometry-affecting feature changes. Subscribing to the
  // store outside React's render keeps three.js off the React reconciler.
  useEffect(() => {
    let cancelled = false;
    let building = false;
    let pending = false;
    let lastSig: string | null = null;

    const rebuild = async (): Promise<void> => {
      const client = clientRef.current;
      const scene = sceneRef.current;
      if (!client || !scene) return;
      if (building) {
        pending = true;
        return;
      }
      building = true;
      setStatus("building");
      const state = useCadStore.getState();
      const full = state.toDocument();
      const doc: CadDocument = { features: buildFeatures(state), params: full.params };
      lastSig = geometrySignature(state);
      try {
        const mesh = await client.build(doc);
        if (!cancelled) {
          scene.setMesh(mesh);
          // Re-render instances against the fresh geometry (setMesh reset it).
          {
            const st = useCadStore.getState();
            scene.setInstances(explodedInstances(st));
          }
          setStatus(mesh ? "ready" : "empty");
          const store = useCadStore.getState();
          store.setErrorFeature(null);
          // Publish this build's persistent-ref lookup so dress-up features
          // (M2.4) can store an EdgeRef/FaceRef for a picked entity (FR-16).
          if (mesh) {
            const faces: Record<number, { normal: [number, number, number] }> = {};
            for (const g of mesh.faceGroups) faces[g.faceId] = { normal: g.normal };
            const edges: Record<
              number,
              { faceNormals: (typeof mesh.edges)[number]["faceNormals"] }
            > = {};
            for (const e of mesh.edges) edges[e.edgeId] = { faceNormals: e.faceNormals };
            store.setSelectionRefs({ faces, edges });
          } else {
            store.setSelectionRefs({ faces: {}, edges: {} });
          }
          // Surface the build's volume + centroid in the properties panel (or
          // clear it when the document produced no geometry).
          store.setMassProps(
            mesh && mesh.volume != null && mesh.com
              ? { volume: mesh.volume, com: mesh.com }
              : null,
          );
        }
      } catch (err) {
        if (!cancelled) {
          const message = (err as Error).message;
          setStatus(`rebuild failed: ${message}`);
          // Rebuild errors name the offending feature ("feature 'f3' (extrude): …").
          const m = /feature '([^']+)'/.exec(message);
          useCadStore.getState().setErrorFeature(m ? m[1]! : null);
        }
      } finally {
        building = false;
        if (pending && !cancelled) {
          pending = false;
          void rebuild();
        }
      }
    };

    void rebuild(); // initial build of whatever is already in the store
    const unsub = useCadStore.subscribe((state, prev) => {
      if (
        state.features === prev.features &&
        state.params === prev.params &&
        state.rollbackIndex === prev.rollbackIndex
      ) {
        return;
      }
      // A pure placement change (gizmo drag) keeps geometry identical — skip the
      // OCCT rebuild; the placement subscription repositions the part.
      if (geometrySignature(state) === lastSig) return;
      void rebuild();
    });

    return () => {
      cancelled = true;
      unsub();
    };
  }, [setStatus]);

  const view = (v: Parameters<SceneController["standardView"]>[0]) => (): void =>
    sceneRef.current?.standardView(v);
  const fit = (): void => sceneRef.current?.fitToView();
  const pickCube = (axes: CubeAxes): void =>
    sceneRef.current?.setViewDirection(cubeDirection(axes));

  return (
    <>
      <div ref={hostRef} className="absolute inset-0" />
      {/* Standard views + fit (FR-12). The clickable axis triad is the corner
          gizmo rendered by SceneController itself. */}
      <div
        data-testid="viewcube"
        className="pointer-events-auto absolute right-2 top-2 flex flex-col items-end gap-1 rounded border border-[#2a3444] bg-black/50 p-1 text-[11px] text-[#9ab] backdrop-blur"
      >
        {/* Clickable cube: faces → ortho, edges → edge views, near corner → iso. */}
        <ViewCube onPick={pickCube} />
        <div className="flex flex-wrap justify-end gap-1">
          {(["top", "bottom", "front", "back", "right", "left", "iso"] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={view(v)}
              className="rounded px-1.5 py-0.5 capitalize hover:bg-[#1b2230]"
            >
              {v}
            </button>
          ))}
          <button type="button" onClick={fit} className="rounded px-1.5 py-0.5 hover:bg-[#1b2230]">
            Fit
          </button>
        </div>
      </div>
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
