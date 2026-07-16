// The voxel-sculpt document store (ADR-0010 wiring). Holds the OPEN voxel document —
// the single live authority, parallel to projectsStore.activeMeshDoc for mesh docs —
// plus the active sculpt tool and an undo/redo history of document snapshots
// (mirroring useCadStore's past/future pattern, same 100-step limit).
//
// Edits are immutable VoxelDoc → VoxelDoc transforms over the compact `cells`
// (linear indices), so persistence/autosave can subscribe to `doc` identity changes
// exactly the way they subscribe to `features`/`params` on the cad store. The
// ray-driven edit entry point (`sculptAt`) is pure math over voxel/pick.ts, so the
// whole click→cell→edit path unit-tests in Node with a plain camera ray.

import { create } from "zustand";
import type { VoxelDoc } from "../store/types.js";
import { docToGrid } from "./doc.js";
import { rayVoxelHit, rayWorkPlaneCell } from "./pick.js";
import type { V3 } from "./grid.js";

/** The two sculpt tools: add a voxel on the clicked face / erase the clicked voxel. */
export type VoxelTool = "add" | "erase";

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
export function sculptTarget(doc: VoxelDoc, tool: VoxelTool, origin: V3, dir: V3): SculptTarget | null {
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

export interface VoxelState {
  /** The open voxel document, or null when no voxel project is active. */
  doc: VoxelDoc | null;
  /** Active sculpt tool (alt-click inverts it per-click in the viewport). */
  tool: VoxelTool;
  /** Undo/redo document snapshots (edits only; open/close reset them). */
  past: VoxelDoc[];
  future: VoxelDoc[];

  /** Open a voxel document (new or loaded); resets tool + history. */
  open: (doc: VoxelDoc) => void;
  /** Close the voxel document (leaving voxel mode). */
  close: () => void;
  setTool: (tool: VoxelTool) => void;
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
  sculptAt: (origin: V3, dir: V3, tool: VoxelTool, opts?: { history?: boolean }) => SculptTarget | null;
  rename: (name: string) => void;
  undo: () => void;
  redo: () => void;
}

export const useVoxelStore = create<VoxelState>((set, get) => ({
  doc: null,
  tool: "add",
  past: [],
  future: [],

  open: (doc) => set({ doc: structuredClone(doc), tool: "add", past: [], future: [] }),

  close: () => set({ doc: null, tool: "add", past: [], future: [] }),

  setTool: (tool) => set({ tool }),

  setCell: (cell, occupied, opts) =>
    set((s) => {
      const doc = s.doc;
      const [x, y, z] = cell;
      if (!doc || !inBounds(doc, x, y, z)) return {};
      const idx = cellIndex(doc, x, y, z);
      const has = doc.cells.includes(idx);
      if (has === occupied) return {}; // no change → no snapshot, no re-render
      const cells = occupied
        ? [...doc.cells, idx].sort((a, b) => a - b) // keep deterministic order (NFR-2)
        : doc.cells.filter((c) => c !== idx);
      return {
        doc: { ...doc, cells },
        ...(opts?.history === false
          ? {}
          : { past: [...s.past, doc].slice(-HISTORY_LIMIT), future: [] }),
      };
    }),

  sculptAt: (origin, dir, tool, opts) => {
    const doc = get().doc;
    if (!doc) return null;
    const target = sculptTarget(doc, tool, origin, dir);
    if (!target) return null;
    get().setCell(target.cell, target.kind === "add", opts);
    return target;
  },

  rename: (name) => set((s) => (s.doc ? { doc: { ...s.doc, name } } : {})),

  undo: () =>
    set((s) => {
      const prev = s.past[s.past.length - 1];
      if (!prev || !s.doc) return {};
      return { doc: prev, past: s.past.slice(0, -1), future: [s.doc, ...s.future].slice(0, HISTORY_LIMIT) };
    }),

  redo: () =>
    set((s) => {
      const next = s.future[0];
      if (!next || !s.doc) return {};
      return { doc: next, past: [...s.past, s.doc].slice(-HISTORY_LIMIT), future: s.future.slice(1) };
    }),
}));
