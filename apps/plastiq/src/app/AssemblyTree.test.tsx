// @vitest-environment jsdom
// AssemblyTree — component test (jsdom + RTL, real store). Smoke: the panel + empty
// state with no instances. Integration: Insert adds an instance; once present, the
// mate-mode toggle drives store.mateMode (MatesSection only shows with ≥1 instance).
// The `.assy` bridge buttons (M4.5): Import opens the file picker; Export appears only
// once there are instances to export (the parse/realize/download flows themselves are
// covered in actions/registry.assy.test.ts).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

  it("integration: Import .assy opens a file picker accepting .assy/.json", () => {
    render(<AssemblyTree />);
    const created: HTMLInputElement[] = [];
    const orig = document.createElement.bind(document);
    const spy = vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      const el = orig(tag);
      if (tag === "input") created.push(el as HTMLInputElement);
      return el;
    });
    fireEvent.click(screen.getByTestId("import-assy"));
    spy.mockRestore();
    expect(created).toHaveLength(1);
    expect(created[0]!.type).toBe("file");
    expect(created[0]!.accept).toBe(".assy,.json");
  });

  it("Export .assy is hidden with no instances and appears once one exists", () => {
    render(<AssemblyTree />);
    expect(screen.queryByTestId("export-assy")).toBeNull();
    fireEvent.click(screen.getByTestId("insert-instance"));
    expect(screen.getByTestId("export-assy")).toBeTruthy();
  });
});
