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
import { snapshotCad, snapshotSketch } from "./snapshot.js";

/** Minimal shape of the OrbitControls instance we attach the close listener to. */
interface ControlsLike {
  addEventListener(type: "start", fn: () => void): void;
  removeEventListener(type: "start", fn: () => void): void;
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

    /** Anchor fallback when nothing is hit: the ground (Z=0) plane, else a short
     * way down the ray (when looking away from the ground). */
    const fallbackPoint = (v: THREE.Vector2): [number, number, number] => {
      const ray = new THREE.Raycaster();
      ray.setFromCamera(v, camera);
      const out = new THREE.Vector3();
      if (ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), 0), out))
        return [out.x, out.y, out.z];
      ray.ray.at(0.2, out);
      return [out.x, out.y, out.z];
    };

    /** The rendered assembly-instance groups (published by Assembly), or []. */
    const instanceGroups = (): THREE.Object3D[] =>
      ((globalThis as { __plastiqViewport?: { instanceGroups?: THREE.Object3D[] } })
        .__plastiqViewport?.instanceGroups ?? []) as THREE.Object3D[];

    /** Resolve what's under the cursor + the 3D anchor point. In assembly mode the
     * base part isn't rendered, so pick the instance groups; otherwise pick the
     * part (raycast, GPU fallback for face/body). */
    const pickAt = (ndc: {
      x: number;
      y: number;
    }): { hit: RightClickHit | null; worldPoint: [number, number, number] } => {
      const v = new THREE.Vector2(ndc.x, ndc.y);
      const groups = instanceGroups();
      if (groups.length > 0) {
        const ray = new THREE.Raycaster();
        ray.setFromCamera(v, camera);
        const intersect = ray.intersectObjects(groups, true)[0];
        if (intersect) {
          let o: THREE.Object3D | null = intersect.object;
          while (o && o.userData["instanceId"] == null) o = o.parent;
          const instanceId = o?.userData["instanceId"];
          const wp: [number, number, number] = [
            intersect.point.x,
            intersect.point.y,
            intersect.point.z,
          ];
          return typeof instanceId === "string"
            ? { hit: { kind: "body", id: 0, instanceId }, worldPoint: wp }
            : { hit: null, worldPoint: wp };
        }
        return { hit: null, worldPoint: fallbackPoint(v) };
      }

      const p = partRef.current;
      if (!p) return { hit: null, worldPoint: fallbackPoint(v) };
      const surface = picker.current.pickPoint(p, v, camera);
      const worldPoint: [number, number, number] = surface
        ? [surface.x, surface.y, surface.z]
        : fallbackPoint(v);
      const mode = useCadStore.getState().selMode;
      let hit: RightClickHit | null = picker.current.pick(p, v, camera, mode);
      if (!hit && (mode === "face" || mode === "body") && gpu.current.rayHitsPart(p, camera, ndc)) {
        const id = gpu.current.pick(gl, camera, p, ndc);
        if (id != null) hit = { kind: mode, id };
      }
      return { hit, worldPoint };
    };

    const onContextMenu = (e: MouseEvent): void => {
      e.preventDefault(); // suppress the browser's native menu
      const ndc = ndcFrom(e.clientX, e.clientY);
      const { hit, worldPoint } = pickAt(ndc);
      const store = useCadStore.getState();

      // Select-then-menu (CAD-standard): clicking an unselected entity selects it
      // (replacing the prior selection); clicking inside an existing multi-select
      // preserves it; clicking empty space clears. Skip for assembly instances
      // (no instance-selection store concept) and while sketching (own selection).
      if (!useSketchStore.getState().active) {
        if (hit && !hit.instanceId) {
          const already = store.picks.some((q) => q.kind === hit.kind && q.id === hit.id);
          if (!already) store.pick({ kind: hit.kind, id: hit.id });
        } else if (!hit) {
          store.clearPicks();
        }
      }

      const target = resolveContextTarget({
        cad: snapshotCad(), // fresh — reflects the selection just applied
        sketch: snapshotSketch(),
        hit,
        worldPoint,
      });
      useContextMenu.getState().openAt(target, buildMenuSections(target));
      invalidate();
    };

    // Dismiss: a fresh LEFT/MIDDLE pointer gesture on the canvas (outside the Html
    // menu), the Escape key, or the start of an orbit. The RIGHT button is the
    // menu's own open gesture (button 2 → contextmenu), so it must NOT close —
    // otherwise the opening right-click immediately dismisses the menu it just
    // opened. Left/middle clicks elsewhere still close it.
    const onPointerDown = (e: PointerEvent): void => {
      if (e.button !== 2) close();
    };
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
