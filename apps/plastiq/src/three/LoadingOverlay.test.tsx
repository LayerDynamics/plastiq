// @vitest-environment jsdom
// LoadingOverlay (Review #17): visible immediately while the kernel boots
// (status "loading"), only after 300 ms for a rebuild ("building" — flicker
// guard), and hidden for every settled status ("ready"/"empty"/failure).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

import { LoadingOverlay, BUILD_OVERLAY_DELAY_MS } from "./LoadingOverlay.js";
import { useCadStore } from "../store/store.js";

function setStatus(status: string): void {
  act(() => {
    useCadStore.getState().setStatus(status);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  useCadStore.getState().setStatus("ready");
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useCadStore.getState().setStatus("ready");
});

describe("LoadingOverlay", () => {
  it("shows immediately while the wasm kernel is loading", () => {
    render(<LoadingOverlay />);
    expect(screen.queryByTestId("viewport-loading")).toBeNull();
    setStatus("loading");
    expect(screen.getByTestId("viewport-loading").textContent).toContain(
      "Loading geometry kernel",
    );
  });

  it("shows for a build only after the 300 ms flicker guard", () => {
    render(<LoadingOverlay />);
    setStatus("building");
    expect(screen.queryByTestId("viewport-loading")).toBeNull(); // not yet
    act(() => {
      vi.advanceTimersByTime(BUILD_OVERLAY_DELAY_MS);
    });
    expect(screen.getByTestId("viewport-loading").textContent).toContain("Rebuilding");
  });

  it("never appears for a rebuild that finishes inside the guard window", () => {
    render(<LoadingOverlay />);
    setStatus("building");
    act(() => {
      vi.advanceTimersByTime(BUILD_OVERLAY_DELAY_MS - 100);
    });
    setStatus("ready"); // fast build done — timer must be cancelled
    act(() => {
      vi.advanceTimersByTime(BUILD_OVERLAY_DELAY_MS * 2);
    });
    expect(screen.queryByTestId("viewport-loading")).toBeNull();
  });

  it("hides again once a long build settles (ready or failed)", () => {
    render(<LoadingOverlay />);
    setStatus("building");
    act(() => {
      vi.advanceTimersByTime(BUILD_OVERLAY_DELAY_MS);
    });
    expect(screen.getByTestId("viewport-loading")).toBeTruthy();
    setStatus("rebuild failed: fillet radius too large");
    expect(screen.queryByTestId("viewport-loading")).toBeNull();
  });

  it("stays up across the boot handoff (loading → first building)", () => {
    render(<LoadingOverlay />);
    setStatus("loading");
    expect(screen.getByTestId("viewport-loading")).toBeTruthy();
    setStatus("building");
    // Within the guard window the overlay from "loading" must not flash off…
    expect(screen.getByTestId("viewport-loading")).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(BUILD_OVERLAY_DELAY_MS);
    });
    expect(screen.getByTestId("viewport-loading")).toBeTruthy();
  });
});
