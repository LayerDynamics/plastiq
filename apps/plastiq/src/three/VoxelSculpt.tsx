// The voxel-sculpt viewport component (ADR-0010 wiring) — mounted by Scene.tsx's
// voxel branch the way Part.tsx is mounted for a B-rep part. Renders the open
// VoxelDoc and owns the sculpt interaction:
//
//   • RENDER — voxelDocToMesh, the SAME surface the Convert-to-CAD/GLB handoff
//     exports. Legacy occupancy documents retain their exposed cube faces; v2 SDF
//     documents render the smooth marching-cubes surface that the brushes edit.
//   • TOOLS — LEFT-click sculpts with the active tool:
//       - add/erase: single-cell occupancy (Alt inverts); empty-space Add uses the
//         ground work plane (rayWorkPlaneCell).
//       - SDF brushes (draw/clay/smooth/flatten/inflate/pinch/grab): ray → world
//         centre → applyBrushToDoc (§16). Grab uses the stroke drag delta.
//     Orbit lives on the RIGHT button in this mode (Scene.tsx).
//   • DRAG-TO-PAINT — cell tools: erase re-picks the LIVE grid; add picks a FROZEN
//     stroke-start grid (one layer, no towers). Brush tools re-sample every move
//     with history:false after the first dab so a stroke is one undo step.
//   • HOVER PREVIEW — translucent cell (add/erase) or brush-radius sphere (brushes).
//   • UNDO/REDO — ⌘/Ctrl-Z (+Shift / Ctrl-Y) route to the sculpt history while this
//     component is mounted; a capture-phase listener stops the app-shell handler from
//     also undoing the (hidden) parametric document.

import { useEffect, useMemo, useState } from "react";
import * as THREE from "three";
import { useThree } from "@react-three/fiber";
import { useCadStore } from "../store/store.js";
import {
  useVoxelStore,
  sculptTarget,
  isBrushTool,
  brushCenterAt,
  type SculptTarget,
  type VoxelTool,
} from "../voxel/voxelStore.js";
import { voxelDocToMesh } from "../voxel/doc.js";
import type { VoxelDoc } from "../store/types.js";
import type { V3 } from "../voxel/grid.js";

const VOXEL_COLOR = 0x9aa7c7;
const ADD_PREVIEW = 0x4eff8a;
const ERASE_PREVIEW = 0xff6b6b;
const BRUSH_PREVIEW = 0x6ec8ff;
const BOUNDS_COLOR = 0x3a4a6a;

/** World-space centre of a grid cell. */
function cellCenter(
  doc: VoxelDoc,
  cell: readonly [number, number, number],
): [number, number, number] {
  const s = doc.voxelSize;
  return [
    doc.origin[0] + (cell[0] + 0.5) * s,
    doc.origin[1] + (cell[1] + 0.5) * s,
    doc.origin[2] + (cell[2] + 0.5) * s,
  ];
}

/** The effective tool for a gesture: ⌥/Alt inverts add ⇄ erase (brushes unchanged). */
function effectiveTool(tool: VoxelTool, altKey: boolean): VoxelTool {
  if (!altKey || isBrushTool(tool)) return tool;
  return tool === "add" ? "erase" : "add";
}

type CellStroke = {
  kind: "cell";
  tool: "add" | "erase";
  frozen: VoxelDoc;
  painted: Set<string>;
  first: boolean;
};

type BrushStroke = {
  kind: "brush";
  tool: Exclude<VoxelTool, "add" | "erase">;
  /** World centre at pointer-down (grab delta is relative to this). */
  startCenter: V3 | null;
  lastCenter: V3 | null;
  first: boolean;
};

type Stroke = CellStroke | BrushStroke;

export function VoxelSculpt(): React.JSX.Element | null {
  const doc = useVoxelStore((s) => s.doc);
  const gl = useThree((s) => s.gl);
  const camera = useThree((s) => s.camera);
  const invalidate = useThree((s) => s.invalidate);
  /** Cell-tool hover target, or a brush world-centre for the radius sphere preview. */
  const [hover, setHover] = useState<(SculptTarget & { brushCenter?: V3 }) | null>(null);

  // Authoritative sculpt surface — legacy cube faces or v2 marching cubes. Rebuilt
  // per document edit and shared exactly with conversion/export.
  const geometry = useMemo(() => {
    if (!doc) return null;
    const m = voxelDocToMesh(doc);
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
    // Non-null while a LEFT-drag stroke is active.
    let stroke: Stroke | null = null;

    const rayFor = (e: PointerEvent): { origin: V3; dir: V3 } => {
      const r = el.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((e.clientX - r.left) / r.width) * 2 - 1,
        -(((e.clientY - r.top) / r.height) * 2 - 1),
      );
      const rc = new THREE.Raycaster();
      rc.setFromCamera(ndc, camera);
      const { origin, direction } = rc.ray;
      return {
        origin: [origin.x, origin.y, origin.z],
        dir: [direction.x, direction.y, direction.z],
      };
    };

    /** Apply one stroke sample; returns whether an edit landed. */
    const applyAt = (e: PointerEvent): boolean => {
      const s = useVoxelStore.getState();
      if (!s.doc || !stroke) return false;
      const { origin, dir } = rayFor(e);

      if (stroke.kind === "brush") {
        const center = brushCenterAt(s.doc, origin, dir);
        if (!center) return false;
        if (!stroke.startCenter) stroke.startCenter = center;
        const delta: V3 | undefined =
          stroke.tool === "grab" && stroke.startCenter
            ? [
                center[0] - stroke.startCenter[0],
                center[1] - stroke.startCenter[1],
                center[2] - stroke.startCenter[2],
              ]
            : undefined;
        // Grab applies delta from stroke start at the current centre each move;
        // other brushes stamp at the live centre.
        const applied = s.sculptBrushAt(
          origin,
          dir,
          {
            type: stroke.tool,
            radius: s.brushRadius,
            strength: s.brushStrength,
            mirror: s.mirrorAxes.flatMap((enabled, axis) =>
              enabled
                ? [
                    {
                      axis: axis as 0 | 1 | 2,
                      coord: s.doc!.origin[axis]! + (s.doc!.dims[axis]! * s.doc!.voxelSize) / 2,
                    },
                  ]
                : [],
            ),
            ...(delta ? { delta } : {}),
          },
          { history: stroke.first },
        );
        if (!applied) return false;
        stroke.lastCenter = center;
        stroke.first = false;
        useCadStore
          .getState()
          .setStatus(
            `sculpt · ${stroke.tool} · ${useVoxelStore.getState().doc?.cells.length ?? 0} voxels`,
          );
        return true;
      }

      // Cell tools: erase re-picks the live grid (carves); add picks the stroke-frozen
      // grid (paints one layer, never towers).
      const pickDoc = stroke.tool === "erase" ? s.doc : stroke.frozen;
      const target = sculptTarget(pickDoc, stroke.tool, origin, dir);
      if (!target) return false;
      const key = target.cell.join(",");
      if (stroke.painted.has(key)) return false;
      stroke.painted.add(key);
      s.setCell(target.cell, target.kind === "add", { history: stroke.first });
      stroke.first = false;
      useCadStore
        .getState()
        .setStatus(`sculpt · ${useVoxelStore.getState().doc?.cells.length ?? 0} voxels`);
      return true;
    };

    const onDown = (e: PointerEvent): void => {
      if (e.button !== 0) return; // LEFT sculpts; right/middle are orbit/pan
      const s = useVoxelStore.getState();
      if (!s.doc) return;
      const tool = effectiveTool(s.tool, e.altKey);
      if (isBrushTool(tool)) {
        stroke = { kind: "brush", tool, startCenter: null, lastCenter: null, first: true };
      } else {
        stroke = {
          kind: "cell",
          tool,
          frozen: s.doc,
          painted: new Set(),
          first: true,
        };
      }
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
      const tool = effectiveTool(s.tool, e.altKey);
      if (isBrushTool(tool)) {
        const c = brushCenterAt(s.doc, origin, dir);
        setHover(c ? { cell: [0, 0, 0], kind: "add", brushCenter: c } : null);
        return;
      }
      setHover(sculptTarget(s.doc, tool, origin, dir));
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
      const typing =
        t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
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

  const brushRadius = useVoxelStore((s) => s.brushRadius);
  const activeTool = useVoxelStore((s) => s.tool);

  if (!doc) return null;
  const brushPreview = hover?.brushCenter;
  const cellPreview = hover && !hover.brushCenter ? cellCenter(doc, hover.cell) : null;
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
      {cellPreview && hover && (
        <mesh name="voxel-preview" position={cellPreview}>
          <boxGeometry args={[doc.voxelSize, doc.voxelSize, doc.voxelSize]} />
          <meshStandardMaterial
            color={hover.kind === "add" ? ADD_PREVIEW : ERASE_PREVIEW}
            transparent
            opacity={0.45}
            depthWrite={false}
          />
        </mesh>
      )}
      {brushPreview && isBrushTool(activeTool) && (
        <mesh name="voxel-brush-preview" position={brushPreview}>
          <sphereGeometry args={[brushRadius, 16, 12]} />
          <meshStandardMaterial
            color={BRUSH_PREVIEW}
            transparent
            opacity={0.25}
            depthWrite={false}
          />
        </mesh>
      )}
    </group>
  );
}
