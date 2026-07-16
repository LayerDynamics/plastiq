import { beforeEach, describe, expect, it } from "vitest";
import { useCadStore } from "./store.js";

describe("workspace — the editor mode that drives sim", () => {
  beforeEach(() => useCadStore.getState().reset());

  it("defaults to design", () => {
    expect(useCadStore.getState().workspace).toBe("design");
    expect(useCadStore.getState().simulating).toBe(false);
  });

  it("entering the simulate workspace starts a fresh playing run", () => {
    useCadStore.getState().setSimPaused(true);
    useCadStore.getState().setSimTicks(42);
    useCadStore.getState().setWorkspace("simulate");
    const s = useCadStore.getState();
    expect(s.workspace).toBe("simulate");
    expect(s.simulating).toBe(true);
    expect(s.simPaused).toBe(false);
    expect(s.simTicks).toBe(0);
  });

  it("leaving simulate stops the sim", () => {
    useCadStore.getState().setWorkspace("simulate");
    useCadStore.getState().setWorkspace("design");
    expect(useCadStore.getState().workspace).toBe("design");
    expect(useCadStore.getState().simulating).toBe(false);
  });

  it("assemble is a non-sim workspace", () => {
    useCadStore.getState().setWorkspace("simulate");
    useCadStore.getState().setWorkspace("assemble");
    const s = useCadStore.getState();
    expect(s.workspace).toBe("assemble");
    expect(s.simulating).toBe(false);
  });

  it("sculpt is a non-sim workspace (ADR-0010 voxel mode)", () => {
    useCadStore.getState().setWorkspace("simulate");
    useCadStore.getState().setWorkspace("sculpt");
    const s = useCadStore.getState();
    expect(s.workspace).toBe("sculpt");
    expect(s.simulating).toBe(false);
  });

  it("reset returns to design", () => {
    useCadStore.getState().setWorkspace("assemble");
    useCadStore.getState().reset();
    expect(useCadStore.getState().workspace).toBe("design");
  });
});
