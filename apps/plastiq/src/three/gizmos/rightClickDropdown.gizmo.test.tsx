// @vitest-environment jsdom
// RightClickDropdownGizmo — R3F component that opens a drei <Html> context menu at a
// world anchor. It wires canvas right-click events (jsdom). While the menu is closed
// it renders nothing; the open <Html> dropdown is exercised by the e2e suite.

import { describe, expect, it } from "vitest";
import ReactThreeTestRenderer from "@react-three/test-renderer";

import { RightClickDropdownGizmo } from "./rightClickDropdown.gizmo.js";

describe("RightClickDropdownGizmo (R3F)", () => {
  it("renders nothing while the context menu is closed (guard)", async () => {
    const r = await ReactThreeTestRenderer.create(<RightClickDropdownGizmo part={null} />);
    expect(r.scene.children.length).toBe(0);
    await r.unmount();
  });
});
