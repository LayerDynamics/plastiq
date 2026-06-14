// Section — R3F effect component (returns null; applies clip planes via the renderer).
// With part=null it mounts and no-ops cleanly. The actual clipping needs WebGL (e2e).

import { describe, expect, it } from "vitest";
import ReactThreeTestRenderer from "@react-three/test-renderer";

import { Section } from "./Section.js";

describe("Section (R3F)", () => {
  it("mounts and renders nothing without a part (guard)", async () => {
    const r = await ReactThreeTestRenderer.create(<Section part={null} />);
    expect(r.scene.children.length).toBe(0);
    await r.unmount();
  });
});
