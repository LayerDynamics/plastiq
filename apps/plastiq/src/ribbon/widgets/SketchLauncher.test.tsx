// @vitest-environment jsdom
// SketchLauncher — component test (jsdom + RTL, real sketch + cad stores). Smoke:
// it mounts. Unit: New Sketch is gated on solverReady. Integration: once the solver
// is ready, New Sketch enters a sketch on the chosen plane in the real store.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { SketchLauncher } from "./SketchLauncher.js";
import { useSketchStore } from "../../sketch/sketchStore.js";
import { useCadStore } from "../../store/store.js";

beforeEach(() => {
  useCadStore.setState({ picks: [] });
  useSketchStore.setState({ solverReady: false, active: false });
});
afterEach(cleanup);

describe("SketchLauncher — smoke", () => {
  it("renders the plane select and the New Sketch button", () => {
    render(<SketchLauncher />);
    expect(screen.getByTestId("sketch-plane")).toBeTruthy();
    expect(screen.getByTestId("enter-sketch")).toBeTruthy();
  });
});

describe("SketchLauncher — unit (solver gating)", () => {
  it("disables New Sketch until the solver is ready", () => {
    useSketchStore.setState({ solverReady: false });
    render(<SketchLauncher />);
    expect((screen.getByTestId("enter-sketch") as HTMLButtonElement).disabled).toBe(true);
  });

  it("enables New Sketch once the solver is ready", () => {
    useSketchStore.setState({ solverReady: true });
    render(<SketchLauncher />);
    expect((screen.getByTestId("enter-sketch") as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("SketchLauncher — integration (enters a sketch)", () => {
  it("New Sketch enters the sketch in the real store once the solver is ready", () => {
    useSketchStore.setState({ solverReady: true, active: false });
    render(<SketchLauncher />);
    fireEvent.change(screen.getByTestId("sketch-plane"), { target: { value: "XZ" } });
    fireEvent.click(screen.getByTestId("enter-sketch"));
    expect(useSketchStore.getState().active).toBe(true);
  });
});
