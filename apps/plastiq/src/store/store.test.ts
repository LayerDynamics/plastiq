import { beforeEach, describe, expect, it } from "vitest";
import { useCadStore } from "./store.js";

const s = () => useCadStore.getState();

beforeEach(() => {
  s().reset();
});

describe("CAD Studio store — document (FR-2)", () => {
  it("addFeature assigns a sequential id + default name and selects it", () => {
    const id1 = s().addFeature({ type: "sketch" });
    const id2 = s().addFeature({ type: "extrude", params: { height: 0.02 }, deps: [id1] });
    expect(id1).toBe("f1");
    expect(id2).toBe("f2");
    expect(s().features).toHaveLength(2);
    expect(s().features[0]!.name).toBe("Sketch 1");
    expect(s().features[1]!.params).toEqual({ height: 0.02 });
    expect(s().selectedFeatureId).toBe("f2");
  });

  it("updateParams merges numeric params immutably", () => {
    const id = s().addFeature({ type: "extrude", params: { height: 0.02 } });
    s().updateParams(id, { height: 0.05 });
    expect(s().features[0]!.params).toEqual({ height: 0.05 });
  });

  it("setFeatureData stores non-numeric payloads (sketch points / refs)", () => {
    const id = s().addFeature({ type: "sketch" });
    s().setFeatureData(id, {
      points: [
        [0, 0],
        [1, 0],
        [1, 1],
      ],
    });
    expect(s().features[0]!.data?.points).toEqual([
      [0, 0],
      [1, 0],
      [1, 1],
    ]);
  });

  it("rename / remove / toggleSuppress", () => {
    const a = s().addFeature({ type: "sketch" });
    const b = s().addFeature({ type: "extrude" });
    s().renameFeature(a, "Base profile");
    s().toggleSuppress(b);
    expect(s().features.find((f) => f.id === a)!.name).toBe("Base profile");
    expect(s().features.find((f) => f.id === b)!.suppressed).toBe(true);
    s().removeFeature(a);
    expect(s().features.map((f) => f.id)).toEqual([b]);
  });

  it("reorderFeature moves a feature and clamps the index", () => {
    const a = s().addFeature({ type: "sketch" });
    const b = s().addFeature({ type: "extrude" });
    const c = s().addFeature({ type: "fillet" });
    s().reorderFeature(c, 0); // move last to front
    expect(s().features.map((f) => f.id)).toEqual([c, a, b]);
    s().reorderFeature(c, 99); // clamp to end
    expect(s().features.map((f) => f.id)).toEqual([a, b, c]);
  });

  it("the rollback bar follows its anchor feature across edits (CADStudio.md §5.3)", () => {
    const f1 = s().addFeature({ type: "sketch" });
    s().addFeature({ type: "extrude" });
    const f3 = s().addFeature({ type: "fillet" });
    s().setRollback(2); // roll back before f3 (index 2)
    expect(s().rollbackIndex).toBe(2);

    // Removing an earlier feature shifts f3 to index 1 — the bar must follow.
    s().removeFeature(f1);
    expect(s().rollbackIndex).toBe(1);

    // Reordering keeps the bar on the same anchor feature.
    s().reorderFeature(f3, 0);
    expect(s().rollbackIndex).toBe(0);

    // Removing the anchor feature itself clears the rollback.
    s().removeFeature(f3);
    expect(s().rollbackIndex).toBeNull();
  });
});

describe("CAD Studio store — selection (FR-2/FR-8/FR-9)", () => {
  it("setSelMode switches mode and preserves picks for chained selections", () => {
    s().pick({ kind: "face", id: 3 });
    s().setSelMode("edge");
    expect(s().selMode).toBe("edge");
    expect(s().picks).toEqual([{ kind: "face", id: 3 }]);
  });

  it("pick replaces by default and toggles additively", () => {
    s().pick({ kind: "face", id: 1 });
    s().pick({ kind: "face", id: 2 }); // replace
    expect(s().picks).toEqual([{ kind: "face", id: 2 }]);
    s().pick({ kind: "face", id: 3 }, true); // add
    expect(s().picks).toHaveLength(2);
    s().pick({ kind: "face", id: 3 }, true); // toggle off
    expect(s().picks).toEqual([{ kind: "face", id: 2 }]);
  });
});

describe("CAD Studio store — placement (FR-11 gizmo write-back)", () => {
  it("upsertPlacement creates a single placement feature, then merges into it", () => {
    s().addFeature({ type: "box", params: { dx: 0.06, dy: 0.04, dz: 0.03 } });
    s().upsertPlacement({ tx: 0.01, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0 });
    const placements = () => s().features.filter((f) => f.type === "placement");
    expect(placements()).toHaveLength(1);
    expect(placements()[0]!.params).toMatchObject({ tx: 0.01 });

    // A second upsert updates the SAME feature (no duplicate placement).
    s().upsertPlacement({ tx: 0.02, rz: 1 });
    expect(placements()).toHaveLength(1);
    expect(placements()[0]!.params).toMatchObject({ tx: 0.02, rz: 1 });
  });

  it("setGizmoMode switches the transform-gizmo mode", () => {
    expect(s().gizmoMode).toBe("translate");
    s().setGizmoMode("rotate");
    expect(s().gizmoMode).toBe("rotate");
  });

  it("toggleMeasure flips the tool and clears the readout when turned off", () => {
    s().setMeasureResult("50.00 mm");
    s().toggleMeasure(); // on — keeps any existing result
    expect(s().measuring).toBe(true);
    s().toggleMeasure(); // off — clears the readout
    expect(s().measuring).toBe(false);
    expect(s().measureResult).toBeNull();
  });
});

describe("CAD Studio store — undo / redo (FR-23 / M2.2)", () => {
  it("undo reverts the last document edit; redo replays it", () => {
    const id = s().addFeature({ type: "box", params: { dx: 0.06 } });
    s().updateParams(id, { dx: 0.09 });
    expect(s().features[0]!.params).toEqual({ dx: 0.09 });

    s().undo(); // back to dx 0.06
    expect(s().features[0]!.params).toEqual({ dx: 0.06 });
    s().undo(); // back to empty (before addFeature)
    expect(s().features).toHaveLength(0);

    s().redo(); // re-add the box
    expect(s().features).toHaveLength(1);
    expect(s().features[0]!.params).toEqual({ dx: 0.06 });
    s().redo(); // re-apply dx 0.09
    expect(s().features[0]!.params).toEqual({ dx: 0.09 });
  });

  it("a new edit after undo clears the redo stack", () => {
    const id = s().addFeature({ type: "box", params: { dx: 0.06 } });
    s().updateParams(id, { dx: 0.09 });
    s().undo();
    expect(s().future).toHaveLength(1);
    s().updateParams(id, { dx: 0.07 }); // diverge
    expect(s().future).toHaveLength(0);
    s().redo(); // no-op now
    expect(s().features[0]!.params).toEqual({ dx: 0.07 });
  });

  it("undo with empty history is a no-op", () => {
    expect(s().past).toHaveLength(0);
    s().undo();
    expect(s().features).toHaveLength(0);
  });

  it("live param writes coalesce into ONE undo step (feature-edit gizmo history flood fix)", () => {
    // The feature-edit gizmo opens a session right after addFeature (which snapshots the
    // pre-feature state), then streams param writes as the user drags/scrubs/types: the
    // FIRST write carries history, every later write suppresses it. A whole drag must add
    // exactly ONE undo entry — not one per frame — so it neither deep-clones the doc per
    // tick nor evicts real undo states from the 100-cap stack.
    const id = s().addFeature({ type: "extrude", params: { height: 0.02 } });
    const baseline = s().past.length; // 1: the pre-feature snapshot from addFeature
    s().updateParams(id, { height: 0.03 }, { history: true }); // first write → checkpoint
    s().updateParams(id, { height: 0.04 }, { history: false }); // live frame
    s().updateParams(id, { height: 0.05 }, { history: false }); // live frame
    expect(s().past.length).toBe(baseline + 1); // exactly one new entry, not three
    expect(s().features[0]!.params).toEqual({ height: 0.05 });

    s().undo(); // reverts the whole sizing burst to the seeded default (one step)
    expect(s().features[0]!.params).toEqual({ height: 0.02 });
    s().undo(); // removes the feature (addFeature's snapshot)
    expect(s().features).toHaveLength(0);
  });

  it("undo restores nextSeq so re-created features don't skip ids (CADStudio.md §5.2)", () => {
    const f1 = s().addFeature({ type: "box", params: { dx: 0.06, dy: 0.04, dz: 0.03 } });
    expect(f1).toBe("f1");
    s().undo();
    expect(s().features).toHaveLength(0);
    // Re-creating continues from f1 (nextSeq was rolled back), not a skipped f2.
    const again = s().addFeature({ type: "box", params: { dx: 0.06, dy: 0.04, dz: 0.03 } });
    expect(again).toBe("f1");
  });
});

describe("CAD Studio store — assembly (FR-33/FR-34 / M4)", () => {
  it("addInstance grounds the first instance and offsets later ones", () => {
    const i0 = s().addInstance();
    const i1 = s().addInstance();
    const insts = s().assembly.instances;
    expect(insts).toHaveLength(2);
    expect(insts[0]!.id).toBe(i0);
    expect(insts[0]!.fixed).toBe(true); // first = ground
    expect(insts[1]!.id).toBe(i1);
    expect(insts[1]!.fixed).toBeFalsy();
    expect(insts[1]!.pose.position[0]).toBeGreaterThan(0); // offset along +X
  });

  it("a coincident mate re-solves the assembly poses", () => {
    const i0 = s().addInstance();
    const i1 = s().addInstance();
    s().addMate({
      id: "m0",
      kind: "coincident",
      a: { instance: i0, point: [0.03, 0, 0] },
      b: { instance: i1, point: [-0.03, 0, 0] },
    });
    // i1 (free) moved so its local point coincides with i0's at world (0.03,0,0).
    const i1pose = s().assembly.instances[1]!.pose;
    expect(i1pose.position[0]).toBeCloseTo(0.06, 3);
  });

  it("removeInstance drops it and any mates referencing it", () => {
    const i0 = s().addInstance();
    const i1 = s().addInstance();
    s().addMate({
      id: "m0",
      kind: "coincident",
      a: { instance: i0, point: [0, 0, 0] },
      b: { instance: i1, point: [0, 0, 0] },
    });
    s().removeInstance(i1);
    expect(s().assembly.instances).toHaveLength(1);
    expect(s().assembly.mates).toHaveLength(0);
  });

  it("removeInstance re-solves the remaining assembly (CADStudio.md §5.4)", () => {
    const i0 = s().addInstance(); // ground (fixed)
    const i1 = s().addInstance(); // free
    s().addMate({
      id: "m2",
      kind: "coincident",
      a: { instance: i0, point: [0.03, 0, 0] },
      b: { instance: i1, point: [-0.03, 0, 0] },
    });
    expect(s().assemblyResult).not.toBeNull();
    // Removing the ground drops the mate AND re-solves: only the free i1 is left,
    // unconstrained → 6 DOF. (Without the re-solve the result would be stale.)
    s().removeInstance(i0);
    expect(s().assemblyResult!.freedom).toBe(6);
    expect(s().assemblyResult!.verdict).toBe("under-constrained");
  });

  it("toggleInstanceFixed re-solves the assembly (CADStudio.md §5.4)", () => {
    s().addInstance(); // i0 ground
    const i1 = s().addInstance(); // i1 free
    // Grounding i1 too leaves no free DOF → a re-solve must run and report 0.
    s().toggleInstanceFixed(i1);
    expect(s().assemblyResult).not.toBeNull();
    expect(s().assemblyResult!.freedom).toBe(0);
    expect(s().assemblyResult!.verdict).toBe("well-constrained");
  });

  it("pick two instance faces → applyMate builds + solves a mate", () => {
    // Face normals come from the build's selection refs (shared part geometry).
    s().setSelectionRefs({ faces: { 1: { normal: [1, 0, 0] } }, edges: {} });
    const i0 = s().addInstance();
    const i1 = s().addInstance();
    s().setMateMode(true);
    s().addMatePick({ instanceId: i0, faceId: 1, worldPoint: [0.03, 0, 0] });
    s().addMatePick({ instanceId: i1, faceId: 1, worldPoint: [0.05, 0, 0] });
    expect(s().matePicks).toHaveLength(2);
    s().applyMate("coincident");
    expect(s().assembly.mates).toHaveLength(1);
    expect(s().assembly.mates[0]!.kind).toBe("coincident");
    expect(s().matePicks).toHaveLength(0); // consumed
    expect(s().assemblyResult).not.toBeNull();
    expect(s().assemblyResult!.residualNorm).toBeLessThan(1e-5);
  });

  it("applyMate('distance', v) builds a distance mate carrying v (SI) and solves it", () => {
    s().setSelectionRefs({ faces: { 1: { normal: [1, 0, 0] } }, edges: {} });
    const i0 = s().addInstance(); // ground (fixed)
    const i1 = s().addInstance(); // free
    s().setMateMode(true);
    s().addMatePick({ instanceId: i0, faceId: 1, worldPoint: [0.03, 0, 0] });
    s().addMatePick({ instanceId: i1, faceId: 1, worldPoint: [0.05, 0, 0] });
    s().applyMate("distance", 0.05); // 50 mm, passed in SI metres
    const mates = s().assembly.mates;
    expect(mates).toHaveLength(1);
    expect(mates[0]).toMatchObject({ kind: "distance", value: 0.05 });
    // The free instance was positioned to satisfy the separation (residual ≈ 0).
    expect(s().assemblyResult!.residualNorm).toBeLessThan(1e-5);
  });

  it("setMateValue updates a distance mate's scalar and re-solves; bad id is a no-op", () => {
    s().setSelectionRefs({ faces: { 1: { normal: [1, 0, 0] } }, edges: {} });
    const i0 = s().addInstance();
    const i1 = s().addInstance();
    s().setMateMode(true);
    s().addMatePick({ instanceId: i0, faceId: 1, worldPoint: [0.03, 0, 0] });
    s().addMatePick({ instanceId: i1, faceId: 1, worldPoint: [0.05, 0, 0] });
    s().applyMate("distance", 0.05);
    const id = s().assembly.mates[0]!.id;

    s().setMateValue(id, 0.12); // retarget to 120 mm
    expect(s().assembly.mates[0]).toMatchObject({ kind: "distance", value: 0.12 });
    expect(s().assemblyResult!.residualNorm).toBeLessThan(1e-5);

    // An unknown id changes nothing (the existing mate keeps its value).
    s().setMateValue("does-not-exist", 0.99);
    expect(s().assembly.mates).toHaveLength(1);
    expect(s().assembly.mates[0]).toMatchObject({ value: 0.12 });
  });

  it("matePicks keep only the last two picks", () => {
    s().setSelectionRefs({ faces: { 1: { normal: [0, 0, 1] } }, edges: {} });
    const i0 = s().addInstance();
    s().addMatePick({ instanceId: i0, faceId: 1, worldPoint: [0, 0, 0] });
    s().addMatePick({ instanceId: i0, faceId: 1, worldPoint: [0.01, 0, 0] });
    s().addMatePick({ instanceId: i0, faceId: 1, worldPoint: [0.02, 0, 0] });
    expect(s().matePicks).toHaveLength(2);
  });

  it("applyJoint builds a joint from two picks; setJointDrive is transient", () => {
    s().setSelectionRefs({ faces: { 1: { normal: [0, 0, 1] } }, edges: {} });
    const i0 = s().addInstance();
    const i1 = s().addInstance();
    s().setMateMode(true);
    s().addMatePick({ instanceId: i0, faceId: 1, worldPoint: [0, 0, 0] });
    s().addMatePick({ instanceId: i1, faceId: 1, worldPoint: [0.08, 0, 0] });
    s().applyJoint("revolute");
    const joints = s().assembly.joints;
    expect(joints).toHaveLength(1);
    expect(joints[0]!).toMatchObject({ kind: "revolute", parent: i0, child: i1 });
    expect(s().matePicks).toHaveLength(0);

    const jid = joints[0]!.id;
    s().setJointDrive(jid, 0.5);
    expect(s().jointDrive[jid]).toBe(0.5);
    // Driving doesn't push history (transient preview).
    const pastLen = s().past.length;
    s().setJointDrive(jid, 1.0);
    expect(s().past.length).toBe(pastLen);
  });

  it("assembly edits are undoable", () => {
    s().addInstance();
    expect(s().assembly.instances).toHaveLength(1);
    s().undo();
    expect(s().assembly.instances).toHaveLength(0);
    s().redo();
    expect(s().assembly.instances).toHaveLength(1);
  });
});

describe("CAD Studio store — document I/O (FR-39 reproducible reload)", () => {
  it("toDocument → loadDocument round-trips and re-derives nextSeq", () => {
    s().addFeature({ type: "sketch" });
    s().addFeature({ type: "extrude", params: { height: 0.02 } });
    s().setParam("wall", 0.002);
    const doc = s().toDocument();

    s().reset();
    expect(s().features).toHaveLength(0);

    s().loadDocument(doc);
    expect(s().features.map((f) => f.id)).toEqual(["f1", "f2"]);
    expect(s().params).toEqual({ wall: 0.002 });
    // New features continue the sequence (no id collision).
    const next = s().addFeature({ type: "fillet" });
    expect(next).toBe("f3");
  });

  it("§2.12.1: replaceDocument PRESERVES undo; loadDocument wipes it", () => {
    // A manual edit the user would not want an AI apply to erase.
    s().addFeature({ type: "box", params: { dx: 0.06, dy: 0.04, dz: 0.03 } });
    expect(s().features).toHaveLength(1);

    // An AI/ML apply swaps the whole document via replaceDocument.
    const aiDoc = {
      features: [{ id: "f9", type: "sketch" as const, data: {} }],
      params: {},
    };
    s().replaceDocument(aiDoc);
    expect(s().features.map((f) => f.id)).toEqual(["f9"]); // the AI doc is live

    // The accepted AI edit is a SINGLE undoable step — undo restores the manual work.
    s().undo();
    expect(s().features).toHaveLength(1);
    expect(s().features[0]!.type).toBe("box"); // back to the user's box

    // Contrast: loadDocument (project open / recovery) WIPES history.
    s().addFeature({ type: "fillet" });
    s().loadDocument(aiDoc);
    expect(s().past).toHaveLength(0);
    expect(s().future).toHaveLength(0);
  });

  it("reloads an assembly with mates without reissuing a colliding id (CADStudio.md §5.1)", () => {
    const i1 = s().addInstance(); // i1
    const i2 = s().addInstance(); // i2
    // A mate whose id (m3) is minted off the SAME shared counter as i1/i2 —
    // exactly the document shape applyMate produces.
    s().addMate({
      id: "m3",
      kind: "coincident",
      a: { instance: i1, point: [0, 0, 0] },
      b: { instance: i2, point: [0, 0, 0] },
    });
    const doc = s().toDocument();

    s().reset();
    s().loadDocument(doc);

    // The mate survived the round-trip…
    expect(s().assembly.mates.map((m) => m.id)).toContain("m3");
    // …and nextSeq cleared the mate id, so the next minted m-id is m4, not a
    // colliding m3. (With the old /^[fi]/ derivation this would be 3.)
    expect(s().nextSeq).toBe(4);
  });

  it("the document is a deep copy (mutating it does not affect the store)", () => {
    const id = s().addFeature({ type: "extrude", params: { height: 0.02 } });
    const doc = s().toDocument();
    doc.params.height = 999;
    (doc.features[0]!.params as Record<string, number>).height = 999;
    expect(s().features.find((f) => f.id === id)!.params!.height).toBe(0.02);
  });
});

describe("CAD Studio store — sim playback (FR-41)", () => {
  it("setSimulating resets playback to a clean, playing, t=0 state", () => {
    s().setSimPaused(true);
    s().setSimTicks(99);
    s().setSimulating(true);
    expect(s().simulating).toBe(true);
    expect(s().simPaused).toBe(false);
    expect(s().simTicks).toBe(0);
  });

  it("pause + step/rewind requests update state and bump monotonic nonces", () => {
    s().setSimPaused(true);
    expect(s().simPaused).toBe(true);

    const step0 = s().simStepReq;
    const rewind0 = s().simRewindReq;
    s().requestSimStep();
    s().requestSimStep();
    s().requestSimRewind();
    // Monotonic tokens (never reset mid-run) so the viewport sees each command once.
    expect(s().simStepReq).toBe(step0 + 2);
    expect(s().simRewindReq).toBe(rewind0 + 1);

    s().setSimTicks(48);
    expect(s().simTicks).toBe(48);
  });

  it("setSimExperiment patches the recipe and restarts only while simulating", () => {
    const r0 = s().simRestartReq;
    s().setSimExperiment({ kind: "free-fall", dropHeight: 0.25 });
    expect(s().simExperiment.kind).toBe("free-fall");
    expect(s().simExperiment.dropHeight).toBe(0.25);
    // Not simulating → no rebuild request.
    expect(s().simRestartReq).toBe(r0);

    s().setSimulating(true);
    const r1 = s().simRestartReq;
    s().setSimExperiment({ gravityScale: 0.16 });
    expect(s().simExperiment.gravityScale).toBe(0.16);
    expect(s().simRestartReq).toBe(r1 + 1);
  });

  it("requestSimRestart bumps the rebuild token", () => {
    const r0 = s().simRestartReq;
    s().requestSimRestart();
    expect(s().simRestartReq).toBe(r0 + 1);
  });
});

describe("CAD Studio store — editing during a running sim auto-stops it (§2.11.4)", () => {
  const STOP_NOTE = "simulation stopped — the document changed (press Simulate to rerun)";

  const startSim = (): void => {
    s().setWorkspace("simulate");
    expect(s().simulating).toBe(true);
  };

  it("a feature edit stops the sim with the status note; the workspace is kept", () => {
    s().addFeature({ type: "box", params: { dx: 0.04, dy: 0.03, dz: 0.02 } });
    startSim();
    s().addFeature({ type: "fillet" });
    expect(s().simulating).toBe(false);
    expect(s().simPaused).toBe(false);
    expect(s().simTicks).toBe(0);
    expect(s().status).toBe(STOP_NOTE);
    expect(s().workspace).toBe("simulate"); // stays on the Simulate tab, can rerun
  });

  it("a history-less live drag (updateParams history:false) still stops the sim", () => {
    const id = s().addFeature({ type: "box", params: { dx: 0.04, dy: 0.03, dz: 0.02 } });
    startSim();
    const pastBefore = s().past.length;
    s().updateParams(id, { dx: 0.05 }, { history: false });
    expect(s().simulating).toBe(false);
    expect(s().status).toBe(STOP_NOTE);
    expect(s().past).toHaveLength(pastBefore); // still no undo snapshot
  });

  it("undo and redo mid-sim stop the sim (the document is swapped under the world)", () => {
    s().addFeature({ type: "box", params: { dx: 0.04, dy: 0.03, dz: 0.02 } });
    startSim();
    s().undo();
    expect(s().simulating).toBe(false);
    expect(s().status).toBe(STOP_NOTE);

    startSim();
    s().redo();
    expect(s().simulating).toBe(false);
    expect(s().status).toBe(STOP_NOTE);
  });

  it("assembly edits and document loads mid-sim stop the sim", () => {
    s().addInstance();
    startSim();
    s().addInstance();
    expect(s().simulating).toBe(false);
    expect(s().status).toBe(STOP_NOTE);

    startSim();
    s().replaceDocument({ features: [{ id: "f9", type: "sketch", data: {} }], params: {} });
    expect(s().simulating).toBe(false);

    startSim();
    s().loadDocument({ features: [], params: {} });
    expect(s().simulating).toBe(false);
  });

  it("moving the rollback bar mid-sim stops the sim (it changes what builds)", () => {
    s().addFeature({ type: "box", params: { dx: 0.04, dy: 0.03, dz: 0.02 } });
    s().addFeature({ type: "fillet" });
    startSim();
    s().setRollback(1);
    expect(s().simulating).toBe(false);
    expect(s().status).toBe(STOP_NOTE);
  });

  it("non-document interactions do NOT stop the sim", () => {
    const id = s().addFeature({ type: "box", params: { dx: 0.04, dy: 0.03, dz: 0.02 } });
    startSim();
    s().selectFeature(id); // selection is view state
    s().setJointDrive("j1", 0.5); // transient motion preview
    s().setSimPaused(true); // playback control
    s().setSimExperiment({ gravityScale: 0.5 }); // live recipe → restart, not stop
    expect(s().simulating).toBe(true);
    expect(s().status).not.toBe(STOP_NOTE);
  });
});

describe("CAD Studio store — undo/redo & mate-id correctness (S1–S3)", () => {
  it("S1: undo re-anchors the rollback bar to its feature, not a stale index", () => {
    s().addFeature({ type: "sketch" }); // f1
    s().addFeature({ type: "extrude", params: { height: 0.02 } }); // f2
    s().addFeature({ type: "fillet", params: { radius: 0.002 } }); // f3
    s().setRollback(2); // roll back before f3 (index 2)
    expect(s().rollbackIndex).toBe(2);
    s().removeFeature("f1"); // f3 slides to index 1; rollback follows its anchor
    expect(s().rollbackIndex).toBe(1);
    s().undo(); // f1 restored → f3 is back at index 2, so the bar must follow
    expect(s().features.map((f) => f.id)).toEqual(["f1", "f2", "f3"]);
    expect(s().rollbackBeforeId).toBe("f3");
    expect(s().rollbackIndex).toBe(2); // before the fix this stayed 1 → wrong build slice
  });

  it("S2: undo reverts the assembly verdict in lock-step with the assembly", () => {
    s().addInstance(); // i1 (ground)
    s().addInstance(); // i2 (free)
    const before = s().assemblyResult; // null — addInstance doesn't solve
    s().addMate({
      id: "m1",
      kind: "coincident",
      a: { instance: "i1", point: [0, 0, 0] },
      b: { instance: "i2", point: [0, 0, 0] },
    });
    expect(s().assemblyResult).not.toBeNull(); // solved with the mate present
    s().undo(); // mate removed
    expect(s().assembly.mates).toHaveLength(0);
    expect(s().assemblyResult).toEqual(before); // reverted; before the fix it stayed stale
  });

  it("S3: applyMate reuses the same mate id after an undo (no skipped id)", () => {
    const i0 = s().addInstance();
    const i1 = s().addInstance();
    s().setSelectionRefs({ faces: { 1: { normal: [0, 0, 1] } }, edges: {} });
    const stage = (): void => {
      s().setMateMode(true);
      s().addMatePick({ instanceId: i0, faceId: 1, worldPoint: [0, 0, 0] });
      s().addMatePick({ instanceId: i1, faceId: 1, worldPoint: [0, 0, 0] });
    };
    stage();
    s().applyMate("coincident");
    const firstId = s().assembly.mates.at(-1)!.id;
    s().undo(); // removes the mate AND must roll nextSeq back
    expect(s().assembly.mates).toHaveLength(0);
    stage();
    s().applyMate("coincident");
    expect(s().assembly.mates.at(-1)!.id).toBe(firstId); // before the fix: a skipped id
  });
});
