// R3 / P2 — a failed Simulate start must be visible and must NOT wedge the UI.
//
// Before R3, `void buildSimulator().then(...)` had no `.catch`, so a fail-fast
// lower (any errored feature) rejected into the void: no status, and `simulating`
// stuck `true` with no world. These tests pin the recovery the `.catch` now runs.

import { beforeEach, describe, expect, it } from "vitest";

import { useCadStore } from "../store/store.js";
import { applySimFailure, simFailureMessage } from "./simControl.js";

describe("R3 — Simulate-start failure is surfaced, never wedged", () => {
  beforeEach(() => useCadStore.getState().reset());

  it("renders an Error (or raw value) as a 'Simulate failed' status line", () => {
    expect(simFailureMessage(new Error("feature f2 (fillet): 3 edges did not resolve"))).toBe(
      "Simulate failed: feature f2 (fillet): 3 edges did not resolve",
    );
    expect(simFailureMessage("worker died")).toBe("Simulate failed: worker died");
  });

  it("clears a wedged sim: status shown, simulating=false, workspace back to design", () => {
    // Enter Simulate — the workspace authority sets simulating true.
    useCadStore.getState().setWorkspace("simulate");
    expect(useCadStore.getState().simulating).toBe(true);

    // The lower rejects (a document with an errored fillet the viewport still shows).
    applySimFailure(useCadStore.getState(), new Error("lower rejected: fillet errored"));

    const s = useCadStore.getState();
    expect(s.simulating).toBe(false); // no longer wedged
    expect(s.workspace).toBe("design"); // returned to a usable mode
    expect(s.status).toContain("Simulate failed");
    expect(s.status).toContain("fillet errored"); // the actual reason is visible
  });
});
