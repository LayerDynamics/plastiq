// @vitest-environment jsdom
// useSharedPickers — the ref-counted Picker/GpuPicker pair shared by the Picking
// layer and the right-click context menu. Asserts the seam's lifecycle contract:
// one pair across concurrent consumers, disposal only when the LAST consumer
// unmounts, and a FRESH pair (never the disposed one) for the next claim.

import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

import { useSharedPickers } from "./sharedPickers.js";
import { GpuPicker } from "./gpuPick.js";
import { Picker } from "../viewport/pick.js";

afterEach(() => vi.restoreAllMocks());

describe("useSharedPickers", () => {
  it("hands every consumer the same underlying Picker + GpuPicker pair", () => {
    const a = renderHook(() => useSharedPickers());
    const b = renderHook(() => useSharedPickers());
    expect(a.result.current.picker).toBeInstanceOf(Picker);
    expect(a.result.current.gpu).toBeInstanceOf(GpuPicker);
    expect(a.result.current.picker).toBe(b.result.current.picker);
    expect(a.result.current.gpu).toBe(b.result.current.gpu);
    a.unmount();
    b.unmount();
  });

  it("disposes the GpuPicker only when the last consumer unmounts", () => {
    const dispose = vi.spyOn(GpuPicker.prototype, "dispose");
    const a = renderHook(() => useSharedPickers());
    const b = renderHook(() => useSharedPickers());
    // Touch the pair so it exists (facade getters are lazy).
    expect(a.result.current.gpu).toBe(b.result.current.gpu);

    a.unmount();
    expect(dispose).not.toHaveBeenCalled(); // b still holds the pair

    b.unmount();
    expect(dispose).toHaveBeenCalledTimes(1); // last one out frees the GPU state
  });

  it("a claim after full release gets a FRESH pair, never the disposed one", () => {
    const a = renderHook(() => useSharedPickers());
    const firstGpu = a.result.current.gpu;
    const firstPicker = a.result.current.picker;
    a.unmount(); // last consumer → pair disposed and dropped

    // Next mount (e.g. StrictMode's mount→unmount→mount cycle, or the Scene
    // remounting) must build new instances rather than reuse disposed GL state.
    const b = renderHook(() => useSharedPickers());
    expect(b.result.current.gpu).not.toBe(firstGpu);
    expect(b.result.current.picker).not.toBe(firstPicker);
    b.unmount();
  });
});
