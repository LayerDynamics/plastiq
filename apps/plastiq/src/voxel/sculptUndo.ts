// §16 Phase 4 — undo/redo as SPARSE DIFFS between voxel documents, replacing the 100
// full-grid snapshots (voxelStore.ts HISTORY_LIMIT) that do not survive real sculpt
// resolutions. A `SculptDiff` records only what changed between a `before` and an
// `after` VoxelDoc:
//
//   • occupancy set delta   — indices added to / removed from `cells`;
//   • signed-distance runs   — contiguous ranges of `sdf.field` that changed, stored as
//                              (start, before[], after[]) — the "changed-cell runs";
//   • a whole-field replace  — used ONLY on the one edit where a field first appears (a
//                              legacy occupancy doc's first brush) or its length changes;
//   • scalar metadata        — `version`/`name` restore values.
//
// `applyDiff` and `revertDiff` are pure (return a NEW doc), so the store folds a
// drag-stroke into one diff and every undo/redo exactly restores the prior document.

import type { VoxelDoc, VoxelSdf } from "../store/types.js";

/** A contiguous run of changed field samples: `field[start + k]` went `before[k] → after[k]`. */
export interface FieldRun {
  start: number;
  before: number[];
  after: number[];
}

/** The minimal change between two voxel documents. */
export interface SculptDiff {
  /** Cell indices present in `after.cells` but not `before.cells`. */
  cellsAdded: number[];
  /** Cell indices present in `before.cells` but not `after.cells`. */
  cellsRemoved: number[];
  /** Field ranges that changed, when both docs carry an equal-length SDF. */
  fieldRuns: FieldRun[];
  /** Whole-field swap, when the SDF's presence or length changed (else undefined). */
  fieldReplace?: { before: VoxelSdf | null; after: VoxelSdf | null };
  /** Scalar metadata to restore on revert / set on apply. */
  meta: { before: DocMeta; after: DocMeta };
}

interface DocMeta {
  version?: 1 | 2;
  name?: string;
}

function docMeta(doc: VoxelDoc): DocMeta {
  return { ...(doc.version !== undefined ? { version: doc.version } : {}), ...(doc.name !== undefined ? { name: doc.name } : {}) };
}

function cloneSdf(sdf: VoxelSdf): VoxelSdf {
  return { field: sdf.field.slice(), band: sdf.band };
}

/** Sorted set difference `a \ b`. */
function setDiff(a: readonly number[], b: readonly number[]): number[] {
  const bs = new Set(b);
  return a.filter((v) => !bs.has(v));
}

/** Compute the sparse diff that turns `before` into `after`. Deterministic. */
export function computeDiff(before: VoxelDoc, after: VoxelDoc): SculptDiff {
  const cellsAdded = setDiff(after.cells, before.cells);
  const cellsRemoved = setDiff(before.cells, after.cells);

  const bSdf = before.sdf;
  const aSdf = after.sdf;
  let fieldRuns: FieldRun[] = [];
  let fieldReplace: { before: VoxelSdf | null; after: VoxelSdf | null } | undefined;

  if (bSdf && aSdf && bSdf.field.length === aSdf.field.length && bSdf.band === aSdf.band) {
    fieldRuns = diffRuns(bSdf.field, aSdf.field);
  } else if (bSdf || aSdf) {
    // Presence, length, or band changed — store the whole field (the migration edit).
    fieldReplace = { before: bSdf ? cloneSdf(bSdf) : null, after: aSdf ? cloneSdf(aSdf) : null };
  }

  return {
    cellsAdded,
    cellsRemoved,
    fieldRuns,
    ...(fieldReplace ? { fieldReplace } : {}),
    meta: { before: docMeta(before), after: docMeta(after) },
  };
}

/** Contiguous runs where two equal-length arrays differ. */
function diffRuns(before: readonly number[], after: readonly number[]): FieldRun[] {
  const runs: FieldRun[] = [];
  let i = 0;
  const n = before.length;
  while (i < n) {
    if (before[i] === after[i]) {
      i++;
      continue;
    }
    const start = i;
    const b: number[] = [];
    const a: number[] = [];
    while (i < n && before[i] !== after[i]) {
      b.push(before[i]!);
      a.push(after[i]!);
      i++;
    }
    runs.push({ start, before: b, after: a });
  }
  return runs;
}

/** True when a diff records no change at all. */
export function isEmptyDiff(d: SculptDiff): boolean {
  return d.cellsAdded.length === 0 && d.cellsRemoved.length === 0 && d.fieldRuns.length === 0 && d.fieldReplace === undefined;
}

function applyCells(cells: readonly number[], add: readonly number[], remove: readonly number[]): number[] {
  const rm = new Set(remove);
  const set = new Set(cells.filter((c) => !rm.has(c)));
  for (const c of add) set.add(c);
  return Array.from(set).sort((x, y) => x - y);
}

function withMeta(doc: VoxelDoc, meta: DocMeta): VoxelDoc {
  const next: VoxelDoc = { ...doc };
  if (meta.version === undefined) delete (next as { version?: 1 | 2 }).version;
  else next.version = meta.version;
  if (meta.name === undefined) delete (next as { name?: string }).name;
  else next.name = meta.name;
  return next;
}

function setField(doc: VoxelDoc, sdf: VoxelSdf | null): VoxelDoc {
  const next: VoxelDoc = { ...doc };
  if (sdf === null) delete (next as { sdf?: VoxelSdf }).sdf;
  else next.sdf = cloneSdf(sdf);
  return next;
}

/** Apply `diff` to `before` → the `after` document (pure). */
export function applyDiff(before: VoxelDoc, diff: SculptDiff): VoxelDoc {
  let doc = withMeta(before, diff.meta.after);
  doc = { ...doc, cells: applyCells(before.cells, diff.cellsAdded, diff.cellsRemoved) };
  if (diff.fieldReplace) {
    doc = setField(doc, diff.fieldReplace.after);
  } else if (diff.fieldRuns.length > 0 && doc.sdf) {
    const field = doc.sdf.field.slice();
    for (const run of diff.fieldRuns) for (let k = 0; k < run.after.length; k++) field[run.start + k] = run.after[k]!;
    doc = { ...doc, sdf: { field, band: doc.sdf.band } };
  }
  return doc;
}

/** Revert `diff` from `after` → the `before` document (pure). */
export function revertDiff(after: VoxelDoc, diff: SculptDiff): VoxelDoc {
  let doc = withMeta(after, diff.meta.before);
  doc = { ...doc, cells: applyCells(after.cells, diff.cellsRemoved, diff.cellsAdded) };
  if (diff.fieldReplace) {
    doc = setField(doc, diff.fieldReplace.before);
  } else if (diff.fieldRuns.length > 0 && doc.sdf) {
    const field = doc.sdf.field.slice();
    for (const run of diff.fieldRuns) for (let k = 0; k < run.before.length; k++) field[run.start + k] = run.before[k]!;
    doc = { ...doc, sdf: { field, band: doc.sdf.band } };
  }
  return doc;
}
