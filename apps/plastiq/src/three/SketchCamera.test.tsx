// SketchCamera — R3F scene-graph test. Aligns the camera to a sketch frame; with
// frame=null it renders nothing (no realignment). The active realignment is e2e.

import { describe, expect, it } from "vitest";
import ReactThreeTestRenderer from "@react-three/test-renderer";

import { SketchCamera } from "./SketchCamera.js";

describe("SketchCamera (R3F scene graph)", () => {
  it("renders nothing without a sketch frame (guard)", async () => {
    const r = await ReactThreeTestRenderer.create(<SketchCamera frame={null} />);
    expect(r.scene.children.length).toBe(0);
    await r.unmount();
  });
});
