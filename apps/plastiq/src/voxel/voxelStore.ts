// The voxel-sculpt document store (ADR-0010 wiring). Holds the OPEN voxel document —
// the single live authority, parallel to projectsStore.activeMeshDoc for mesh docs —
// plus the active sculpt tool and an undo/redo history.
//
// §16: the history is now SPARSE DIFFS (voxel/sculptUndo.ts), not full-grid snapshots —
// every edit (single-cell add/erase OR an SDF brush stroke) records only its changed
// cells/field runs, so undo survives real sculpt resolutions. `past`/`future` stay
// arrays (their `.length` still gates the ribbon's undo/redo), and undo/redo still
// exactly restore the prior document.
//
// Edits are immutable VoxelDoc → VoxelDoc transforms, so persistence/autosave subscribe
// to `doc` identity changes exactly as they do for `features`/`params` on the cad store.
// The ray-driven entry points (`sculptAt` for add/erase, `sculptBrushAt` for brushes)
// are pure math over voxel/pick.ts, so the whole click→cell→edit path unit-tests in Node.

import { create } from "zustand";
import type { VoxelDoc } from "../store/types.js";
import { docToGrid } from "./doc.js";
import { rayVoxelHit, rayWorkPlaneCell } from "./pick.js";
import type { V3 } from "./grid.js";
import { applyBrushToDoc, type BrushSpec, type BrushType, BRUSH_TYPES } from "./brushes.js";
import { computeDiff, revertDiff, applyDiff, isEmptyDiff, type SculptDiff } from "./sculptUndo.js";

/**
 * Active sculpt tool. `"add"` / `"erase"` are single-cell occupancy tools;
 * any {@link BrushType} is an SDF brush stroke (draw/clay/smooth/…).
 */
export type VoxelTool = "add" | "erase" | BrushType;

/** True when `tool` is one of the seven §16 SDF brushes (not cell add/erase). */
export function isBrushTool(tool: VoxelTool): tool is BrushType {
  return (BRUSH_TYPES as readonly string[]).includes(tool);
}

export type { BrushType };
export { BRUSH_TYPES };

/** A resolved sculpt target: the cell an edit would touch and what it would do. */
export interface SculptTarget {
  cell: [number, number, number];
  kind: VoxelTool;
}

/** Max retained undo steps — matches the cad store's HISTORY_LIMIT. */
const HISTORY_LIMIT = 100;

/** Linear cell index in a doc's grid (`(z·ny + y)·nx + x`, the VoxelDoc convention). */
function cellIndex(doc: VoxelDoc, x: number, y: number, z: number): number {
  return (z * doc.dims[1] + y) * doc.dims[0] + x;
}

function inBounds(doc: VoxelDoc, x: number, y: number, z: number): boolean {
  return x >= 0 && y >= 0 && z >= 0 && x < doc.dims[0] && y < doc.dims[1] && z < doc.dims[2];
}

/**
 * Resolve what a sculpt ray would do to `doc` with `tool`, WITHOUT applying it —
 * shared by the click handler (apply) and the hover preview (show). Pure.
 *
 *  • add:   first occupied cell hit → the empty neighbour through the hit face;
 *           no voxel hit → the ground-plane cell under the ray (place on the floor).
 *  • erase: first occupied cell hit → that cell; no hit → nothing to erase.
 */
export function sculptTarget(
  doc: VoxelDoc,
  tool: VoxelTool,
  origin: V3,
  dir: V3,
): SculptTarget | null {
  // Cell-tool path only; SDF brushes resolve a world centre via brushCenterAt.
  if (isBrushTool(tool)) return null;
  const grid = docToGrid(doc);
  const hit = rayVoxelHit(grid, origin, dir);
  if (tool === "erase") {
    return hit ? { cell: hit.cell, kind: "erase" } : null;
  }
  if (hit) {
    const cell: [number, number, number] = [
      hit.cell[0] + hit.normal[0],
      hit.cell[1] + hit.normal[1],
      hit.cell[2] + hit.normal[2],
    ];
    // The adjacent cell may be outside the grid (sculpting off an outer face) —
    // nothing to add there; the grid is the sculpting volume.
    return inBounds(doc, cell[0], cell[1], cell[2]) ? { cell, kind: "add" } : null;
  }
  // Empty click: place on the ground work plane (the grid's base, z = origin.z).
  const cell = rayWorkPlaneCell(grid, origin, dir, {
    point: [doc.origin[0], doc.origin[1], doc.origin[2]],
    normal: [0, 0, 1],
  });
  return cell ? { cell, kind: "add" } : null;
}

/**
 * Resolve the WORLD-space centre a brush ray hits: the surface voxel the ray enters, or
 * the ground work-plane cell on a miss. `null` when the ray hits neither. Pure — used by
 * the (deferred) brush pointer wiring and unit-tested directly.
 */
export function brushCenterAt(doc: VoxelDoc, origin: V3, dir: V3): V3 | null {
  const grid = docToGrid(doc);
  const hit = rayVoxelHit(grid, origin, dir);
  const cell =
    hit?.cell ??
    rayWorkPlaneCell(grid, origin, dir, {
      point: [doc.origin[0], doc.origin[1], doc.origin[2]],
      normal: [0, 0, 1],
    });
  if (!cell) return null;
  const s = doc.voxelSize;
  return [
    doc.origin[0] + (cell[0] + 0.5) * s,
    doc.origin[1] + (cell[1] + 0.5) * s,
    doc.origin[2] + (cell[2] + 0.5) * s,
  ];
}

/** Occupancy edit for setCell: change `cells`, and for a v2 (SDF) doc flip the field sign too. */
function occupancyEdit(doc: VoxelDoc, idx: number, occupied: boolean): VoxelDoc {
  const cells = occupied
    ? [...doc.cells, idx].sort((a, b) => a - b) // keep deterministic order (NFR-2)
    : doc.cells.filter((c) => c !== idx);
  if (!doc.sdf) return { ...doc, cells };
  const b = doc.sdf.band;
  const field = doc.sdf.field.slice();
  const v = occupied ? -0.5 * doc.voxelSize : 0.5 * doc.voxelSize;
  field[idx] = Math.max(-b, Math.min(b, v));
  return { ...doc, cells, sdf: { field, band: b } };
}

/** Commit an immutable edit `before → after` into the diff history (with stroke folding). */
function commitEdit(
  s: { doc: VoxelDoc | null; past: SculptDiff[]; future: SculptDiff[] },
  before: VoxelDoc,
  after: VoxelDoc,
  history: boolean | undefined,
): Partial<VoxelState> {
  if (history === false && s.past.length > 0) {
    // Fold this sample into the last diff: recover the stroke's start, re-diff to now.
    const last = s.past[s.past.length - 1]!;
    const base = revertDiff(before, last);
    const merged = computeDiff(base, after);
    return { doc: after, past: [...s.past.slice(0, -1), merged], future: [] };
  }
  const diff = computeDiff(before, after);
  if (isEmptyDiff(diff)) return { doc: after };
  return { doc: after, past: [...s.past, diff].slice(-HISTORY_LIMIT), future: [] };
}

/** Default brush radius multiplier (× voxelSize) — a few cells wide. */
export const DEFAULT_BRUSH_RADIUS_VOXELS = 3;
/** Default dimensionless brush strength multiplier for every SDF brush. */
export const DEFAULT_BRUSH_STRENGTH = 0.6;

export interface VoxelState {
  /** The open voxel document, or null when no voxel project is active. */
  doc: VoxelDoc | null;
  /** Active sculpt tool (alt-click inverts add⇄erase; SDF brushes ignore alt). */
  tool: VoxelTool;
  /** World-space brush radius for SDF brushes (metres). */
  brushRadius: number;
  /** Signed dimensionless brush strength for SDF brushes (negative subtracts). */
  brushStrength: number;
  /** Mirror each brush stroke across the sculpt volume's X/Y/Z centre planes. */
  mirrorAxes: [boolean, boolean, boolean];
  /** Undo/redo as sparse diffs (edits only; open/close reset them). */
  past: SculptDiff[];
  future: SculptDiff[];

  /** Open a voxel document (new or loaded); resets tool + history. */
  open: (doc: VoxelDoc) => void;
  /** Close the voxel document (leaving voxel mode). */
  close: () => void;
  setTool: (tool: VoxelTool) => void;
  setBrushRadius: (r: number) => void;
  setBrushStrength: (s: number) => void;
  setMirrorAxis: (axis: 0 | 1 | 2, enabled: boolean) => void;
  /** Set the occupancy of one cell. Out-of-bounds or no-change edits are no-ops.
   * Pass `{ history: false }` for the follow-up cells of a drag-paint stroke so the
   * whole stroke folds into ONE undo step (the updateParams live-write pattern). */
  setCell: (
    cell: readonly [number, number, number],
    occupied: boolean,
    opts?: { history?: boolean },
  ) => void;
  /** Resolve + apply one sculpt ray (world-space origin/dir) with `tool`.
   * Returns the applied target, or null when the ray does nothing. */
  sculptAt: (
    origin: V3,
    dir: V3,
    tool: VoxelTool,
    opts?: { history?: boolean },
  ) => SculptTarget | null;
  /** Apply an SDF brush (fully specified, incl. world centre). Returns the new doc or null. */
  applyBrush: (spec: BrushSpec, opts?: { history?: boolean }) => VoxelDoc | null;
  /** Resolve a brush ray to a world centre and apply `brush` there. Returns the new doc or null. */
  sculptBrushAt: (
    origin: V3,
    dir: V3,
    brush: Omit<BrushSpec, "center">,
    opts?: { history?: boolean },
  ) => VoxelDoc | null;
  rename: (name: string) => void;
  undo: () => void;
  redo: () => void;
}

export const useVoxelStore = create<VoxelState>((set, get) => ({
  doc: null,
  tool: "add",
  brushRadius: 0.006, // 3 × 2 mm default voxel
  brushStrength: DEFAULT_BRUSH_STRENGTH,
  mirrorAxes: [false, false, false],
  past: [],
  future: [],

  open: (doc) => {
    const r = doc.voxelSize * DEFAULT_BRUSH_RADIUS_VOXELS;
    set({
      doc: structuredClone(doc),
      tool: "add",
      brushRadius: r,
      brushStrength: DEFAULT_BRUSH_STRENGTH,
      mirrorAxes: [false, false, false],
      past: [],
      future: [],
    });
  },

  close: () =>
    set({
      doc: null,
      tool: "add",
      brushRadius: 0.006,
      brushStrength: DEFAULT_BRUSH_STRENGTH,
      mirrorAxes: [false, false, false],
      past: [],
      future: [],
    }),

  setTool: (tool) => set({ tool }),
  setBrushRadius: (r) => set({ brushRadius: Number.isFinite(r) && r > 0 ? r : get().brushRadius }),
  setBrushStrength: (s) => set({ brushStrength: Number.isFinite(s) ? s : get().brushStrength }),
  setMirrorAxis: (axis, enabled) =>
    set((state) => {
      const mirrorAxes: [boolean, boolean, boolean] = [...state.mirrorAxes];
      mirrorAxes[axis] = enabled;
      return { mirrorAxes };
    }),

  setCell: (cell, occupied, opts) =>
    set((s) => {
      const doc = s.doc;
      const [x, y, z] = cell;
      if (!doc || !inBounds(doc, x, y, z)) return {};
      const idx = cellIndex(doc, x, y, z);
      const has = doc.cells.includes(idx);
      if (has === occupied) return {}; // no change → no diff, no re-render
      const after = occupancyEdit(doc, idx, occupied);
      return commitEdit(s, doc, after, opts?.history);
    }),

  sculptAt: (origin, dir, tool, opts) => {
    const doc = get().doc;
    if (!doc) return null;
    // SDF brushes use sculptBrushAt — sculptAt is the cell-tool path only.
    if (isBrushTool(tool)) return null;
    const target = sculptTarget(doc, tool, origin, dir);
    if (!target) return null;
    get().setCell(target.cell, target.kind === "add", opts);
    return target;
  },

  applyBrush: (spec, opts) => {
    const doc = get().doc;
    if (!doc) return null;
    const after = applyBrushToDoc(doc, spec);
    let result: VoxelDoc | null = null;
    set((s) => {
      if (!s.doc) return {};
      const patch = commitEdit(s, s.doc, after, opts?.history);
      result = (patch.doc as VoxelDoc | undefined) ?? after;
      return patch;
    });
    return result;
  },

  sculptBrushAt: (origin, dir, brush, opts) => {
    const doc = get().doc;
    if (!doc) return null;
    const center = brushCenterAt(doc, origin, dir);
    if (!center) return null;
    return get().applyBrush({ ...brush, center }, opts);
  },

  rename: (name) => set((s) => (s.doc ? { doc: { ...s.doc, name } } : {})),

  undo: () =>
    set((s) => {
      const diff = s.past[s.past.length - 1];
      if (!diff || !s.doc) return {};
      const prev = revertDiff(s.doc, diff);
      return {
        doc: prev,
        past: s.past.slice(0, -1),
        future: [diff, ...s.future].slice(0, HISTORY_LIMIT),
      };
    }),

  redo: () =>
    set((s) => {
      const diff = s.future[0];
      if (!diff || !s.doc) return {};
      const next = applyDiff(s.doc, diff);
      return {
        doc: next,
        past: [...s.past, diff].slice(-HISTORY_LIMIT),
        future: s.future.slice(1),
      };
    }),
}));
