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
import {
  edgeEndpoint,
  nextMeasure,
  type MeasureEndpoint,
  vertexEndpoint,
  worldEndpoint,
} from "../viewport/measure.js";
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
const pickKey = (pick: Pick): string => `${pick.kind}:${pick.id}`;
const samePickKey = (a: Pick, b: Pick): boolean => pickKey(a) === pickKey(b);

function edgeEndpointVertexIds(part: BuiltPart, edge: THREE.LineSegments, tolerance = 1e-7): number[] {
  if (!part.vertexPoints) return [];
  const vertexIds = part.vertexPoints.userData["vertexIds"] as number[] | undefined;
  if (!vertexIds) return [];
  const edgePos = edge.geometry.getAttribute("position");
  const vertexPos = part.vertexPoints.geometry.getAttribute("position");
  const out = new Set<number>();
  const edgePoint = new THREE.Vector3();
  const vertexPoint = new THREE.Vector3();
  const endpoints = [0, edgePos.count - 1].filter((index, i, all) => index >= 0 && all.indexOf(index) === i);
  for (const endpoint of endpoints) {
    edgePoint.fromBufferAttribute(edgePos, endpoint);
    for (let i = 0; i < vertexPos.count; i++) {
      vertexPoint.fromBufferAttribute(vertexPos, i);
      if (edgePoint.distanceToSquared(vertexPoint) <= tolerance * tolerance) {
        const id = vertexIds[i];
        if (typeof id === "number") out.add(id);
      }
    }
  }
  return [...out];
}

export function completeBrepFacePicks(part: BuiltPart, picks: readonly Pick[]): Pick[] {
  const selectedEdges = new Set(picks.filter((pick) => pick.kind === "edge").map((pick) => pick.id));
  const selectedVertices = new Set(picks.filter((pick) => pick.kind === "vertex").map((pick) => pick.id));
  if (selectedEdges.size === 0) return [];
  const byFace = new Map<number, { edges: Set<number>; vertices: Set<number> }>();
  for (const edge of part.edges) {
    const edgeId = edge.userData["edgeId"];
    const faceIds = edge.userData["faceIds"] as readonly [number, number] | undefined;
    if (typeof edgeId !== "number" || !faceIds) continue;
    for (const faceId of new Set(faceIds.filter((id) => id >= 0))) {
      const entry = byFace.get(faceId) ?? { edges: new Set<number>(), vertices: new Set<number>() };
      entry.edges.add(edgeId);
      for (const vertexId of edgeEndpointVertexIds(part, edge)) entry.vertices.add(vertexId);
      byFace.set(faceId, entry);
    }
  }
  const out: Pick[] = [];
  for (const [faceId, boundary] of byFace) {
    if (boundary.edges.size === 0) continue;
    const allEdges = [...boundary.edges].every((edgeId) => selectedEdges.has(edgeId));
    const allVertices = [...boundary.vertices].every((vertexId) => selectedVertices.has(vertexId));
    if (allEdges && allVertices) out.push({ kind: "face", id: faceId });
  }
  return out;
}

export function Picking({ part }: { part: BuiltPart | null }): null {
  const gl = useThree((s) => s.gl);
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as { enabled: boolean } | null;
  const invalidate = useThree((s) => s.invalidate);

  // Refs so the long-lived DOM listeners always see the latest part/camera.
  const partRef = useRef<BuiltPart | null>(part);
  partRef.current = part;
  const hoverRef = useRef<Pick | null>(null);
  const autoFaceKeysRef = useRef(new Set<string>());
  const manualFaceKeysRef = useRef(new Set<string>());
  // The first measure endpoint banked by the tool (VertexRef / EdgeRef / world),
  // awaiting its second click (FR-13 + R12).
  const measureFirstRef = useRef<MeasureEndpoint | null>(null);
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

  const normalizeFaceClosure = (): boolean => {
    const p = partRef.current;
    if (!p) return false;
    const store = useCadStore.getState();
    const current = store.picks;
    const complete = completeBrepFacePicks(p, current);
    const completeKeys = new Set(complete.map(pickKey));
    const manualKeys = manualFaceKeysRef.current;
    const next = current.filter((pick) => {
      if (pick.kind !== "face") return true;
      const key = pickKey(pick);
      return !autoFaceKeysRef.current.has(key) || completeKeys.has(key) || manualKeys.has(key);
    });
    for (const face of complete) {
      const key = pickKey(face);
      if (!next.some((pick) => pickKey(pick) === key)) next.push(face);
    }
    autoFaceKeysRef.current = completeKeys;
    const same =
      current.length === next.length && current.every((pick, index) => pickKey(pick) === pickKey(next[index]!));
    if (!same) store.setPicks(next);
    return !same;
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
    autoFaceKeysRef.current.clear();
    manualFaceKeysRef.current.clear();
    normalizeFaceClosure();
    refreshHighlight();
    return useCadStore.subscribe((s, prev) => {
      if (s.picks !== prev.picks) {
        if (normalizeFaceClosure()) return;
        refreshHighlight();
      }
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
    const gpuFaceId = (pt: BuiltPart, ndc: { x: number; y: number }): number | null => {
      try {
        if (!pickers.gpu.rayHitsPart(pt, camera, ndc)) return null;
        return pickers.gpu.pick(gl, camera, pt, ndc);
      } catch {
        return null;
      }
    };
    const faceHit = (pt: BuiltPart, ndc: { x: number; y: number }): Pick | null => {
      let hit = pickers.picker.pick(pt, new THREE.Vector2(ndc.x, ndc.y), camera, "face");
      if (!hit) {
        const id = gpuFaceId(pt, ndc);
        if (id != null) hit = { kind: "face", id };
      }
      return hit;
    };
    const bodyHit = (pt: BuiltPart, ndc: { x: number; y: number }): Pick | null => {
      return gpuFaceId(pt, ndc) != null ? { kind: "body", id: 0 } : null;
    };
    // R5 — `selMode` is a real click filter. When a specific mode is set, only that
    // entity kind is considered (raycast + the 14 px screen-nearest fallback). When
    // mode is null (permissive / "all"), keep the historical priority cascade
    // vertex → edge → face so a bare click still lands on the most precise target.
    const entityHit = (
      pt: BuiltPart,
      mode: SelectionMode | null,
      ndc: { x: number; y: number },
    ): Pick | null => {
      if (mode === "body") return bodyHit(pt, ndc);
      if (mode === "vertex") {
        return (
          pickers.picker.pick(pt, new THREE.Vector2(ndc.x, ndc.y), camera, "vertex") ??
          screenNearest(pt, "vertex", ndc)
        );
      }
      if (mode === "edge") {
        return (
          pickers.picker.pick(pt, new THREE.Vector2(ndc.x, ndc.y), camera, "edge") ??
          screenNearest(pt, "edge", ndc)
        );
      }
      if (mode === "face") return faceHit(pt, ndc);
      // null / unknown → permissive cascade (vertex > edge > face).
      const v =
        pickers.picker.pick(pt, new THREE.Vector2(ndc.x, ndc.y), camera, "vertex") ??
        screenNearest(pt, "vertex", ndc);
      if (v) return v;
      const e =
        pickers.picker.pick(pt, new THREE.Vector2(ndc.x, ndc.y), camera, "edge") ??
        screenNearest(pt, "edge", ndc);
      if (e) return e;
      return faceHit(pt, ndc);
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
      const next = entityHit(p, mode, ndc);
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
            // Box-select needs a concrete entity kind; null mode falls back to face
            // (the CAD-standard multi-select target for rubber-band).
            const boxMode: SelectionMode = store.selMode ?? "face";
            const ids = boxSelect(
              ndcRect({ x: a.x, y: a.y }, { x: b.x, y: b.y }),
              selectionCandidates(p, boxMode, camera),
            );
            const picks: Pick[] =
              boxMode === "body"
                ? ids.length > 0
                  ? [{ kind: "body", id: 0 }]
                  : []
                : ids.map((id) => ({ kind: boxMode, id }));
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
      // Measure tool (FR-13 + R12): a click banks an endpoint under the cursor;
      // the second click resolves the distance + axis deltas. Vertex/edge hits
      // store VertexRef/EdgeRef analytic signatures (not bare pick indices);
      // surface hits fall back to a world point. Suppresses normal selection
      // while measuring is active.
      if (store.measuring) {
        // Prefer the entity cascade (vertex → edge → face) so a corner click
        // captures a VertexRef even when selMode is null / face.
        const hit = entityHit(p, store.selMode, ndc);
        let endpoint: MeasureEndpoint | null = null;
        if (hit?.kind === "vertex") {
          const ref = store.selectionRefs.vertices?.[hit.id];
          if (ref) endpoint = vertexEndpoint(ref);
        } else if (hit?.kind === "edge") {
          const ref = store.selectionRefs.edges[hit.id];
          if (ref) endpoint = edgeEndpoint(ref);
        }
        if (!endpoint) {
          const wp = pickers.picker.pickPoint(p, new THREE.Vector2(ndc.x, ndc.y), camera);
          if (!wp) return; // clicked empty space — keep waiting for a point on the part
          endpoint = worldEndpoint(wp);
        }
        const step = nextMeasure(measureFirstRef.current, endpoint);
        measureFirstRef.current = step.first;
        store.setMeasureResult(step.result);
        store.setMeasureEndpoints(
          step.a ? { a: step.a, b: step.b } : null,
        );
        return;
      }
      const hit = entityHit(p, store.selMode, ndc);
      if (hit) {
        if (hit.kind === "face") {
          const key = pickKey(hit);
          const exists = store.picks.some((pick) => samePickKey(pick, hit));
          if (additive && exists) manualFaceKeysRef.current.delete(key);
          else {
            if (!additive) manualFaceKeysRef.current = new Set([key]);
            else manualFaceKeysRef.current.add(key);
          }
        } else if (!additive) {
          manualFaceKeysRef.current.clear();
        }
        store.pick(hit, additive);
      } else if (!additive) {
        manualFaceKeysRef.current.clear();
        store.clearPicks();
      }
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
