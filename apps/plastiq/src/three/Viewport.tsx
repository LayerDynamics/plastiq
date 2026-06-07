// React mount point for the r3f viewport (R0 of the SceneController→r3f rewrite).
// Owns the geometry worker, runs the rebuild loop, and feeds the freshly tessellated
// TransferMesh to the declarative <Viewport3D> scene. The worker bridge, sketch
// solve, and Zustand stores are unchanged — only the RENDERER moved to r3f.
//
// Capabilities still being ported in later stages (picking R1, gizmos R2/R3,
// sketch camera R4, section R5, assembly/sim R6) are not wired here yet.

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { useCadStore } from "../store/store.js";
import { PLACEMENT_TYPE, type CadDocument } from "../store/types.js";
import { GeometryClient } from "../worker/bridge.js";
import { useProjectsStore } from "../persistence/projectsStore.js";
import { Viewport3D } from "./Viewport3D.js";
import { standardViewDirection } from "../viewport/views.js";
import { resolveDatumPlane } from "../worker/sketchPlane.js";
import { useSketchStore } from "../sketch/sketchStore.js";
import { explodeInstances } from "../viewport/explode.js";
import { findClashes, type InstanceBox } from "../viewport/interference.js";
import { Simulator } from "../sim/simulator.js";
import { applyJointDrives, type AssemblyModel, type Quat, type Vec3 } from "../assembly/model.js";
import { activeBackend, type BackendName } from "@plastiq/sim";
import type { InstanceBody } from "./Assembly.js";
import type { DatumPlane } from "@plastiq/cad";
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

/** The bodies a simulation drives: the assembly instances, or one identity body
 * for a bare part (matching the worker's synthesized body0). */
function simBodies(assembly: AssemblyModel): InstanceBody[] {
  return assembly.instances.length > 0
    ? assembly.instances.map((i) => ({
        id: i.id,
        position: i.pose.position,
        orientation: i.pose.orientation,
      }))
    : [{ id: "body0", position: [0, 0, 0], orientation: [0, 0, 0, 1] }];
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

export function Viewport(): React.JSX.Element {
  const [mesh, setMesh] = useState<TransferMesh | null>(null);
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

  useEffect(() => {
    const client = new GeometryClient();

    // Interchange export (M6.2/M6.3) + assembly lowering (M4.5) seams.
    (globalThis as { __plastiqLower?: () => Promise<unknown> }).__plastiqLower = () =>
      client.lower(useCadStore.getState().toDocument());
    (
      globalThis as { __plastiqExport?: (f: "gltf" | "step" | "iges") => Promise<string> }
    ).__plastiqExport = (format) =>
      client.exportFile(useCadStore.getState().toDocument(), format);

    // Projects (M5): start the store (loads SQLite, arms crash-recovery autosave,
    // FR-40) and let Save capture the viewport canvas as the thumbnail (M5.3).
    const projects = useProjectsStore.getState();
    projects.setThumbnailProvider(() => {
      const c = document.querySelector("#viewport-root canvas") as HTMLCanvasElement | null;
      return c ? c.toDataURL("image/png") : null;
    });
    void projects.init();

    let cancelled = false;
    let building = false;
    let pending = false;
    let lastSig: string | null = null;

    const rebuild = async (): Promise<void> => {
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
        const built = await client.build(doc);
        if (!cancelled) {
          setMesh(built);
          meshRef.current = built;
          setStatus(built ? "ready" : "empty");
          const store = useCadStore.getState();
          store.setErrorFeature(null);
          if (built) {
            const faces: Record<number, { normal: [number, number, number] }> = {};
            for (const g of built.faceGroups) faces[g.faceId] = { normal: g.normal };
            const edges: Record<
              number,
              { faceNormals: (typeof built.edges)[number]["faceNormals"] }
            > = {};
            for (const e of built.edges) edges[e.edgeId] = { faceNormals: e.faceNormals };
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
        if (!cancelled) {
          const message = (err as Error).message;
          setStatus(`rebuild failed: ${message}`);
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
      if (geometrySignature(state) === lastSig) return; // pure placement change
      void rebuild();
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
    // Lower the document, spawn the sim, render its bodies. Returns body count.
    const buildSimulator = async (): Promise<number> => {
      simTicks = 0; // a fresh run starts at t=0
      const { manifest, localCom } = await client.lower(useCadStore.getState().toDocument());
      const bodies = simBodies(useCadStore.getState().assembly);
      setInstances(bodies);
      simulator = new Simulator(JSON.stringify(manifest), localCom, bodies.map((b) => b.id));
      return simulator.start(simBackend);
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
    };
    // Rewind to t=0 (FR-41): rebuild a fresh sim; the running loop picks up the new
    // simulator, and buildSimulator re-seeds the bodies + resets simTicks.
    const rewindSimulator = async (): Promise<void> => {
      const old = simulator;
      await buildSimulator();
      old?.stop();
      updatePoses();
    };
    const stopSimulator = (): void => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      simulator?.stop();
      simulator = null;
      renderDoc();
    };
    // Deterministic manual control for the strict E2E (no RAF) + backend select.
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
      // Playback one-shots while simulating (FR-41): step one frame / rewind to t=0.
      if (s.simStepReq !== prev.simStepReq) stepOnce();
      if (s.simRewindReq !== prev.simRewindReq && s.simulating) void rewindSimulator();
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
      useProjectsStore.getState().setThumbnailProvider(null);
    };
  }, [setStatus]);

  return (
    <>
      <Viewport3D mesh={mesh} sketchFrame={sketchFrame} instances={instances} />
      {/* Named standard views + Fit (FR-12); the in-scene cube (viewCube.gizmo)
          handles click-to-orient. Both drive the camera via __plastiqViewport. */}
      <div
        data-testid="viewcube"
        className="pointer-events-auto absolute right-2 top-2 flex max-w-[10rem] flex-wrap justify-end gap-1 rounded border border-[#2a3444] bg-black/50 p-1 text-[11px] text-[#9ab] backdrop-blur"
      >
        {(["top", "bottom", "front", "back", "right", "left", "iso"] as const).map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => {
              const d = standardViewDirection(v);
              (
                globalThis as {
                  __plastiqViewport?: { setView?: (dir: [number, number, number]) => void };
                }
              ).__plastiqViewport?.setView?.([d.x, d.y, d.z]);
            }}
            className="rounded px-1.5 py-0.5 capitalize hover:bg-[#1b2230]"
          >
            {v}
          </button>
        ))}
        <button
          type="button"
          data-testid="fit-view"
          onClick={() =>
            (
              globalThis as { __plastiqViewport?: { fitToView?: () => void } }
            ).__plastiqViewport?.fitToView?.()
          }
          className="rounded px-1.5 py-0.5 hover:bg-[#1b2230]"
        >
          Fit
        </button>
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
