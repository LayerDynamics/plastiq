// ObjectCenterGizmo — R3F scene-graph test. Renders the centroid marker only when
// mass properties (a COM) exist; nothing otherwise.

import { afterEach, describe, expect, it } from "vitest";
import ReactThreeTestRenderer from "@react-three/test-renderer";

import { ObjectCenterGizmo } from "./objectCenter.gizmo.js";
import { useCadStore } from "../../store/store.js";

afterEach(() => useCadStore.setState({ massProps: null }));

describe("ObjectCenterGizmo (R3F scene graph)", () => {
  it("renders nothing when there are no mass properties", async () => {
    useCadStore.setState({ massProps: null });
    const r = await ReactThreeTestRenderer.create(<ObjectCenterGizmo />);
    expect(r.scene.findAllByType("Mesh").length).toBe(0);
    await r.unmount();
  });

  it("renders a centroid marker mesh when a COM is present", async () => {
    useCadStore.setState({ massProps: { volume: 0.001, com: [0.01, 0.02, 0.03] } });
    const r = await ReactThreeTestRenderer.create(<ObjectCenterGizmo />);
    expect(r.scene.findAllByType("Mesh").length).toBeGreaterThan(0);
    await r.unmount();
  });
});
