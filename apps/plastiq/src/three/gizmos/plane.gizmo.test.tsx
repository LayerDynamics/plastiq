// PlaneGizmo — R3F scene-graph test. Shows the ACTIVE sketch's plane: a base
// datum resolved locally, or a FACE-derived plane from the worker-resolved frame
// the viewport publishes (§13.8 P0 made the face case the common one). Renders
// nothing with no active sketch, or while a face frame is still resolving.

import { afterEach, describe, expect, it } from "vitest";
import type * as THREE from "three";
import ReactThreeTestRenderer from "@react-three/test-renderer";

import { PlaneGizmo } from "./plane.gizmo.js";
import { useSketchStore } from "../../sketch/sketchStore.js";
import { emptySketch } from "../../sketch/model.js";

afterEach(() =>
  useSketchStore.setState({ active: false, model: emptySketch(), resolvedFrame: null }),
);

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

  it("draws a FACE-derived sketch plane from the worker-resolved frame (§13.8 P0)", async () => {
    // A sketch started with no explicit offset now lands on the model's outer
    // face, so the face case is the COMMON one — the gizmo must render it.
    useSketchStore.setState({
      active: true,
      model: { ...emptySketch("XY", 0), face: { normal: [0, 0, 1], centroid: [0, 0, 0.03] } },
      resolvedFrame: { origin: [0, 0, 0.03], normal: [0, 0, 1], xAxis: [1, 0, 0] },
    });
    const r = await ReactThreeTestRenderer.create(<PlaneGizmo />);
    const meshes = r.scene.findAllByType("Mesh");
    expect(meshes.length).toBeGreaterThan(0);
    // Positioned ON the face (z = 30 mm), not at the world origin.
    expect(meshes[0]!.parent!.instance.position.z).toBeCloseTo(0.03, 9);
  });

  it("waits for the resolved frame rather than drawing a face plane at the wrong place", async () => {
    useSketchStore.setState({
      active: true,
      model: { ...emptySketch("XY", 0), face: { normal: [0, 0, 1], centroid: [0, 0, 0.03] } },
      resolvedFrame: null, // worker round-trip still in flight
    });
    const r = await ReactThreeTestRenderer.create(<PlaneGizmo />);
    expect(r.scene.findAllByType("Mesh")).toHaveLength(0);
  });
});
