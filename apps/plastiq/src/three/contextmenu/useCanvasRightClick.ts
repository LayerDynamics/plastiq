// Wire the canvas `contextmenu` event into the menu: suppress the native menu,
// pick what's under the cursor, apply select-then-menu, resolve the context, and
// open the provider at the 3D world point. Lives inside the r3f <Canvas> (called
// by the gizmo) so it has the live renderer/camera/controls via useThree.

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { useThree } from "@react-three/fiber";
import { useCadStore } from "../../store/store.js";
import { useSketchStore } from "../../sketch/sketchStore.js";
import { Picker } from "../../viewport/pick.js";
import { GpuPicker } from "../gpuPick.js";
import type { BuiltPart } from "../../viewport/buildMesh.js";
import { resolveContextTarget, type RightClickHit } from "./contextSelection.js";
import { buildMenuSections } from "./contextOptions.js";
import { useContextMenu } from "./contextMenuProvider.js";

/** Minimal shape of the OrbitControls instance we attach the close listener to. */
interface ControlsLike {
  addEventListener(type: "start", fn: () => void): void;
  removeEventListener(type: "start", fn: () => void): void;
}

/** Snapshot the cad store into the pure CadSnapshot the resolver expects. */
function cadSnapshot(): Parameters<typeof resolveContextTarget>[0]["cad"] {
  const s = useCadStore.getState();
  return {
    picks: s.picks,
    selMode: s.selMode,
    selectionRefs: s.selectionRefs,
    features: s.features,
    selectedFeatureId: s.selectedFeatureId,
    mateMode: s.mateMode,
    matePicks: s.matePicks,
    simulating: s.simulating,
    simPaused: s.simPaused,
    section: s.section,
    measuring: s.measuring,
    explodeFactor: s.explodeFactor,
    gizmoMode: s.gizmoMode,
  };
}

export function useCanvasRightClick(part: BuiltPart | null): void {
  const gl = useThree((s) => s.gl);
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as ControlsLike | null;
  const invalidate = useThree((s) => s.invalidate);

  // Long-lived helpers + a ref so the listener always sees the latest part.
  const partRef = useRef<BuiltPart | null>(part);
  partRef.current = part;
  const picker = useRef(new Picker());
  const gpu = useRef(new GpuPicker());

  useEffect(() => {
    const el = gl.domElement;
    const close = (): void => {
      if (useContextMenu.getState().open) useContextMenu.getState().close();
    };

    /** NDC (−1..1, y up) from a client pixel position. */
    const ndcFrom = (cx: number, cy: number): { x: number; y: number } => {
      const r = el.getBoundingClientRect();
      return { x: ((cx - r.left) / r.width) * 2 - 1, y: -(((cy - r.top) / r.height) * 2 - 1) };
    };

    /** The 3D point under the cursor: exact surface hit → ground plane → ray point. */
    const worldPointAt = (ndc: { x: number; y: number }): [number, number, number] => {
      const v = new THREE.Vector2(ndc.x, ndc.y);
      const p = partRef.current;
      if (p) {
        const surface = picker.current.pickPoint(p, v, camera);
        if (surface) return [surface.x, surface.y, surface.z];
      }
      const ray = new THREE.Raycaster();
      ray.setFromCamera(v, camera);
      const ground = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
      const out = new THREE.Vector3();
      if (ray.ray.intersectPlane(ground, out)) return [out.x, out.y, out.z];
      ray.ray.at(0.2, out); // looking away from the ground — anchor a short way down the ray
      return [out.x, out.y, out.z];
    };

    /** Resolve the entity under the cursor (raycast, GPU fallback for face/body). */
    const hitAt = (ndc: { x: number; y: number }): RightClickHit | null => {
      const p = partRef.current;
      if (!p) return null;
      const mode = useCadStore.getState().selMode;
      const v = new THREE.Vector2(ndc.x, ndc.y);
      const raycast = picker.current.pick(p, v, camera, mode);
      if (raycast) return { kind: raycast.kind, id: raycast.id };
      if ((mode === "face" || mode === "body") && gpu.current.rayHitsPart(p, camera, ndc)) {
        const id = gpu.current.pick(gl, camera, p, ndc);
        if (id != null) return { kind: mode, id };
      }
      return null;
    };

    const onContextMenu = (e: MouseEvent): void => {
      e.preventDefault(); // suppress the browser's native menu
      const ndc = ndcFrom(e.clientX, e.clientY);
      const hit = hitAt(ndc);
      const store = useCadStore.getState();

      // Select-then-menu (CAD-standard): clicking an unselected entity selects it
      // (replacing the prior selection); clicking inside an existing multi-select
      // preserves it; clicking empty space clears. Sketch mode owns its own
      // selection, so don't touch 3D picks while sketching.
      if (!useSketchStore.getState().active) {
        if (hit) {
          const already = store.picks.some((q) => q.kind === hit.kind && q.id === hit.id);
          if (!already) store.pick({ kind: hit.kind, id: hit.id });
        } else {
          store.clearPicks();
        }
      }

      const target = resolveContextTarget({
        cad: cadSnapshot(), // fresh — reflects the selection just applied
        sketch: {
          active: useSketchStore.getState().active,
          selection: useSketchStore.getState().selection,
          solverReady: useSketchStore.getState().solverReady,
        },
        hit,
        worldPoint: worldPointAt(ndc),
      });
      useContextMenu.getState().openAt(target, buildMenuSections(target));
      invalidate();
    };

    // Dismiss: a fresh pointer gesture on the canvas (outside the Html menu), the
    // Escape key, or the start of an orbit. pointerdown fires before contextmenu,
    // so the opening right-click's own pointerdown lands while the menu is closed
    // (a no-op); the next gesture closes, and a right-click reopens via contextmenu.
    const onPointerDown = (): void => close();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") close();
    };

    el.addEventListener("contextmenu", onContextMenu);
    el.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKey);
    controls?.addEventListener("start", close);

    return () => {
      el.removeEventListener("contextmenu", onContextMenu);
      el.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKey);
      controls?.removeEventListener("start", close);
    };
  }, [gl, camera, controls, invalidate]);

  // Free the GPU-id render target when the menu layer unmounts.
  useEffect(() => () => gpu.current.dispose(), []);
}
