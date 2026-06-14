// Assembly — R3F scene-graph test. Renders per-instance meshes from a transfer mesh;
// with no mesh/instances it renders nothing. The instanced meshes need a real
// transfer mesh from the worker (e2e).

import { describe, expect, it } from "vitest";
import ReactThreeTestRenderer from "@react-three/test-renderer";

import { Assembly } from "./Assembly.js";

describe("Assembly (R3F scene graph)", () => {
  it("renders nothing without a mesh + instances (guard)", async () => {
    const r = await ReactThreeTestRenderer.create(<Assembly mesh={null} instances={null} />);
    expect(r.scene.children.length).toBe(0);
    await r.unmount();
  });
});
