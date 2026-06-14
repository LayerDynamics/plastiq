// snapshotCad / snapshotSketch — UNIT: they copy the live store fields into the
// pure shapes resolveContextTarget consumes.

import { afterEach, describe, expect, it } from "vitest";

import { snapshotCad, snapshotSketch } from "./snapshot.js";
import { useCadStore } from "../../store/store.js";
import { useSketchStore } from "../../sketch/sketchStore.js";

afterEach(() => {
  useCadStore.setState({ selMode: "face", mateMode: false, simulating: false });
  useSketchStore.setState({ active: false, solverReady: false });
});

describe("snapshotCad / snapshotSketch (unit)", () => {
  it("snapshotCad reflects the live cad store fields", () => {
    useCadStore.setState({ selMode: "edge", mateMode: true, simulating: true });
    const snap = snapshotCad();
    expect(snap.selMode).toBe("edge");
    expect(snap.mateMode).toBe(true);
    expect(snap.simulating).toBe(true);
  });

  it("snapshotSketch reflects the live sketch store fields", () => {
    useSketchStore.setState({ active: true, solverReady: true });
    const snap = snapshotSketch();
    expect(snap.active).toBe(true);
    expect(snap.solverReady).toBe(true);
  });
});
