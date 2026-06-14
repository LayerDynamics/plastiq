// @vitest-environment jsdom
// ViewCube — component test (jsdom + RTL). The DOM nav cube: it renders face buttons
// and calls onPick(axes) when a face is clicked.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { ViewCube } from "./ViewCube.js";

afterEach(cleanup);

describe("ViewCube", () => {
  it("smoke: renders the cube with its face buttons", () => {
    render(<ViewCube onPick={() => {}} />);
    expect(screen.getByTestId("view-cube")).toBeTruthy();
    expect(screen.getByTestId("cube-face-T")).toBeTruthy();
  });

  it("integration: clicking the Top face calls onPick with the +Z axis", () => {
    const onPick = vi.fn();
    render(<ViewCube onPick={onPick} />);
    fireEvent.click(screen.getByTestId("cube-face-T"));
    expect(onPick).toHaveBeenCalledWith([0, 0, 1]);
  });
});
