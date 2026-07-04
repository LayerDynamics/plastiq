// @vitest-environment jsdom
// VoxelSculpt — R3F scene-graph + interaction test (ADR-0010). Mounted the way
// Scene.tsx's voxel branch mounts it; the voxel document comes from the store. With
// no document it renders nothing. With one, it renders the surface mesh + bounds
// box, and a LEFT pointer gesture on the canvas sculpts through the REAL
// ray→cell→edit path (the test-renderer camera sits at [0,0,5] looking down −Z, so
// an NDC-centre click adds on the seed voxel's +Z face). ⌘Z routes to the sculpt
// history via the capture-phase listener.

import { afterEach, describe, expect, it } from "vitest";
import ReactThreeTestRenderer from "@react-three/test-renderer";

import { VoxelSculpt } from "./VoxelSculpt.js";
import { useVoxelStore } from "../voxel/voxelStore.js";
import { VoxelGrid } from "../voxel/grid.js";
import { gridToDoc } from "../voxel/doc.js";
import type { VoxelDoc } from "../store/types.js";

/** A 4×4×4 grid of 1 m cells centred on the origin, one voxel in the middle column
 * at [2,2,2] — a straight −Z ray through NDC (0,0) hits its top face. */
function centeredDoc(): VoxelDoc {
  const g = new VoxelGrid([4, 4, 4], 1, [-2, -2, -2]);
  g.set(2, 2, 2, true);
  return gridToDoc(g, "test-sculpt");
}

const cellIdx = (doc: VoxelDoc, x: number, y: number, z: number): number =>
  (z * doc.dims[1] + y) * doc.dims[0] + x;

/** Give the jsdom canvas a real size so pointer coords → NDC are computable. */
function sizeCanvas(canvas: HTMLElement): void {
  canvas.getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
}

const down = (el: HTMLElement, x: number, y: number, init: PointerEventInit = {}): void =>
  void el.dispatchEvent(new MouseEvent("pointerdown", { clientX: x, clientY: y, button: 0, bubbles: true, ...init }));
const up = (el: HTMLElement, x: number, y: number): void =>
  void el.dispatchEvent(new MouseEvent("pointerup", { clientX: x, clientY: y, button: 0, bubbles: true }));

afterEach(() => useVoxelStore.getState().close());

describe("VoxelSculpt (R3F scene graph)", () => {
  it("renders nothing without an open sculpt (guard)", async () => {
    const r = await ReactThreeTestRenderer.create(<VoxelSculpt />);
    expect(r.scene.children.length).toBe(0);
    await r.unmount();
  });

  it("renders the surface mesh + work-volume bounds for the open document", async () => {
    useVoxelStore.getState().open(centeredDoc());
    const r = await ReactThreeTestRenderer.create(<VoxelSculpt />);
    const group = r.scene.children[0]!;
    expect(group.instance.name).toBe("voxel-sculpt");
    const names = group.instance.children.map((c) => c.name);
    expect(names).toContain("voxel-surface");
    expect(names).toContain("voxel-bounds");
    await r.unmount();
  });
});

describe("VoxelSculpt — pointer sculpting through the real ray→cell path", () => {
  it("a LEFT click on the voxel's top face ADDS the cell above it", async () => {
    const doc = centeredDoc();
    useVoxelStore.getState().open(doc);
    let canvas: HTMLCanvasElement | undefined;
    const r = await ReactThreeTestRenderer.create(<VoxelSculpt />, {
      beforeReturn: (c) => {
        canvas = c;
      },
    });
    sizeCanvas(canvas!);

    down(canvas!, 50, 50); // NDC (0,0): the default camera ray goes straight −Z
    up(canvas!, 50, 50);

    const after = useVoxelStore.getState().doc!;
    expect(after.cells).toContain(cellIdx(after, 2, 2, 3)); // added on the +Z face
    expect(after.cells).toHaveLength(2);
    expect(useVoxelStore.getState().past).toHaveLength(1);
    await r.unmount();
  });

  it("an Alt+LEFT click inverts the tool and ERASES the hit voxel", async () => {
    useVoxelStore.getState().open(centeredDoc());
    let canvas: HTMLCanvasElement | undefined;
    const r = await ReactThreeTestRenderer.create(<VoxelSculpt />, {
      beforeReturn: (c) => {
        canvas = c;
      },
    });
    sizeCanvas(canvas!);

    down(canvas!, 50, 50, { altKey: true });
    up(canvas!, 50, 50);

    expect(useVoxelStore.getState().doc!.cells).toHaveLength(0);
    await r.unmount();
  });

  it("⌘Z / ⌘⇧Z route to the SCULPT history while mounted", async () => {
    useVoxelStore.getState().open(centeredDoc());
    const r = await ReactThreeTestRenderer.create(<VoxelSculpt />);
    useVoxelStore.getState().setCell([0, 0, 0], true);
    expect(useVoxelStore.getState().doc!.cells).toHaveLength(2);

    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true }));
    expect(useVoxelStore.getState().doc!.cells).toHaveLength(1); // undone

    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { key: "z", metaKey: true, shiftKey: true, bubbles: true }),
    );
    expect(useVoxelStore.getState().doc!.cells).toHaveLength(2); // redone
    await r.unmount();

    // Unmounted (mode exited) → the listener is gone; ⌘Z no longer touches the sculpt.
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true }));
    expect(useVoxelStore.getState().doc!.cells).toHaveLength(2);
  });
});
