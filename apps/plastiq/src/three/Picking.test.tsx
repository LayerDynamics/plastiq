// @vitest-environment jsdom
// Picking — R3F effect component (returns null; GPU-id render-target picking). It
// wires canvas pointer events, so it needs a DOM (jsdom). With part=null it mounts
// and no-ops cleanly; the real GPU picking needs WebGL (e2e).

import { describe, expect, it } from "vitest";
import ReactThreeTestRenderer from "@react-three/test-renderer";

import { Picking } from "./Picking.js";

describe("Picking (R3F)", () => {
  it("mounts and renders nothing without a part (guard)", async () => {
    const r = await ReactThreeTestRenderer.create(<Picking part={null} />);
    expect(r.scene.children.length).toBe(0);
    await r.unmount();
  });
});
