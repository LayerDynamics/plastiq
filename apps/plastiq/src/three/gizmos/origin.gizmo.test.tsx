// OriginGizmo — R3F component test via @react-three/test-renderer, which runs the
// real fiber reconciler against a headless GL and lets us assert the SCENE GRAPH the
// component actually produces (not a stub). OriginGizmo renders the world-origin axes.

import { describe, expect, it } from "vitest";
import ReactThreeTestRenderer from "@react-three/test-renderer";

import { OriginGizmo } from "./origin.gizmo.js";

describe("OriginGizmo (R3F scene graph)", () => {
  it("renders an axesHelper into the scene", async () => {
    const renderer = await ReactThreeTestRenderer.create(<OriginGizmo />);
    const axes = renderer.scene.findAllByType("AxesHelper");
    expect(axes.length).toBeGreaterThan(0);
    await renderer.unmount();
  });
});
