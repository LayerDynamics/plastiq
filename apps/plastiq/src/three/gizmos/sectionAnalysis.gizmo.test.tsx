// SectionAnalysisGizmo — R3F scene-graph test. Shows the section drag-handle only
// with an active section AND a built part; with part=null it renders nothing. The
// active handle needs a real built part (e2e).

import { describe, expect, it } from "vitest";
import ReactThreeTestRenderer from "@react-three/test-renderer";

import { SectionAnalysisGizmo } from "./sectionAnalysis.gizmo.js";

describe("SectionAnalysisGizmo (R3F scene graph)", () => {
  it("renders nothing without a built part (guard)", async () => {
    const r = await ReactThreeTestRenderer.create(<SectionAnalysisGizmo part={null} />);
    expect(r.scene.children.length).toBe(0);
    await r.unmount();
  });
});
