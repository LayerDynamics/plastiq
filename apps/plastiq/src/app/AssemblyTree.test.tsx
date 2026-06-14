// @vitest-environment jsdom
// AssemblyTree — component test (jsdom + RTL, real store). Smoke: the panel + empty
// state with no instances. Integration: Insert adds an instance; once present, the
// mate-mode toggle drives store.mateMode (MatesSection only shows with ≥1 instance).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { AssemblyTree } from "./AssemblyTree.js";
import { useCadStore } from "../store/store.js";
import { defaultDocument } from "../store/seed.js";

beforeEach(() => {
  useCadStore.getState().loadDocument(defaultDocument()); // a part to instance
  useCadStore.setState((s) => ({ assembly: { ...s.assembly, instances: [], mates: [] }, mateMode: false }));
});
afterEach(() => {
  cleanup();
  useCadStore.setState((s) => ({ assembly: { ...s.assembly, instances: [], mates: [] }, mateMode: false }));
});

describe("AssemblyTree", () => {
  it("smoke: renders the assembly panel + empty-state hint with no instances", () => {
    render(<AssemblyTree />);
    expect(screen.getByTestId("assembly-tree")).toBeTruthy();
    expect(screen.getByTestId("insert-instance")).toBeTruthy();
    expect(screen.getByText(/No instances/i)).toBeTruthy();
  });

  it("integration: Insert adds a component instance to the store", () => {
    render(<AssemblyTree />);
    fireEvent.click(screen.getByTestId("insert-instance"));
    expect(useCadStore.getState().assembly.instances.length).toBeGreaterThan(0);
  });

  it("integration: with ≥2 instances, the mate-mode toggle drives store.mateMode", () => {
    render(<AssemblyTree />);
    // MatesSection only renders once there are ≥2 instances to mate.
    fireEvent.click(screen.getByTestId("insert-instance"));
    fireEvent.click(screen.getByTestId("insert-instance"));
    fireEvent.click(screen.getByTestId("mate-mode"));
    expect(useCadStore.getState().mateMode).toBe(true);
  });
});
