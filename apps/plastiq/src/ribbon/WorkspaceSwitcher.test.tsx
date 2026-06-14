// @vitest-environment jsdom
// WorkspaceSwitcher — component test (jsdom + RTL, real store). Smoke: renders the
// three-option select. Unit: reflects the current workspace. Integration: changing
// the select drives store.workspace.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { WorkspaceSwitcher } from "./WorkspaceSwitcher.js";
import { useCadStore } from "../store/store.js";

beforeEach(() => useCadStore.setState({ workspace: "design" }));
afterEach(() => {
  cleanup();
  useCadStore.setState({ workspace: "design" });
});

describe("WorkspaceSwitcher — smoke", () => {
  it("renders the workspace select with Design/Assemble/Simulate", () => {
    render(<WorkspaceSwitcher />);
    const sel = screen.getByTestId("workspace-switcher") as HTMLSelectElement;
    expect(sel.querySelectorAll("option")).toHaveLength(3);
  });
});

describe("WorkspaceSwitcher — unit (reflects state)", () => {
  it("shows the current workspace as the selected value", () => {
    useCadStore.setState({ workspace: "simulate" });
    render(<WorkspaceSwitcher />);
    expect((screen.getByTestId("workspace-switcher") as HTMLSelectElement).value).toBe("simulate");
  });
});

describe("WorkspaceSwitcher — integration (drives the store)", () => {
  it("selecting a workspace updates store.workspace", () => {
    render(<WorkspaceSwitcher />);
    fireEvent.change(screen.getByTestId("workspace-switcher"), { target: { value: "assemble" } });
    expect(useCadStore.getState().workspace).toBe("assemble");
  });
});
