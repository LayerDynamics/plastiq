// @vitest-environment jsdom
// TopBar — component test (jsdom + RTL). Smoke: the whole top strip assembles from
// its real children (WorkspaceSwitcher, ProjectsMenu, ActionButtons, help) against
// the real stores. Integration: the workspace switcher inside it drives the store.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { TopBar } from "./TopBar.js";
import { useCadStore } from "../store/store.js";

beforeEach(() => useCadStore.setState({ workspace: "design" }));
afterEach(() => {
  cleanup();
  useCadStore.setState({ workspace: "design" });
});

describe("TopBar — smoke", () => {
  it("renders the toolbar with the workspace switcher and selection-mode group", () => {
    render(<TopBar />);
    expect(screen.getByTestId("topbar")).toBeTruthy();
    expect(screen.getByLabelText("Plastiq CAD Studio")).toBeTruthy();
    expect(screen.getByTestId("workspace-switcher")).toBeTruthy();
    expect(screen.getByTestId("selmode")).toBeTruthy();
  });
});

describe("TopBar — integration", () => {
  it("the embedded workspace switcher drives store.workspace", () => {
    render(<TopBar />);
    fireEvent.change(screen.getByTestId("workspace-switcher"), { target: { value: "simulate" } });
    expect(useCadStore.getState().workspace).toBe("simulate");
  });
});
