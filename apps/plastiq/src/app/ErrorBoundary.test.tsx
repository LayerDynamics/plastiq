// @vitest-environment jsdom
// ErrorBoundary (Review #17): a child render crash shows the recovery screen —
// the error message, the auto-snapshot note, and a Reload action — instead of a
// blank page; healthy children render straight through.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { ErrorBoundary } from "./ErrorBoundary.js";

function Bomb(): React.JSX.Element {
  throw new Error("kaboom: viewport exploded");
}

beforeEach(() => {
  // React logs every caught render error to console.error — keep the run quiet.
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ErrorBoundary", () => {
  it("renders its children when nothing crashes", () => {
    render(
      <ErrorBoundary>
        <p data-testid="healthy-child">all good</p>
      </ErrorBoundary>,
    );
    expect(screen.getByTestId("healthy-child")).toBeTruthy();
    expect(screen.queryByTestId("error-boundary")).toBeNull();
  });

  it("a crashing child shows the recovery screen with the error message", () => {
    render(
      <ErrorBoundary onReload={() => undefined}>
        <Bomb />
      </ErrorBoundary>,
    );
    expect(screen.getByTestId("error-boundary")).toBeTruthy();
    expect(screen.getByTestId("error-boundary-message").textContent).toContain(
      "kaboom: viewport exploded",
    );
    // The auto-snapshot note must be present (and truthful: "offered", not "restored").
    expect(screen.getByTestId("error-boundary").textContent).toContain("auto-snapshots");
    expect(screen.getByTestId("error-boundary-reload")).toBeTruthy();
  });

  it("the Reload action invokes the reload handler", () => {
    const onReload = vi.fn();
    render(
      <ErrorBoundary onReload={onReload}>
        <Bomb />
      </ErrorBoundary>,
    );
    fireEvent.click(screen.getByTestId("error-boundary-reload"));
    expect(onReload).toHaveBeenCalledTimes(1);
  });
});
