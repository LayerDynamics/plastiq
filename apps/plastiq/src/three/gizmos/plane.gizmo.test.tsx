// PlaneGizmo — R3F scene-graph test. Shows the sketch datum plane only while a (non
// on-face) sketch is active; renders nothing otherwise. The active visual needs the
// live sketch session (e2e).

import { afterEach, describe, expect, it } from "vitest";
import type * as THREE from "three";
import ReactThreeTestRenderer from "@react-three/test-renderer";

import { PlaneGizmo } from "./plane.gizmo.js";
import { useSketchStore } from "../../sketch/sketchStore.js";
import { emptySketch } from "../../sketch/model.js";

afterEach(() => useSketchStore.setState({ active: false, model: emptySketch() }));

describe("PlaneGizmo (R3F scene graph)", () => {
  it("renders nothing when no sketch is active (guard)", async () => {
    useSketchStore.setState({ active: false });
    const r = await ReactThreeTestRenderer.create(<PlaneGizmo />);
    expect(r.scene.children.length).toBe(0);
    await r.unmount();
  });

  it("keeps ONE outline geometry across re-renders (no per-render PlaneGeometry)", async () => {
    useSketchStore.setState({ active: true, model: emptySketch("XY", 0) });
    const r = await ReactThreeTestRenderer.create(<PlaneGizmo />);

    const findOutline = (): THREE.LineSegments => {
      let found: THREE.LineSegments | null = null;
      (r.scene.instance as unknown as THREE.Scene).traverse((o) => {
        if ((o as THREE.LineSegments).isLineSegments) found = o as THREE.LineSegments;
      });
      expect(found).not.toBeNull();
      return found!;
    };

    const before = findOutline().geometry;
    expect(before.type).toBe("EdgesGeometry");

    // Re-render the gizmo (offset change recomputes the frame). Against the old
    // inline `new THREE.PlaneGeometry(...)` JSX arg, the changed args identity
    // made r3f rebuild the EdgesGeometry from a fresh, never-disposed quad on
    // every render — the geometry identity would differ here.
    await ReactThreeTestRenderer.act(async () => {
      useSketchStore.setState({ model: emptySketch("XY", 0.01) });
    });

    expect(findOutline().geometry).toBe(before);
    await r.unmount();
  });
});
