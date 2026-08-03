// §16 Phase 4 — sparse-diff undo: exact restore for occupancy edits, field-run edits,
// and the v1→v2 (field-appears) migration edit; empty diffs; stroke folding correctness.

import { describe, expect, it } from "vitest";

import type { VoxelDoc } from "../store/types.js";
import { computeDiff, applyDiff, revertDiff, isEmptyDiff } from "./sculptUndo.js";
import { SdfGrid } from "./sdf.js";
import { VoxelGrid } from "./grid.js";

function occDoc(cells: number[]): VoxelDoc {
  return { kind: "voxel", name: "t", dims: [4, 4, 4], voxelSize: 1, origin: [0, 0, 0], cells: [...cells].sort((a, b) => a - b) };
}

describe("sparse diff — occupancy edits", () => {
  it("apply/revert exactly round-trip a single-cell add", () => {
    const before = occDoc([0, 1, 2]);
    const after = occDoc([0, 1, 2, 5]);
    const d = computeDiff(before, after);
    expect(d.cellsAdded).toEqual([5]);
    expect(d.cellsRemoved).toEqual([]);
    expect(applyDiff(before, d)).toEqual(after);
    expect(revertDiff(after, d)).toEqual(before);
  });

  it("apply/revert exactly round-trip a removal", () => {
    const before = occDoc([0, 1, 2, 5]);
    const after = occDoc([0, 2]);
    const d = computeDiff(before, after);
    expect(new Set(d.cellsRemoved)).toEqual(new Set([1, 5]));
    expect(applyDiff(before, d)).toEqual(after);
    expect(revertDiff(after, d)).toEqual(before);
  });

  it("an identical pair yields an empty diff", () => {
    const doc = occDoc([1, 2, 3]);
    expect(isEmptyDiff(computeDiff(doc, doc))).toBe(true);
  });
});

describe("sparse diff — SDF field runs", () => {
  it("records only the changed contiguous runs and round-trips them", () => {
    const g = SdfGrid.sphere([8, 8, 8], 0.02, [-0.08, -0.08, -0.08], [0, 0, 0], 0.08);
    const before = g.toDoc("s");
    const g2 = SdfGrid.sphere([8, 8, 8], 0.02, [-0.08, -0.08, -0.08], [0, 0, 0], 0.08);
    // Perturb a couple of contiguous cells.
    g2.field[10] = g2.field[10]! + 0.01;
    g2.field[11] = g2.field[11]! - 0.01;
    g2.field[40] = g2.field[40]! + 0.02;
    const after = g2.toDoc("s");

    const d = computeDiff(before, after);
    expect(d.fieldReplace).toBeUndefined();
    // Two disjoint runs: {10,11} and {40}.
    expect(d.fieldRuns.length).toBe(2);
    expect(applyDiff(before, d).sdf!.field).toEqual(after.sdf!.field);
    expect(revertDiff(after, d).sdf!.field).toEqual(before.sdf!.field);
    // full-document exactness
    expect(applyDiff(before, d)).toEqual(after);
    expect(revertDiff(after, d)).toEqual(before);
  });
});

describe("sparse diff — v1→v2 migration edit", () => {
  it("uses a whole-field replace when the SDF first appears, and round-trips exactly", () => {
    const before = occDoc([0, 1, 2]); // legacy, no sdf
    const grid = new VoxelGrid([4, 4, 4], 1, [0, 0, 0]);
    grid.addBox([1, 1, 1], [2, 2, 2]);
    const after = SdfGrid.fromOccupancy(grid).toDoc("t");
    const d = computeDiff(before, after);
    expect(d.fieldReplace).toBeDefined();
    expect(d.fieldReplace!.before).toBeNull();
    expect(d.fieldReplace!.after).not.toBeNull();
    expect(applyDiff(before, d)).toEqual(after);
    expect(revertDiff(after, d)).toEqual(before);
  });
});
