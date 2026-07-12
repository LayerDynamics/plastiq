// @vitest-environment jsdom
// SimReadout — component test (jsdom + RTL). Renders the REAL widget against the
// REAL store (no behaviour mocks) and asserts its OWN logic: simTicks →
// elapsed-seconds formatting, and the running/paused conditional.

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { SimReadout } from "./SimReadout.js";
import { useCadStore } from "../../store/store.js";
import { SIM_TICK_RATE_HZ } from "../../sim/simulator.js";

afterEach(cleanup);

describe("SimReadout (component)", () => {
  it("formats elapsed sim-time from simTicks and shows the running state", () => {
    useCadStore.setState({
      simTicks: 2 * SIM_TICK_RATE_HZ,
      simPaused: false,
      simTelemetry: null,
    });
    render(<SimReadout />);
    expect(screen.getByTestId("sim-time").textContent).toBe("2.00s");
    expect(screen.getByTestId("sim-readout").textContent).toContain("running");
    expect(screen.getByTestId("sim-experiment-label").textContent).toContain("Drop test");
  });

  it("shows 'paused' and 0.00s when paused at the start", () => {
    useCadStore.setState({ simTicks: 0, simPaused: true, simTelemetry: null });
    render(<SimReadout />);
    expect(screen.getByTestId("sim-time").textContent).toBe("0.00s");
    expect(screen.getByTestId("sim-readout").textContent).toContain("paused");
  });

  it("shows settled when telemetry reports rest after impact", () => {
    useCadStore.setState({
      simTicks: SIM_TICK_RATE_HZ,
      simPaused: false,
      simTelemetry: {
        time: 1,
        kind: "drop-test",
        bodies: [],
        maxSpeed: 0,
        minDynamicZ: 0,
        settled: true,
      },
    });
    render(<SimReadout />);
    expect(screen.getByTestId("sim-readout").textContent).toContain("settled");
  });
});
