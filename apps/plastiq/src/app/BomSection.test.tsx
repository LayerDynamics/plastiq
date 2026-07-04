// @vitest-environment jsdom
// BomSection (M4): the sidebar mount for BomPanel — hidden for a bare part,
// and rolling up the LIVE assembly (useCadStore) once instances exist, so the
// panel is reachable in the Assemble workspace's ASSEMBLY section.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

import { BomSection } from "./BomSection.js";
import { useCadStore } from "../store/store.js";
import { defaultDocument } from "../store/seed.js";

beforeEach(() => {
  useCadStore.getState().loadDocument(defaultDocument()); // a part to instance
  useCadStore.setState((s) => ({ assembly: { ...s.assembly, instances: [], mates: [] } }));
});
afterEach(() => {
  cleanup();
  useCadStore.setState((s) => ({ assembly: { ...s.assembly, instances: [], mates: [] } }));
});

describe("BomSection", () => {
  it("renders nothing for a bare part (no instances)", () => {
    render(<BomSection />);
    expect(screen.queryByTestId("bom-section")).toBeNull();
    expect(screen.queryByTestId("bom-panel")).toBeNull();
  });

  it("shows the rolled-up BOM once the assembly has instances", () => {
    render(<BomSection />);
    act(() => {
      useCadStore.getState().addInstance(); // "Part 1"
      useCadStore.getState().addInstance(); // "Part 2"
    });
    expect(screen.getByTestId("bom-section")).toBeTruthy();
    expect(screen.getByTestId("bom-panel")).toBeTruthy();
    expect(screen.getByTestId("bom-row-Part 1").textContent).toContain("×1");
    expect(screen.getByTestId("bom-row-Part 2").textContent).toContain("×1");
    expect(screen.getByTestId("bom-total").textContent).toContain("2 parts total");
  });

  it("tracks removals live (back to hidden when the last instance goes)", () => {
    render(<BomSection />);
    act(() => {
      useCadStore.getState().addInstance();
    });
    expect(screen.getByTestId("bom-total").textContent).toContain("1 part total");
    const id = useCadStore.getState().assembly.instances[0]!.id;
    act(() => {
      useCadStore.getState().removeInstance(id);
    });
    expect(screen.queryByTestId("bom-section")).toBeNull();
  });
});
