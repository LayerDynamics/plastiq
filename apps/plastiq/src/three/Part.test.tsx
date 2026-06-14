// Part — R3F scene-graph test. Renders the built part's meshes; with part=null it
// renders nothing. The mesh build needs real worker/OCCT geometry (e2e).

import { describe, expect, it } from "vitest";
import ReactThreeTestRenderer from "@react-three/test-renderer";

import { Part } from "./Part.js";

describe("Part (R3F scene graph)", () => {
  it("renders nothing without a built part (guard)", async () => {
    const r = await ReactThreeTestRenderer.create(<Part part={null} />);
    expect(r.scene.children.length).toBe(0);
    await r.unmount();
  });
});
