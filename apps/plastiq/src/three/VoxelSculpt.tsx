// The voxel-sculpt viewport component (ADR-0010 wiring) — mounted by Scene.tsx's
// voxel branch the way Part.tsx is mounted for a B-rep part. Renders the open
// VoxelDoc and owns the sculpt interaction:
//
//   • RENDER — the grid's exposed-face SURFACE MESH (VoxelGrid.toMesh), one
//     BufferGeometry + one draw call. Chosen over instanced cubes because it is the
//     exact same tested geometry the Convert-to-CAD/GLB handoff exports (voxel/doc.ts),
//     faces are unshared so computeVertexNormals yields crisp per-face voxel shading,
//     and at the 64³ worst case (~25k exposed quads) it is trivially light. A dashed
//     work-volume box + the standard grid complete the stage.
//   • TOOLS — LEFT-click sculpts with the active tool (add on the hit face's empty
//     neighbour via rayVoxelHit; erase the hit voxel); holding ⌥/Alt inverts the tool
//     for that gesture; clicking empty space with Add places on the ground work plane
//     (rayWorkPlaneCell). Orbit lives on the RIGHT button in this mode (Scene.tsx).
//   • DRAG-TO-PAINT — shipped for both tools. An erase stroke re-picks the LIVE grid
//     each move (so it can carve inward). An add stroke picks against the grid FROZEN
//     at pointer-down, so painting across a surface lays ONE layer instead of
//     stacking towers toward the camera; the whole stroke folds into a single undo
//     step (the store's history:false live-write pattern).
//   • HOVER PREVIEW — a translucent cell at the would-be target (green add/red erase).
//   • UNDO/REDO — ⌘/Ctrl-Z (+Shift / Ctrl-Y) route to the sculpt history while this
//     component is mounted; a capture-phase listener stops the app-shell handler from
//     also undoing the (hidden) parametric document.

import { useEffect, useMemo, useState } from "react";
import * as THREE from "three";
import { useThree } from "@react-three/fiber";
import { useCadStore } from "../store/store.js";
import { useVoxelStore, sculptTarget, type SculptTarget, type VoxelTool } from "../voxel/voxelStore.js";
import { docToGrid } from "../voxel/doc.js";
import type { VoxelDoc } from "../store/types.js";
import type { V3 } from "../voxel/grid.js";

const VOXEL_COLOR = 0x9aa7c7;
const ADD_PREVIEW = 0x4eff8a;
const ERASE_PREVIEW = 0xff6b6b;
const BOUNDS_COLOR = 0x3a4a6a;

/** World-space centre of a grid cell. */
function cellCenter(doc: VoxelDoc, cell: readonly [number, number, number]): [number, number, number] {
  const s = doc.voxelSize;
  return [
    doc.origin[0] + (cell[0] + 0.5) * s,
    doc.origin[1] + (cell[1] + 0.5) * s,
    doc.origin[2] + (cell[2] + 0.5) * s,
  ];
}

/** The effective tool for a gesture: ⌥/Alt inverts the active tool (add ⇄ erase). */
function effectiveTool(tool: VoxelTool, altKey: boolean): VoxelTool {
  if (!altKey) return tool;
  return tool === "add" ? "erase" : "add";
}

export function VoxelSculpt(): React.JSX.Element | null {
  const doc = useVoxelStore((s) => s.doc);
  const gl = useThree((s) => s.gl);
  const camera = useThree((s) => s.camera);
  const invalidate = useThree((s) => s.invalidate);
  const [hover, setHover] = useState<SculptTarget | null>(null);

  // Surface mesh of the occupancy grid — rebuilt per document edit, disposed on swap.
  const geometry = useMemo(() => {
    if (!doc) return null;
    const m = docToGrid(doc).toMesh();
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(m.vertices), 3));
    g.setIndex(new THREE.BufferAttribute(new Uint32Array(m.indices), 1));
    g.computeVertexNormals(); // faces are unshared → per-face normals (crisp voxels)
    return g;
  }, [doc]);
  useEffect(() => {
    invalidate(); // frameloop-safe: repaint on each rebuilt surface
    return () => geometry?.dispose();
  }, [geometry, invalidate]);

  // The sculpting work volume, as a dashed-looking edge box (helps aim the first
  // clicks at the ground plane inside it).
  const bounds = useMemo(() => {
    if (!doc) return null;
    const size: [number, number, number] = [
      doc.dims[0] * doc.voxelSize,
      doc.dims[1] * doc.voxelSize,
      doc.dims[2] * doc.voxelSize,
    ];
    const box = new THREE.BoxGeometry(...size);
    const edges = new THREE.EdgesGeometry(box);
    box.dispose();
    const center: [number, number, number] = [
      doc.origin[0] + size[0] / 2,
      doc.origin[1] + size[1] / 2,
      doc.origin[2] + size[2] / 2,
    ];
    return { edges, center };
  }, [doc]);
  useEffect(() => () => bounds?.edges.dispose(), [bounds]);

  // Pointer interaction on the shared canvas — refs-free: handlers read the stores
  // directly so they never see stale state.
  useEffect(() => {
    const el = gl.domElement;
    // Non-null while a LEFT-drag stroke is active. `frozen` is the grid snapshot an
    // ADD stroke picks against (see header); `painted` dedupes per-stroke cells;
    // `first` makes only the stroke's first edit push an undo snapshot.
    let stroke: { tool: VoxelTool; frozen: VoxelDoc; painted: Set<string>; first: boolean } | null =
      null;

    const rayFor = (e: PointerEvent): { origin: V3; dir: V3 } => {
      const r = el.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((e.clientX - r.left) / r.width) * 2 - 1,
        -(((e.clientY - r.top) / r.height) * 2 - 1),
      );
      const rc = new THREE.Raycaster();
      rc.setFromCamera(ndc, camera);
      const { origin, direction } = rc.ray;
      return { origin: [origin.x, origin.y, origin.z], dir: [direction.x, direction.y, direction.z] };
    };

    /** Apply one stroke sample; returns whether an edit landed. */
    const applyAt = (e: PointerEvent): boolean => {
      const s = useVoxelStore.getState();
      if (!s.doc || !stroke) return false;
      const { origin, dir } = rayFor(e);
      // Erase re-picks the live grid (carves); add picks the stroke-frozen grid
      // (paints one layer, never towers).
      const pickDoc = stroke.tool === "erase" ? s.doc : stroke.frozen;
      const target = sculptTarget(pickDoc, stroke.tool, origin, dir);
      if (!target) return false;
      const key = target.cell.join(",");
      if (stroke.painted.has(key)) return false;
      stroke.painted.add(key);
      s.setCell(target.cell, target.kind === "add", { history: stroke.first });
      stroke.first = false;
      useCadStore.getState().setStatus(`sculpt · ${useVoxelStore.getState().doc?.cells.length ?? 0} voxels`);
      return true;
    };

    const onDown = (e: PointerEvent): void => {
      if (e.button !== 0) return; // LEFT sculpts; right/middle are orbit/pan
      const s = useVoxelStore.getState();
      if (!s.doc) return;
      stroke = {
        tool: effectiveTool(s.tool, e.altKey),
        frozen: s.doc,
        painted: new Set(),
        first: true,
      };
      // Keep receiving the stroke's moves even when the pointer leaves the canvas.
      // Guarded: synthetic events (tests/jsdom) carry no live pointer id.
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* no live pointer (synthetic event) — stroke still works over the canvas */
      }
      applyAt(e);
      setHover(null);
    };

    const onMove = (e: PointerEvent): void => {
      if (stroke) {
        applyAt(e);
        return;
      }
      // Idle hover: preview what a click would do with the current (alt-aware) tool.
      const s = useVoxelStore.getState();
      if (!s.doc) return;
      const { origin, dir } = rayFor(e);
      setHover(sculptTarget(s.doc, effectiveTool(s.tool, e.altKey), origin, dir));
    };

    const onUp = (e: PointerEvent): void => {
      if (!stroke) return;
      stroke = null;
      // Guarded like setPointerCapture above: synthetic events carry no live pointer.
      try {
        if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
      } catch {
        /* no live pointer (synthetic event) — nothing to release */
      }
    };

    const onLeave = (): void => setHover(null);

    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointerleave", onLeave);
    return () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointerleave", onLeave);
    };
  }, [gl, camera]);

  // ⌘/Ctrl-Z (+Shift) and Ctrl-Y → the SCULPT history while a voxel doc is being
  // edited. Capture phase + stopImmediatePropagation so the app shell's global
  // handler (which routes to the parametric document history) does not also fire.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!useVoxelStore.getState().doc) return;
      const t = e.target as HTMLElement | null;
      const typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
      if (typing) return;
      const z = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z";
      const y = e.ctrlKey && e.key.toLowerCase() === "y";
      if (!z && !y) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const vox = useVoxelStore.getState();
      if (y || (z && e.shiftKey)) vox.redo();
      else vox.undo();
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, []);

  if (!doc) return null;
  const previewCenter = hover ? cellCenter(doc, hover.cell) : null;
  return (
    <group name="voxel-sculpt">
      {geometry && (
        <mesh name="voxel-surface" geometry={geometry}>
          <meshStandardMaterial color={VOXEL_COLOR} metalness={0.05} roughness={0.75} />
        </mesh>
      )}
      {bounds && (
        <lineSegments name="voxel-bounds" geometry={bounds.edges} position={bounds.center}>
          <lineBasicMaterial color={BOUNDS_COLOR} />
        </lineSegments>
      )}
      {hover && previewCenter && (
        <mesh name="voxel-preview" position={previewCenter}>
          <boxGeometry args={[doc.voxelSize, doc.voxelSize, doc.voxelSize]} />
          <meshStandardMaterial
            color={hover.kind === "add" ? ADD_PREVIEW : ERASE_PREVIEW}
            transparent
            opacity={0.45}
            depthWrite={false}
          />
        </mesh>
      )}
    </group>
  );
}
