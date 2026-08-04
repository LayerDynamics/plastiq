import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { TransformControls } from "@react-three/drei";
import { useThree } from "@react-three/fiber";
import { useCadStore } from "../store/store.js";
import type { Pick, SelectionMode } from "../store/types.js";
import type { MeshBody } from "../mesh/meshBody.js";
import type { BuiltMeshBody } from "../viewport/buildMesh.js";
import { applyMeshHighlight } from "../viewport/meshHighlight.js";
import {
  cloneMeshSelection,
  completeMeshFacePicks,
  displaceMeshVertices,
  encodeMeshPick,
  isotropicRemesh,
  meshFaces,
  meshSegments,
  meshSelectionVertices,
  quadricDecimate,
  smoothMeshCotangent,
  transformMeshSelection,
} from "../mesh/editMesh.js";

interface Candidate {
  kind: SelectionMode;
  id: number;
  world: THREE.Vector3;
}

interface MeshEditGlobal {
  cloneSelection?: () => void;
  inflateSelection?: () => void;
  smoothSelection?: () => void;
  remesh?: () => void;
  decimate?: () => void;
}

const CLICK_TOL_PX = 4;
const NEAR_TOL_PX = 14;
const CLONE_OFFSET: [number, number, number] = [0.01, 0.01, 0];
const pickKey = (pick: Pick): string => `${pick.kind}:${pick.id}`;

function meshCandidates(
  bodies: readonly MeshBody[],
  built: readonly BuiltMeshBody[],
  mode: SelectionMode,
): Candidate[] {
  const out: Candidate[] = [];
  const v = new THREE.Vector3();
  bodies.forEach((body, bodyIndex) => {
    const rendered = built[bodyIndex];
    if (!rendered) return;
    if (mode === "vertex") {
      const pos = rendered.vertexPoints.geometry.getAttribute("position");
      for (let i = 0; i < pos.count; i++) {
        out.push({
          kind: "vertex",
          id: encodeMeshPick(bodyIndex, i),
          world: new THREE.Vector3()
            .fromBufferAttribute(pos, i)
            .applyMatrix4(rendered.vertexPoints.matrixWorld),
        });
      }
      return;
    }
    if (mode === "edge") {
      meshSegments(body).forEach((seg, i) => {
        const a = seg.a * 3;
        const b = seg.b * 3;
        out.push({
          kind: "edge",
          id: encodeMeshPick(bodyIndex, i),
          world: new THREE.Vector3(
            (body.positions[a]! + body.positions[b]!) / 2,
            (body.positions[a + 1]! + body.positions[b + 1]!) / 2,
            (body.positions[a + 2]! + body.positions[b + 2]!) / 2,
          ),
        });
      });
      return;
    }
    if (mode === "face") {
      meshFaces(body).forEach((face, i) => {
        const c = new THREE.Vector3();
        for (const vertex of face.vertices) {
          const a = vertex * 3;
          c.add(new THREE.Vector3(body.positions[a], body.positions[a + 1], body.positions[a + 2]));
        }
        out.push({
          kind: "face",
          id: encodeMeshPick(bodyIndex, i),
          world: c.multiplyScalar(1 / 3),
        });
      });
      return;
    }
    if (mode === "body") {
      const pos = rendered.mesh.geometry.getAttribute("position");
      if (pos.count === 0) return;
      const c = new THREE.Vector3();
      for (let i = 0; i < pos.count; i++) c.add(v.fromBufferAttribute(pos, i));
      c.multiplyScalar(1 / pos.count);
      out.push({
        kind: "body",
        id: encodeMeshPick(bodyIndex, 0),
        world: c.applyMatrix4(rendered.mesh.matrixWorld),
      });
    }
  });
  return out;
}

function selectedCenter(bodies: readonly MeshBody[], picks: readonly Pick[]): THREE.Vector3 | null {
  const selected = meshSelectionVertices(bodies, picks);
  if (selected.size === 0) return null;
  const center = new THREE.Vector3();
  let count = 0;
  for (const [bodyIndex, verts] of selected) {
    const body = bodies[bodyIndex];
    if (!body) continue;
    for (const vertex of verts) {
      const i = vertex * 3;
      center.add(
        new THREE.Vector3(body.positions[i], body.positions[i + 1], body.positions[i + 2]),
      );
      count++;
    }
  }
  return count === 0 ? null : center.multiplyScalar(1 / count);
}

export function MeshEditing({
  bodies,
  builtBodies,
  onBodiesChange,
}: {
  bodies: MeshBody[];
  builtBodies: BuiltMeshBody[];
  onBodiesChange: (bodies: MeshBody[], persist?: boolean) => void;
}): React.JSX.Element | null {
  const gl = useThree((s) => s.gl);
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as { enabled: boolean } | null;
  const invalidate = useThree((s) => s.invalidate);
  const picks = useCadStore((s) => s.picks);
  const gizmoMode = useCadStore((s) => s.gizmoMode);
  const anchor = useMemo(() => new THREE.Object3D(), []);
  const bodiesRef = useRef(bodies);
  const builtRef = useRef(builtBodies);
  const hoverRef = useRef<Pick | null>(null);
  const draggingRef = useRef(false);
  const lastMatrix = useRef(new THREE.Matrix4());
  const autoFaceKeysRef = useRef(new Set<string>());
  const manualFaceKeysRef = useRef(new Set<string>());
  bodiesRef.current = bodies;
  builtRef.current = builtBodies;

  const normalizeFaceClosure = (): boolean => {
    const store = useCadStore.getState();
    const current = store.picks;
    const complete = completeMeshFacePicks(bodiesRef.current, current);
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
      current.length === next.length &&
      current.every((pick, index) => pickKey(pick) === pickKey(next[index]!));
    if (!same) store.setPicks(next);
    return !same;
  };

  const refreshHighlight = (): void => {
    applyMeshHighlight(builtRef.current, useCadStore.getState().picks, hoverRef.current);
    invalidate();
  };

  useEffect(() => {
    normalizeFaceClosure();
    refreshHighlight();
    return useCadStore.subscribe((s, prev) => {
      if (s.picks !== prev.picks) {
        if (normalizeFaceClosure()) return;
        refreshHighlight();
      }
    });
  }, [builtBodies]);

  useEffect(() => {
    if (draggingRef.current) return;
    const center = selectedCenter(bodies, picks);
    if (center) {
      anchor.position.copy(center);
      anchor.quaternion.identity();
      anchor.scale.set(1, 1, 1);
      anchor.updateMatrixWorld(true);
      lastMatrix.current.copy(anchor.matrixWorld);
    }
  }, [anchor, bodies, picks]);

  useEffect(() => {
    const el = gl.domElement;
    const raycaster = new THREE.Raycaster();
    const ndcFrom = (cx: number, cy: number): THREE.Vector2 => {
      const r = el.getBoundingClientRect();
      return new THREE.Vector2(
        ((cx - r.left) / r.width) * 2 - 1,
        -(((cy - r.top) / r.height) * 2 - 1),
      );
    };
    const nearest = (mode: SelectionMode, ndc: THREE.Vector2): Pick | null => {
      const w = el.clientWidth || 1;
      const h = el.clientHeight || 1;
      const cx = ((ndc.x + 1) / 2) * w;
      const cy = ((1 - ndc.y) / 2) * h;
      let best: Pick | null = null;
      let bestD = NEAR_TOL_PX;
      for (const c of meshCandidates(bodiesRef.current, builtRef.current, mode)) {
        const projected = c.world.clone().project(camera);
        const d = Math.hypot(((projected.x + 1) / 2) * w - cx, ((1 - projected.y) / 2) * h - cy);
        if (d < bestD) {
          bestD = d;
          best = { kind: c.kind as Pick["kind"], id: c.id };
        }
      }
      return best;
    };
    const rayBody = (ndc: THREE.Vector2): Pick | null => {
      raycaster.setFromCamera(ndc, camera);
      const hits = raycaster.intersectObjects(
        builtRef.current.map((b) => b.mesh),
        false,
      );
      const hit = hits[0]?.object;
      const body = hit ? builtRef.current.findIndex((b) => b.mesh === hit) : -1;
      return body >= 0 ? { kind: "body", id: encodeMeshPick(body, 0) } : null;
    };
    const rayFace = (ndc: THREE.Vector2): Pick | null => {
      raycaster.setFromCamera(ndc, camera);
      const hits = raycaster.intersectObjects(
        builtRef.current.map((b) => b.mesh),
        false,
      );
      const hit = hits[0];
      if (!hit || hit.faceIndex == null) return null;
      const body = builtRef.current.findIndex((b) => b.mesh === hit.object);
      return body >= 0 ? { kind: "face", id: encodeMeshPick(body, hit.faceIndex) } : null;
    };
    // R5 — same contract as Picking.entityHit: null = permissive cascade;
    // face/edge/vertex/body = strict filter.
    const entityHit = (mode: SelectionMode | null, ndc: THREE.Vector2): Pick | null => {
      if (mode === "body") return rayBody(ndc);
      if (mode === "vertex") return nearest("vertex", ndc);
      if (mode === "edge") return nearest("edge", ndc);
      if (mode === "face") return rayFace(ndc) ?? nearest("face", ndc);
      return nearest("vertex", ndc) ?? nearest("edge", ndc) ?? rayFace(ndc) ?? nearest("face", ndc);
    };
    let downAt: { x: number; y: number } | null = null;
    const onDown = (e: PointerEvent): void => {
      downAt = { x: e.clientX, y: e.clientY };
    };
    const onMove = (e: PointerEvent): void => {
      const ndc = ndcFrom(e.clientX, e.clientY);
      const next = entityHit(useCadStore.getState().selMode, ndc);
      if (next?.id !== hoverRef.current?.id || next?.kind !== hoverRef.current?.kind) {
        hoverRef.current = next;
        refreshHighlight();
      }
    };
    const onUp = (e: PointerEvent): void => {
      if (!downAt) return;
      const dist = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
      downAt = null;
      if (dist > CLICK_TOL_PX) return;
      const store = useCadStore.getState();
      const additive = e.shiftKey || e.ctrlKey || e.metaKey;
      const ndc = ndcFrom(e.clientX, e.clientY);
      const hit = entityHit(store.selMode, ndc);
      if (hit) {
        if (hit.kind === "face") {
          const key = pickKey(hit);
          const exists = store.picks.some((pick) => pickKey(pick) === key);
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
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [camera, gl]);

  useEffect(() => {
    const cloneSelection = (): void => {
      const current = bodiesRef.current;
      const selected = useCadStore.getState().picks;
      if (selected.length === 0) return;
      const next = cloneMeshSelection(current, selected, CLONE_OFFSET);
      bodiesRef.current = next;
      onBodiesChange(next, true);
      useCadStore.getState().setStatus("mesh selection cloned");
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key.toLowerCase() !== "d" || (!e.metaKey && !e.ctrlKey)) return;
      if (useCadStore.getState().picks.length === 0) return;
      e.preventDefault();
      cloneSelection();
    };
    const vp = ((globalThis as { __plastiqMeshEdit?: MeshEditGlobal }).__plastiqMeshEdit ??= {});
    vp.cloneSelection = cloneSelection;
    vp.inflateSelection = () => {
      const current = bodiesRef.current;
      const selected = meshSelectionVertices(current, useCadStore.getState().picks);
      if (selected.size === 0) return;
      const next = current.map((body, bodyIndex) => {
        const vertices = selected.get(bodyIndex);
        if (!vertices || vertices.size === 0) return body;
        const center = new THREE.Vector3();
        const point = new THREE.Vector3();
        for (const vertex of vertices) {
          center.add(point.fromArray(body.positions, vertex * 3));
        }
        center.multiplyScalar(1 / vertices.size);
        let radius = 0;
        for (const vertex of vertices) {
          point.fromArray(body.positions, vertex * 3);
          radius = Math.max(radius, point.distanceTo(center));
        }
        radius = Math.max(radius * 1.5, 0.002);
        return displaceMeshVertices(body, {
          center: [center.x, center.y, center.z],
          radius,
          strength: radius * 0.15,
        });
      });
      bodiesRef.current = next;
      onBodiesChange(next, true);
      useCadStore.getState().setStatus("mesh selection inflated");
    };
    vp.smoothSelection = () => {
      const current = bodiesRef.current;
      const selected = meshSelectionVertices(current, useCadStore.getState().picks);
      const next = current.map((body, bodyIndex) =>
        smoothMeshCotangent(body, {
          iterations: 2,
          lambda: 0.35,
          ...(selected.get(bodyIndex)?.size
            ? { selection: selected.get(bodyIndex)! }
            : selected.size === 0
              ? {}
              : { selection: [] }),
        }),
      );
      bodiesRef.current = next;
      onBodiesChange(next, true);
      useCadStore.getState().setStatus("mesh smoothed");
    };
    vp.remesh = () => {
      const next = bodiesRef.current.map((body) => {
        const box = new THREE.Box3();
        const point = new THREE.Vector3();
        for (let i = 0; i < body.positions.length; i += 3) {
          box.expandByPoint(point.fromArray(body.positions, i));
        }
        const extent = box.getSize(new THREE.Vector3()).length();
        return isotropicRemesh(body, {
          targetEdgeLength: Math.max(extent / 35, 1e-5),
          iterations: 2,
        });
      });
      bodiesRef.current = next;
      onBodiesChange(next, true);
      useCadStore.getState().setStatus("mesh remeshed uniformly");
    };
    vp.decimate = () => {
      const next = bodiesRef.current.map((body) => quadricDecimate(body, { targetRatio: 0.5 }));
      bodiesRef.current = next;
      onBodiesChange(next, true);
      useCadStore.getState().setStatus("mesh decimated to 50%");
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      delete vp.cloneSelection;
      delete vp.inflateSelection;
      delete vp.smoothSelection;
      delete vp.remesh;
      delete vp.decimate;
    };
  }, [onBodiesChange]);

  if (!selectedCenter(bodies, picks)) return null;
  return (
    <TransformControls
      object={anchor}
      mode={gizmoMode}
      onMouseDown={() => {
        draggingRef.current = true;
        anchor.updateMatrixWorld(true);
        lastMatrix.current.copy(anchor.matrixWorld);
        if (controls) controls.enabled = false;
      }}
      onObjectChange={() => {
        if (!draggingRef.current) return;
        anchor.updateMatrixWorld(true);
        const deltaMatrix = anchor.matrixWorld
          .clone()
          .multiply(lastMatrix.current.clone().invert());
        if (deltaMatrix.equals(new THREE.Matrix4())) return;
        lastMatrix.current.copy(anchor.matrixWorld);
        const next = transformMeshSelection(
          bodiesRef.current,
          useCadStore.getState().picks,
          deltaMatrix.elements,
        );
        bodiesRef.current = next;
        onBodiesChange(next);
      }}
      onMouseUp={() => {
        draggingRef.current = false;
        if (controls) controls.enabled = true;
        anchor.quaternion.identity();
        anchor.scale.set(1, 1, 1);
        onBodiesChange(bodiesRef.current, true);
      }}
    />
  );
}
