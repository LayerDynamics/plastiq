// @vitest-environment jsdom
// Welcome — component test (jsdom + RTL, real useWelcome store). Smoke/unit: it
// renders nothing when closed and the overlay when open. Integration: the close
// button closes it in the store.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { Welcome, useWelcome } from "./Welcome.js";

beforeEach(() => useWelcome.setState({ open: false, dontShow: false }));
afterEach(() => {
  cleanup();
  useWelcome.setState({ open: false });
});

describe("Welcome", () => {
  it("smoke/unit: renders nothing when closed", () => {
    const { container } = render(<Welcome />);
    expect(container.firstChild).toBeNull();
  });

  it("unit: renders the overlay when open", () => {
    useWelcome.setState({ open: true });
    render(<Welcome />);
    expect(screen.getByTestId("welcome")).toBeTruthy();
  });

  it("integration: the close button closes it in the store", () => {
    useWelcome.setState({ open: true });
    render(<Welcome />);
    fireEvent.click(screen.getByTestId("welcome-close-x"));
    expect(useWelcome.getState().open).toBe(false);
  });
});
