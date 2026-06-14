// @vitest-environment jsdom
// useGizmoPresence — hook test (renderHook). Flags the gizmo on
// __plastiqViewport.gizmos while mounted; clears it on unmount.

import { afterEach, describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";

import { useGizmoPresence } from "./presence.js";

type VP = { __plastiqViewport?: { gizmos?: Record<string, boolean> } };
afterEach(() => {
  delete (globalThis as VP).__plastiqViewport;
});

describe("useGizmoPresence", () => {
  it("flags the gizmo present while mounted, absent after unmount", () => {
    const { unmount } = renderHook(() => useGizmoPresence("plane", true));
    expect((globalThis as VP).__plastiqViewport?.gizmos?.plane).toBe(true);
    unmount();
    expect((globalThis as VP).__plastiqViewport?.gizmos?.plane).toBe(false);
  });
});
