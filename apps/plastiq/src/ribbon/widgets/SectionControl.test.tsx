// @vitest-environment jsdom
// SectionControl — component test (jsdom + RTL, real store, no behaviour mocks).
// Three concerns: it mounts (smoke); it renders from section state (unit); a click
// drives the real store (integration).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { SectionControl } from "./SectionControl.js";
import { useCadStore } from "../../store/store.js";

beforeEach(() => useCadStore.setState({ section: null }));
afterEach(() => {
  cleanup();
  useCadStore.setState({ section: null });
});

describe("SectionControl — smoke", () => {
  it("mounts with the toggle button", () => {
    render(<SectionControl />);
    expect(screen.getByTestId("section-toggle")).toBeTruthy();
  });
});

describe("SectionControl — unit (renders from state)", () => {
  it("hides axis/offset when section is off", () => {
    render(<SectionControl />);
    expect(screen.queryByTestId("section-axis")).toBeNull();
    expect(screen.getByTestId("section-toggle").getAttribute("aria-pressed")).toBe("false");
  });

  it("shows the axis + offset reflecting the active section", () => {
    useCadStore.setState({ section: { kind: "axis", axis: "y", t: 0.3, flip: false } });
    render(<SectionControl />);
    expect(screen.getByTestId("section-toggle").getAttribute("aria-pressed")).toBe("true");
    expect((screen.getByTestId("section-axis") as HTMLSelectElement).value).toBe("y");
    expect((screen.getByTestId("section-offset") as HTMLInputElement).value).toBe("0.3");
    expect(screen.getByTestId("section-flip")).toBeTruthy();
  });
});

describe("SectionControl — integration (drives the store)", () => {
  it("toggling on then off updates the real store's section", () => {
    render(<SectionControl />);
    fireEvent.click(screen.getByTestId("section-toggle"));
    expect(useCadStore.getState().section).toEqual({
      kind: "axis",
      axis: "x",
      t: 0.5,
      flip: false,
    });
    fireEvent.click(screen.getByTestId("section-toggle"));
    expect(useCadStore.getState().section).toBeNull();
  });

  it("changing the axis select updates the store's section axis", () => {
    useCadStore.setState({ section: { kind: "axis", axis: "x", t: 0.5, flip: false } });
    render(<SectionControl />);
    fireEvent.change(screen.getByTestId("section-axis"), { target: { value: "z" } });
    expect(useCadStore.getState().section).toMatchObject({ axis: "z", t: 0.5 });
  });

  it("flip toggles the kept half-space (Fusion flip)", () => {
    useCadStore.setState({ section: { kind: "axis", axis: "x", t: 0.5, flip: false } });
    render(<SectionControl />);
    fireEvent.click(screen.getByTestId("section-flip"));
    expect(useCadStore.getState().section).toMatchObject({ flip: true });
    fireEvent.click(screen.getByTestId("section-flip"));
    expect(useCadStore.getState().section).toMatchObject({ flip: false });
  });
});
