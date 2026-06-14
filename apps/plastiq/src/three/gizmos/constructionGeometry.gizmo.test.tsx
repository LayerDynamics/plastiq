// ConstructionGeometryGizmo — R3F scene-graph test. Draws a sketch's construction
// lines/circles only while that sketch is active; with no active sketch it draws no
// geometry.

import { afterEach, describe, expect, it } from "vitest";
import ReactThreeTestRenderer from "@react-three/test-renderer";

import { ConstructionGeometryGizmo } from "./constructionGeometry.gizmo.js";
import { useSketchStore } from "../../sketch/sketchStore.js";

afterEach(() => useSketchStore.setState({ active: false }));

describe("ConstructionGeometryGizmo (R3F scene graph)", () => {
  it("draws no geometry when no sketch is active (guard)", async () => {
    useSketchStore.setState({ active: false });
    const r = await ReactThreeTestRenderer.create(<ConstructionGeometryGizmo />);
    expect(r.scene.findAllByType("Mesh").length).toBe(0);
    await r.unmount();
  });
});
