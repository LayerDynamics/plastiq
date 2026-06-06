// React mount point for the r3f viewport (R0 of the SceneController→r3f rewrite).
// Owns the geometry worker, runs the rebuild loop, and feeds the freshly tessellated
// TransferMesh to the declarative <Viewport3D> scene. The worker bridge, sketch
// solve, and Zustand stores are unchanged — only the RENDERER moved to r3f.
//
// Capabilities still being ported in later stages (picking R1, gizmos R2/R3,
// sketch camera R4, section R5, assembly/sim R6) are not wired here yet.

import { useEffect, useState } from "react";
import { useCadStore } from "../store/store.js";
import { PLACEMENT_TYPE, type CadDocument } from "../store/types.js";
import { GeometryClient } from "../worker/bridge.js";
import { useProjectsStore } from "../persistence/projectsStore.js";
import { Viewport3D } from "./Viewport3D.js";
import { standardViewDirection } from "../viewport/views.js";
import type { TransferMesh } from "../worker/protocol.js";

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

    // Project thumbnails (M5.3): read back the preserved drawing buffer.
    useProjectsStore.getState().setThumbnailProvider(() => {
      const c = document.querySelector("#viewport-root canvas") as HTMLCanvasElement | null;
      return c ? c.toDataURL("image/png") : null;
    });

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

    return () => {
      cancelled = true;
      unsub();
      client.dispose();
      delete (globalThis as { __plastiqLower?: unknown }).__plastiqLower;
      delete (globalThis as { __plastiqExport?: unknown }).__plastiqExport;
      useProjectsStore.getState().setThumbnailProvider(null);
    };
  }, [setStatus]);

  return (
    <>
      <Viewport3D mesh={mesh} />
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
