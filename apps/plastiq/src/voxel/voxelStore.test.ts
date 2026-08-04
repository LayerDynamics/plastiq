// ADR-0010 wiring — the voxel-sculpt store: open/close lifecycle, cell edits with
// undo/redo (incl. the stroke-folding history:false pattern), and the ray-driven
// sculpt entry point (sculptTarget/sculptAt) against explicit camera rays — the same
// pure math the viewport's pointer handlers call, tested with no WebGL/DOM.

import { beforeEach, describe, expect, it } from "vitest";

import type { VoxelDoc } from "../store/types.js";
import { defaultVoxelDoc, docToGrid, gridToDoc } from "./doc.js";
import { VoxelGrid } from "./grid.js";
import { sculptTarget, useVoxelStore } from "./voxelStore.js";

/** A tiny 4×4×4 doc (1 m cells at the origin) with a single voxel at [1,1,1]. */
function tinyDoc(): VoxelDoc {
  const g = new VoxelGrid([4, 4, 4], 1, [0, 0, 0]);
  g.set(1, 1, 1, true);
  return gridToDoc(g, "tiny");
}

const idx = (doc: VoxelDoc, x: number, y: number, z: number): number =>
  (z * doc.dims[1] + y) * doc.dims[0] + x;

beforeEach(() => useVoxelStore.getState().close());

describe("voxelStore — open/close lifecycle", () => {
  it("open() installs a deep copy and resets tool + history", () => {
    const doc = tinyDoc();
    useVoxelStore.getState().setTool("erase");
    useVoxelStore.getState().open(doc);
    const s = useVoxelStore.getState();
    expect(s.doc).toEqual(doc);
    expect(s.doc).not.toBe(doc); // deep-copied — the caller's doc can't alias live state
    expect(s.tool).toBe("add");
    expect(s.past).toEqual([]);
    expect(s.future).toEqual([]);
    expect(s.brushStrength).toBe(0.6);
    expect(s.mirrorAxes).toEqual([false, false, false]);
  });

  it("stores brush dimensions and independent X/Y/Z mirror planes", () => {
    useVoxelStore.getState().open(tinyDoc());
    useVoxelStore.getState().setBrushRadius(2.5);
    useVoxelStore.getState().setBrushStrength(-0.4);
    useVoxelStore.getState().setMirrorAxis(0, true);
    useVoxelStore.getState().setMirrorAxis(2, true);
    const state = useVoxelStore.getState();
    expect(state.brushRadius).toBe(2.5);
    expect(state.brushStrength).toBe(-0.4);
    expect(state.mirrorAxes).toEqual([true, false, true]);

    state.close();
    expect(useVoxelStore.getState().mirrorAxes).toEqual([false, false, false]);
  });

  it("close() clears the document and history", () => {
    useVoxelStore.getState().open(tinyDoc());
    useVoxelStore.getState().setCell([0, 0, 0], true);
    useVoxelStore.getState().close();
    const s = useVoxelStore.getState();
    expect(s.doc).toBeNull();
    expect(s.past).toEqual([]);
  });

  it("the default document is a 32³ grid at 2 mm with a seeded slab", () => {
    const doc = defaultVoxelDoc();
    expect(doc.kind).toBe("voxel");
    expect(doc.dims).toEqual([32, 32, 32]);
    expect(doc.voxelSize).toBe(0.002);
    expect(doc.origin).toEqual([-0.032, -0.032, 0]);
    expect(doc.cells.length).toBe(8 * 8 * 2); // the starter slab
    expect(docToGrid(doc).get(15, 15, 0)).toBe(true);
  });
});

describe("voxelStore — cell edits + undo/redo", () => {
  it("setCell adds/removes cells immutably and pushes history", () => {
    useVoxelStore.getState().open(tinyDoc());
    const before = useVoxelStore.getState().doc!;
    useVoxelStore.getState().setCell([2, 1, 1], true);
    const after = useVoxelStore.getState().doc!;
    expect(after).not.toBe(before);
    expect(after.cells).toContain(idx(after, 2, 1, 1));
    expect(useVoxelStore.getState().past).toHaveLength(1);

    useVoxelStore.getState().setCell([1, 1, 1], false);
    expect(useVoxelStore.getState().doc!.cells).not.toContain(idx(after, 1, 1, 1));
    expect(useVoxelStore.getState().past).toHaveLength(2);
  });

  it("no-change and out-of-bounds edits are no-ops (no history, same doc)", () => {
    useVoxelStore.getState().open(tinyDoc());
    const doc = useVoxelStore.getState().doc!;
    useVoxelStore.getState().setCell([1, 1, 1], true); // already occupied
    useVoxelStore.getState().setCell([9, 0, 0], true); // out of bounds
    useVoxelStore.getState().setCell([0, 0, 0], false); // already empty
    expect(useVoxelStore.getState().doc).toBe(doc);
    expect(useVoxelStore.getState().past).toHaveLength(0);
  });

  it("undo/redo walk the edit history", () => {
    useVoxelStore.getState().open(tinyDoc());
    const original = useVoxelStore.getState().doc!;
    useVoxelStore.getState().setCell([2, 1, 1], true);
    const edited = useVoxelStore.getState().doc!;

    useVoxelStore.getState().undo();
    expect(useVoxelStore.getState().doc).toEqual(original);
    useVoxelStore.getState().redo();
    expect(useVoxelStore.getState().doc).toEqual(edited);
  });

  it("a drag-paint stroke (history:false after the first cell) folds into ONE undo step", () => {
    useVoxelStore.getState().open(tinyDoc());
    const original = useVoxelStore.getState().doc!;
    // The viewport stroke: first sample carries history, the rest fold in.
    useVoxelStore.getState().setCell([0, 0, 0], true);
    useVoxelStore.getState().setCell([1, 0, 0], true, { history: false });
    useVoxelStore.getState().setCell([2, 0, 0], true, { history: false });
    expect(useVoxelStore.getState().past).toHaveLength(1);
    expect(useVoxelStore.getState().doc!.cells).toHaveLength(original.cells.length + 3);

    useVoxelStore.getState().undo(); // one undo reverts the whole stroke
    expect(useVoxelStore.getState().doc).toEqual(original);
  });

  it("a new edit clears the redo stack", () => {
    useVoxelStore.getState().open(tinyDoc());
    useVoxelStore.getState().setCell([2, 1, 1], true);
    useVoxelStore.getState().undo();
    expect(useVoxelStore.getState().future).toHaveLength(1);
    useVoxelStore.getState().setCell([3, 3, 3], true);
    expect(useVoxelStore.getState().future).toHaveLength(0);
  });

  it("rename updates the document name in place", () => {
    useVoxelStore.getState().open(tinyDoc());
    useVoxelStore.getState().rename("bust");
    expect(useVoxelStore.getState().doc!.name).toBe("bust");
  });
});

describe("sculptTarget — ray → cell resolution (the click semantics)", () => {
  const doc = tinyDoc(); // one voxel at [1,1,1], cells are 1 m

  it("add: the empty neighbour through the hit face (click the +Z face → cell above)", () => {
    // Ray straight down onto the voxel's top face.
    const t = sculptTarget(doc, "add", [1.5, 1.5, 10], [0, 0, -1]);
    expect(t).toEqual({ cell: [1, 1, 2], kind: "add" });
  });

  it("erase: the hit voxel itself", () => {
    const t = sculptTarget(doc, "erase", [1.5, 1.5, 10], [0, 0, -1]);
    expect(t).toEqual({ cell: [1, 1, 1], kind: "erase" });
  });

  it("add on a miss lands on the ground work plane inside the grid", () => {
    // Misses the voxel (x=3.5 column is empty) → intersects z=0 plane at [3.5,3.5].
    const t = sculptTarget(doc, "add", [3.5, 3.5, 10], [0, 0, -1]);
    expect(t).toEqual({ cell: [3, 3, 0], kind: "add" });
  });

  it("erase on a miss is null (nothing to erase)", () => {
    expect(sculptTarget(doc, "erase", [3.5, 3.5, 10], [0, 0, -1])).toBeNull();
  });

  it("add through an outer boundary face is null (outside the sculpt volume)", () => {
    // A doc whose voxel sits at the very top layer: adding on its +Z face would
    // leave the grid → no target.
    const g = new VoxelGrid([4, 4, 4], 1, [0, 0, 0]);
    g.set(1, 1, 3, true);
    const t = sculptTarget(gridToDoc(g), "add", [1.5, 1.5, 10], [0, 0, -1]);
    expect(t).toBeNull();
  });

  it("a ray that misses grid and plane is null", () => {
    expect(sculptTarget(doc, "add", [1.5, 1.5, 10], [0, 0, 1])).toBeNull(); // points away
  });
});

describe("voxelStore.sculptAt — resolve + apply in one call", () => {
  it("applies the add and returns the target", () => {
    useVoxelStore.getState().open(tinyDoc());
    const t = useVoxelStore.getState().sculptAt([1.5, 1.5, 10], [0, 0, -1], "add");
    expect(t).toEqual({ cell: [1, 1, 2], kind: "add" });
    const doc = useVoxelStore.getState().doc!;
    expect(doc.cells).toContain(idx(doc, 1, 1, 2));
    expect(useVoxelStore.getState().past).toHaveLength(1);
  });

  it("applies the erase and returns the target", () => {
    useVoxelStore.getState().open(tinyDoc());
    const t = useVoxelStore.getState().sculptAt([1.5, 1.5, 10], [0, 0, -1], "erase");
    expect(t).toEqual({ cell: [1, 1, 1], kind: "erase" });
    expect(useVoxelStore.getState().doc!.cells).toHaveLength(0);
  });

  it("returns null (and edits nothing) when the ray resolves no target", () => {
    useVoxelStore.getState().open(tinyDoc());
    const before = useVoxelStore.getState().doc;
    const t = useVoxelStore.getState().sculptAt([1.5, 1.5, 10], [0, 0, 1], "erase");
    expect(t).toBeNull();
    expect(useVoxelStore.getState().doc).toBe(before);
  });

  it("no-ops when no document is open", () => {
    expect(useVoxelStore.getState().sculptAt([0, 0, 10], [0, 0, -1], "add")).toBeNull();
  });
});
