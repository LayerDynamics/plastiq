// FeatureEditGizmo — R3F scene-graph test. Shows in-canvas feature-edit handles only
// for an active feature edit on a built part; with part=null it renders nothing. The
// active handles need a real built part (e2e).

import { describe, expect, it } from "vitest";
import ReactThreeTestRenderer from "@react-three/test-renderer";

import { FeatureEditGizmo } from "./featureEdit.gizmo.js";

describe("FeatureEditGizmo (R3F scene graph)", () => {
  it("renders nothing without a built part (guard)", async () => {
    const r = await ReactThreeTestRenderer.create(<FeatureEditGizmo part={null} />);
    expect(r.scene.children.length).toBe(0);
    await r.unmount();
  });
});
