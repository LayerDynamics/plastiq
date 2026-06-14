// Typed 3D picking + highlight for the r3f viewport (R1). Reuses the pure
// Picker/boxSelect/applyHighlight logic; only the imperative glue (DOM pointer
// events, hover, rubber-band overlay, the GPU-id fallback, the test seams) is
// re-homed here, driven off the shared renderer/camera via useThree.

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { useThree } from "@react-three/fiber";
import { useCadStore } from "../store/store.js";
import { Picker, boxSelect, ndcRect } from "../viewport/pick.js";
import { applyHighlight } from "../viewport/highlight.js";
import { nextMeasure } from "../viewport/measure.js";
import { GpuPicker } from "./gpuPick.js";
import type { BuiltPart } from "../viewport/buildMesh.js";
import type { Pick, SelectionMode } from "../store/types.js";

/** Representative NDC point of every pickable entity for `mode` (box-select). */
function selectionCandidates(
  part: BuiltPart,
  mode: SelectionMode,
  camera: THREE.Camera,
): { id: number; x: number; y: number }[] {
  const project = (p: THREE.Vector3): { x: number; y: number } => {
    const v = p.clone().project(camera);
    return { x: v.x, y: v.y };
  };
  const out: { id: number; x: number; y: number }[] = [];
  if (mode === "edge") {
    for (const line of part.edges) {
      const id = line.userData["edgeId"];
      if (typeof id !== "number") continue;
      line.geometry.computeBoundingSphere();
      const c = line.geometry.boundingSphere?.center;
      if (c) out.push({ id, ...project(c.clone().applyMatrix4(line.matrixWorld)) });
    }
    return out;
  }
  if (mode === "vertex" && part.vertexPoints) {
    const vp = part.vertexPoints;
    const ids = vp.userData["vertexIds"] as number[] | undefined;
    const pos = vp.geometry.getAttribute("position");
    if (ids) {
      for (let i = 0; i < ids.length; i++) {
        const w = new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(vp.matrixWorld);
        out.push({ id: ids[i]!, ...project(w) });
      }
    }
    return out;
  }
  // face / body: the centroid of each per-face triangle group.
  const mesh = part.mesh;
  const faceIds = mesh.userData["faceIds"] as number[] | undefined;
  const geom = mesh.geometry;
  const pos = geom.getAttribute("position");
  const index = geom.getIndex();
  if (!faceIds || !index) return out;
  mesh.updateWorldMatrix(true, false);
  geom.groups.forEach((g, gi) => {
    const id = faceIds[gi];
    if (id == null) return;
    const c = new THREE.Vector3();
    const v = new THREE.Vector3();
    for (let k = g.start; k < g.start + g.count; k++) c.add(v.fromBufferAttribute(pos, index.getX(k)));
    if (g.count > 0) c.multiplyScalar(1 / g.count).applyMatrix4(mesh.matrixWorld);
    out.push({ id, ...project(c) });
  });
  return out;
}

interface ViewportGlobal {
  builtPart: BuiltPart | null;
  gpuPickFace?: (ndc: { x: number; y: number }) => number | null;
  /** Client-pixel position of the first selectable candidate for `mode` — an E2E
   * seam so a test can click exactly where an edge/vertex projects. */
  candidatePx?: (mode: SelectionMode) => { x: number; y: number } | null;
}

const CLICK_TOL_PX = 4; // beyond this a press is an orbit/box drag, not a click

export function Picking({ part }: { part: BuiltPart | null }): null {
  const gl = useThree((s) => s.gl);
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as { enabled: boolean } | null;
  const invalidate = useThree((s) => s.invalidate);

  // Refs so the long-lived DOM listeners always see the latest part/camera.
  const partRef = useRef<BuiltPart | null>(part);
  partRef.current = part;
  const hoverRef = useRef<Pick | null>(null);
  // The first world point banked by the measure tool, awaiting its second click.
  const measureFirstRef = useRef<THREE.Vector3 | null>(null);
  const picker = useRef(new Picker());
  const gpu = useRef(new GpuPicker());

  // Reapply highlight from the store picks + local hover (orange selection).
  const refreshHighlight = (): void => {
    const p = partRef.current;
    if (!p) return;
    applyHighlight(p, useCadStore.getState().picks, hoverRef.current);
    invalidate();
  };

  // GPU-id pick seam (NFR-4) + the __plastiqGpuPick global the strict E2E drives.
  useEffect(() => {
    const gpuPickFace = (ndc: { x: number; y: number }): number | null => {
      const p = partRef.current;
      return p ? gpu.current.pick(gl, camera, p, ndc) : null;
    };
    (globalThis as { __plastiqGpuPick?: (x: number, y: number) => number | null }).__plastiqGpuPick =
      (x, y) => gpuPickFace({ x, y });
    const vp = ((globalThis as { __plastiqViewport?: ViewportGlobal }).__plastiqViewport ??= {
      builtPart: null,
    });
    vp.gpuPickFace = gpuPickFace;
    return () => {
      delete (globalThis as { __plastiqGpuPick?: unknown }).__plastiqGpuPick;
      delete vp.gpuPickFace;
    };
  }, [gl, camera]);

  // Re-highlight when the part swaps or the store picks change.
  useEffect(() => {
    measureFirstRef.current = null; // a rebuilt part invalidates any banked point
    refreshHighlight();
    return useCadStore.subscribe((s, prev) => {
      if (s.picks !== prev.picks) refreshHighlight();
      // Turning the tool off drops a half-finished measurement (FR-13).
      if (s.measuring !== prev.measuring && !s.measuring) measureFirstRef.current = null;
    });
  }, [part]);

  // Pointer interaction: hover, click→pick (raycast then GPU fallback), and
  // shift-drag rubber-band box-select.
  useEffect(() => {
    const el = gl.domElement;
    const overlay = document.createElement("div");
    overlay.dataset["testid"] = "box-select-rect";
    Object.assign(overlay.style, {
      position: "absolute",
      border: "1px solid #4ea1ff",
      background: "rgba(78,161,255,0.12)",
      pointerEvents: "none",
      display: "none",
      zIndex: "5",
    });
    el.parentElement?.appendChild(overlay);

    const ndcFrom = (cx: number, cy: number): { x: number; y: number } => {
      const r = el.getBoundingClientRect();
      return { x: ((cx - r.left) / r.width) * 2 - 1, y: -(((cy - r.top) / r.height) * 2 - 1) };
    };
    // Edges/vertices are thin targets the triangle/line raycast usually misses, so
    // they were effectively unselectable. Fall back to the nearest PROJECTED edge/
    // vertex within a pixel tolerance — click NEAR one and it selects. (Faces/bodies
    // use the robust GPU-id buffer instead; this guard returns null for them.)
    const NEAR_TOL_PX = 14;
    const screenNearest = (
      pt: BuiltPart,
      mode: SelectionMode,
      ndc: { x: number; y: number },
    ): Pick | null => {
      if (mode !== "edge" && mode !== "vertex") return null;
      const w = el.clientWidth || 1;
      const h = el.clientHeight || 1;
      const cx = ((ndc.x + 1) / 2) * w;
      const cy = ((1 - ndc.y) / 2) * h;
      let best: Pick | null = null;
      let bestD = NEAR_TOL_PX;
      for (const c of selectionCandidates(pt, mode, camera)) {
        const d = Math.hypot(((c.x + 1) / 2) * w - cx, ((1 - c.y) / 2) * h - cy);
        if (d < bestD) {
          bestD = d;
          best = { kind: mode, id: c.id };
        }
      }
      return best;
    };
    let downAt: { x: number; y: number } | null = null;
    let boxStart: { x: number; y: number } | null = null;

    const onDown = (e: PointerEvent): void => {
      downAt = { x: e.clientX, y: e.clientY };
      if (e.shiftKey) boxStart = { x: e.clientX, y: e.clientY };
    };
    const onMove = (e: PointerEvent): void => {
      const p = partRef.current;
      if (!p) return;
      if (boxStart) {
        if (Math.hypot(e.clientX - boxStart.x, e.clientY - boxStart.y) > CLICK_TOL_PX) {
          if (controls) controls.enabled = false;
          const r = el.getBoundingClientRect();
          const x0 = boxStart.x - r.left;
          const y0 = boxStart.y - r.top;
          const x1 = e.clientX - r.left;
          const y1 = e.clientY - r.top;
          Object.assign(overlay.style, {
            display: "block",
            left: `${Math.min(x0, x1)}px`,
            top: `${Math.min(y0, y1)}px`,
            width: `${Math.abs(x1 - x0)}px`,
            height: `${Math.abs(y1 - y0)}px`,
          });
        }
        return;
      }
      const ndc = ndcFrom(e.clientX, e.clientY);
      const mode = useCadStore.getState().selMode;
      let next = picker.current.pick(p, new THREE.Vector2(ndc.x, ndc.y), camera, mode);
      if (!next) next = screenNearest(p, mode, ndc); // edge/vertex near-miss → hover it
      if (
        (next?.id ?? null) !== (hoverRef.current?.id ?? null) ||
        (next?.kind ?? null) !== (hoverRef.current?.kind ?? null)
      ) {
        hoverRef.current = next;
        refreshHighlight();
      }
    };
    const onUp = (e: PointerEvent): void => {
      const p = partRef.current;
      const additive = e.shiftKey || e.ctrlKey || e.metaKey;
      const store = useCadStore.getState();
      if (boxStart) {
        const moved = Math.hypot(e.clientX - boxStart.x, e.clientY - boxStart.y) > CLICK_TOL_PX;
        overlay.style.display = "none";
        if (controls) controls.enabled = true;
        const start = boxStart;
        boxStart = null;
        if (moved) {
          downAt = null;
          if (p) {
            const a = ndcFrom(start.x, start.y);
            const b = ndcFrom(e.clientX, e.clientY);
            const ids = boxSelect(
              ndcRect({ x: a.x, y: a.y }, { x: b.x, y: b.y }),
              selectionCandidates(p, store.selMode, camera),
            );
            const picks: Pick[] =
              store.selMode === "body"
                ? ids.length > 0
                  ? [{ kind: "body", id: 0 }]
                  : []
                : ids.map((id) => ({ kind: store.selMode, id }));
            store.setPicks(picks, additive);
          }
          return;
        }
        // A Shift+click with no drag is an additive pick, not a box-select:
        // fall through to the click path below (downAt is still set) so it
        // reaches store.pick(hit, additive).
      }
      if (!downAt) return;
      const dist = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
      downAt = null;
      if (dist > CLICK_TOL_PX || !p) return; // a drag = orbit, not a click
      const ndc = ndcFrom(e.clientX, e.clientY);
      // Measure tool (FR-13): a click banks the world point under the cursor; the
      // second click resolves the distance + axis deltas. This suppresses normal
      // selection while measuring is active.
      if (store.measuring) {
        const wp = picker.current.pickPoint(p, new THREE.Vector2(ndc.x, ndc.y), camera);
        if (!wp) return; // clicked empty space — keep waiting for a point on the part
        const step = nextMeasure(measureFirstRef.current, wp);
        measureFirstRef.current = step.first;
        store.setMeasureResult(step.result);
        return;
      }
      const mode = store.selMode;
      let hit = picker.current.pick(p, new THREE.Vector2(ndc.x, ndc.y), camera, mode);
      // GPU-id fallback for face/body when the triangle raycast misses (NFR-4).
      if (!hit && (mode === "face" || mode === "body") && gpu.current.rayHitsPart(p, camera, ndc)) {
        const id = gpu.current.pick(gl, camera, p, ndc);
        if (id != null) hit = { kind: mode, id };
      }
      // Screen-space fallback for thin edge/vertex targets (click near them).
      if (!hit) hit = screenNearest(p, mode, ndc);
      if (hit) store.pick(hit, additive);
      else if (!additive) store.clearPicks();
    };

    // E2E seam: where the first selectable edge/vertex projects, in client px.
    const vp = ((globalThis as { __plastiqViewport?: ViewportGlobal }).__plastiqViewport ??= {
      builtPart: null,
    });
    vp.candidatePx = (mode): { x: number; y: number } | null => {
      const pt = partRef.current;
      if (!pt) return null;
      const c = selectionCandidates(pt, mode, camera)[0];
      if (!c) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + ((c.x + 1) / 2) * r.width, y: r.top + ((1 - c.y) / 2) * r.height };
    };

    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      overlay.remove();
      delete vp.candidatePx;
    };
  }, [gl, camera, controls]);

  // Free the GPU-id render target when the picking layer unmounts.
  useEffect(() => () => gpu.current.dispose(), []);

  return null;
}
