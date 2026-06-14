// OffsetGizmo — R3F scene-graph test. Shows the offset arrow only for an active,
// non-zero-offset sketch; renders nothing otherwise.

import { afterEach, describe, expect, it } from "vitest";
import ReactThreeTestRenderer from "@react-three/test-renderer";

import { OffsetGizmo } from "./offset.gizmo.js";
import { useSketchStore } from "../../sketch/sketchStore.js";

afterEach(() => useSketchStore.setState({ active: false }));

describe("OffsetGizmo (R3F scene graph)", () => {
  it("renders nothing when no sketch is active (guard)", async () => {
    useSketchStore.setState({ active: false });
    const r = await ReactThreeTestRenderer.create(<OffsetGizmo />);
    expect(r.scene.children.length).toBe(0);
    await r.unmount();
  });
});
