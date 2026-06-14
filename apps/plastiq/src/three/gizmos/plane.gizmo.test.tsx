// PlaneGizmo — R3F scene-graph test. Shows the sketch datum plane only while a (non
// on-face) sketch is active; renders nothing otherwise. The active visual needs the
// live sketch session (e2e).

import { afterEach, describe, expect, it } from "vitest";
import ReactThreeTestRenderer from "@react-three/test-renderer";

import { PlaneGizmo } from "./plane.gizmo.js";
import { useSketchStore } from "../../sketch/sketchStore.js";

afterEach(() => useSketchStore.setState({ active: false }));

describe("PlaneGizmo (R3F scene graph)", () => {
  it("renders nothing when no sketch is active (guard)", async () => {
    useSketchStore.setState({ active: false });
    const r = await ReactThreeTestRenderer.create(<PlaneGizmo />);
    expect(r.scene.children.length).toBe(0);
    await r.unmount();
  });
});
