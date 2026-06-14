// @vitest-environment jsdom
// ViewControl — component test (jsdom + RTL). Renders the named-view buttons and
// asserts a click maps the view name → direction → the viewport's setView seam (the
// same published seam the real Viewport installs — captured here, not mocked away).

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { ViewControl } from "./ViewControl.js";
import { standardViewDirection } from "../../viewport/views.js";

type ViewportSeam = { __plastiqViewport?: { setView?: (d: [number, number, number]) => void } };

afterEach(() => {
  cleanup();
  delete (globalThis as ViewportSeam).__plastiqViewport;
});

describe("ViewControl — smoke", () => {
  it("renders all seven named-view buttons", () => {
    render(<ViewControl />);
    expect(screen.getByTestId("named-views")).toBeTruthy();
    for (const v of ["top", "bottom", "front", "back", "right", "left", "iso"]) {
      expect(screen.getByRole("button", { name: v })).toBeTruthy();
    }
  });
});

describe("ViewControl — integration (drives the viewport setView seam)", () => {
  it("clicking a view button calls setView with that view's direction", () => {
    const setView = vi.fn();
    (globalThis as ViewportSeam).__plastiqViewport = { setView };
    render(<ViewControl />);
    fireEvent.click(screen.getByRole("button", { name: "front" }));
    const d = standardViewDirection("front");
    expect(setView).toHaveBeenCalledWith([d.x, d.y, d.z]);
  });
});
