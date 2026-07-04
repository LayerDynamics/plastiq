// Typed 3D picking + highlight for the r3f viewport (R1). Reuses the pure
// Picker/boxSelect/applyHighlight logic; only the imperative glue (DOM pointer
// events, hover, rubber-band overlay, the GPU-id fallback, the test seams) is
// re-homed here, driven off the shared renderer/camera via useThree.

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { useThree } from "@react-three/fiber";
import { useCadStore } from "../store/store.js";
import { boxSelect, ndcRect } from "../viewport/pick.js";
import { applyHighlight } from "../viewport/highlight.js";
import { nextMeasure } from "../viewport/measure.js";
import { useSharedPickers } from "./sharedPickers.js";
import type { BuiltPart } from "../viewport/buildMesh.js";
import type { Pick, SelectionMode } from "../store/types.js";

/** A pickable entity's representative point in its object's LOCAL space, plus the
 * object whose live `matrixWorld` carries it to world space. The local point and the
 * source geometry never change for a `BuiltPart`'s lifetime (every edit produces a
 * fresh part via `buildPart`), so these are computed once and cached; only the camera
 * projection — which a hover/orbit invalidates — is redone per call. */
interface CandidateLocal {
  id: number;
  local: THREE.Vector3;
  obj: THREE.Object3D;
}

// Per-part, per-mode cache of LOCAL candidate points. Keyed by the `BuiltPart`, so a
// rebuilt part (new geometry) gets a fresh entry and the old one is GC'd — no manual
// invalidation. This lifts the heavy geometry traversals (`computeBoundingSphere`,
// face-centroid sums, vertex reads) off the per-hover-move hot path: `screenNearest`
// calls `selectionCandidates` on every pointer-move that misses the raycast.
const candidateCache = new WeakMap<BuiltPart, Map<SelectionMode, CandidateLocal[]>>();
// Scratch vector reused across the projection loop so hover moves allocate nothing.
const _project = new THREE.Vector3();

/** Build the LOCAL representative point of every pickable entity for `mode`. Runs the
 * expensive geometry traversals exactly once per (part, mode); cached thereafter. */
function buildCandidateLocals(part: BuiltPart, mode: SelectionMode): CandidateLocal[] {
  const out: CandidateLocal[] = [];
  if (mode === "edge") {
    for (const line of part.edges) {
      const id = line.userData["edgeId"];
      if (typeof id !== "number") continue;
      // The sphere centre is geometry-local and immutable here; THREE caches it on
      // the geometry, so compute it at most once per edge (not once per hover move).
      if (!line.geometry.boundingSphere) line.geometry.computeBoundingSphere();
      const c = line.geometry.boundingSphere?.center;
      if (c) out.push({ id, local: c.clone(), obj: line });
    }
    return out;
  }
  if (mode === "vertex" && part.vertexPoints) {
    const vp = part.vertexPoints;
    const ids = vp.userData["vertexIds"] as number[] | undefined;
    const pos = vp.geometry.getAttribute("position");
    if (ids) {
      for (let i = 0; i < ids.length; i++) {
        out.push({ id: ids[i]!, local: new THREE.Vector3().fromBufferAttribute(pos, i), obj: vp });
      }
    }
    return out;
  }
  // face / body: the centroid of each per-face triangle group, in mesh-local space.
  const mesh = part.mesh;
  const faceIds = mesh.userData["faceIds"] as number[] | undefined;
  const geom = mesh.geometry;
  const pos = geom.getAttribute("position");
  const index = geom.getIndex();
  if (!faceIds || !index) return out;
  geom.groups.forEach((g, gi) => {
    const id = faceIds[gi];
    if (id == null) return;
    if (g.count === 0) return; // degenerate group: no triangles, so no meaningful centroid
    const c = new THREE.Vector3();
    const v = new THREE.Vector3();
    for (let k = g.start; k < g.start + g.count; k++) c.add(v.fromBufferAttribute(pos, index.getX(k)));
    c.multiplyScalar(1 / g.count);
    out.push({ id, local: c, obj: mesh });
  });
  return out;
}

/** Representative NDC point of every pickable entity for `mode` (box-select, the
 * hover near-miss path, and the E2E candidate-px seam). The local points are cached
 * per part; only the camera projection runs per call, reusing one scratch vector. */
function selectionCandidates(
  part: BuiltPart,
  mode: SelectionMode,
  camera: THREE.Camera,
): { id: number; x: number; y: number }[] {
  let byMode = candidateCache.get(part);
  if (!byMode) {
    byMode = new Map();
    candidateCache.set(part, byMode);
  }
  let locals = byMode.get(mode);
  if (!locals) {
    locals = buildCandidateLocals(part, mode);
    byMode.set(mode, locals);
  }
  // Keep the solid's world matrix current for face/body centroids (matches the
  // pre-cache behaviour); edges/vertices ride r3f's per-frame matrix update.
  if (mode === "face" || mode === "body") part.mesh.updateWorldMatrix(true, false);
  const out: { id: number; x: number; y: number }[] = [];
  for (const cand of locals) {
    _project.copy(cand.local).applyMatrix4(cand.obj.matrixWorld).project(camera);
    out.push({ id: cand.id, x: _project.x, y: _project.y });
  }
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
  // Picker + GpuPicker shared with the right-click context menu (one GPU-id
  // render target / id-mesh build between them); ref-count-released on unmount.
  const pickers = useSharedPickers();

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
      return p ? pickers.gpu.pick(gl, camera, p, ndc) : null;
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
      let next = pickers.picker.pick(p, new THREE.Vector2(ndc.x, ndc.y), camera, mode);
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
        const wp = pickers.picker.pickPoint(p, new THREE.Vector2(ndc.x, ndc.y), camera);
        if (!wp) return; // clicked empty space — keep waiting for a point on the part
        const step = nextMeasure(measureFirstRef.current, wp);
        measureFirstRef.current = step.first;
        store.setMeasureResult(step.result);
        return;
      }
      const mode = store.selMode;
      let hit = pickers.picker.pick(p, new THREE.Vector2(ndc.x, ndc.y), camera, mode);
      // GPU-id fallback for face/body when the triangle raycast misses (NFR-4).
      if (!hit && (mode === "face" || mode === "body") && pickers.gpu.rayHitsPart(p, camera, ndc)) {
        const id = pickers.gpu.pick(gl, camera, p, ndc);
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

  // The shared GPU-id render target is freed by useSharedPickers when the LAST
  // consumer (this layer or the right-click menu) unmounts.

  return null;
}
