// @vitest-environment jsdom
// StatusBar — component test (jsdom + RTL, real store). Smoke: mounts. Unit: shows
// the store's status + selection mode.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { StatusBar } from "./StatusBar.js";
import { useCadStore } from "../store/store.js";

beforeEach(() => useCadStore.setState({ status: "ready", selMode: "face", picks: [] }));
afterEach(cleanup);

describe("StatusBar", () => {
  it("smoke: mounts with the status readout", () => {
    render(<StatusBar />);
    expect(screen.getByTestId("status")).toBeTruthy();
  });

  it("unit: shows the current status text from the store", () => {
    useCadStore.setState({ status: "ready" });
    render(<StatusBar />);
    expect(screen.getByTestId("status").textContent).toBe("ready");
  });
});
