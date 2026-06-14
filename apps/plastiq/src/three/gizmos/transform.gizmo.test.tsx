// TransformGizmo — R3F scene-graph test. It renders the move/rotate handles only for
// a built part WITH a selection; with no part / no picks it renders nothing. The
// active handle requires a real built part (WebGL), covered by the e2e suite.

import { afterEach, describe, expect, it } from "vitest";
import ReactThreeTestRenderer from "@react-three/test-renderer";

import { TransformGizmo } from "./transform.gizmo.js";
import { useCadStore } from "../../store/store.js";

afterEach(() => useCadStore.setState({ picks: [] }));

describe("TransformGizmo (R3F scene graph)", () => {
  it("renders nothing without a part or selection (guard)", async () => {
    useCadStore.setState({ picks: [] });
    const r = await ReactThreeTestRenderer.create(<TransformGizmo part={null} />);
    expect(r.scene.children.length).toBe(0);
    await r.unmount();
  });
});
