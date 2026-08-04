// R4 / S1 — a rebuild must never leave a pick silently pointing at a DIFFERENT
// entity. These tests pin `remapPicks`: a pick follows its face/edge across a
// rebuild that re-numbers render-group ids, or it clears when its entity is gone.

import { describe, expect, it } from "vitest";

import { remapPicks, samePickList } from "./pickRemap.js";
import type { SelectionRefs } from "../store/store.js";
import type { Pick } from "../store/types.js";
import type { SurfaceSignature } from "@plastiq/cad";

const plane = (n: [number, number, number], o: [number, number, number]): SurfaceSignature => ({
  kind: "plane",
  normal: n,
  origin: o,
});
const cyl = (r: number, axisPoint: [number, number, number]): SurfaceSignature => ({
  kind: "cylinder",
  axis: [0, 0, 1],
  axisPoint,
  radius: r,
});

describe("R4 — remapPicks follows entities across a re-numbering rebuild", () => {
  it("remaps a face pick when its id moved to a different render-group slot", () => {
    // Old: the top plane is face id 0. New build: the SAME top plane is now id 5
    // (a hole added ahead of it shifted the group order) — and id 0 is now a wall.
    const old: SelectionRefs = {
      faces: {
        0: { normal: [0, 0, 1], centroid: [0, 0, 1], surface: plane([0, 0, 1], [0, 0, 1]) },
      },
      edges: {},
    };
    const neu: SelectionRefs = {
      faces: {
        0: { normal: [1, 0, 0], centroid: [1, 0, 0], surface: plane([1, 0, 0], [1, 0, 0]) },
        5: { normal: [0, 0, 1], centroid: [0, 0, 1], surface: plane([0, 0, 1], [0, 0, 1]) },
      },
      edges: {},
    };
    const picks: Pick[] = [{ kind: "face", id: 0 }];
    expect(remapPicks(picks, old, neu)).toEqual([{ kind: "face", id: 5 }]);
  });

  it("follows a moved/resized curved face by surface KIND + closest centroid", () => {
    // A hole wall (cylinder r=8 @ x=0) after a diameter change to r=10 — the exact
    // surface no longer matches, but the same wall is the only cylinder nearby.
    const old: SelectionRefs = {
      faces: { 3: { normal: [1, 0, 0], centroid: [0, 0, 0.5], surface: cyl(0.008, [0, 0, 0]) } },
      edges: {},
    };
    const neu: SelectionRefs = {
      faces: {
        1: { normal: [0, 0, 1], centroid: [0, 0, 1], surface: plane([0, 0, 1], [0, 0, 1]) },
        2: { normal: [1, 0, 0], centroid: [0, 0, 0.5], surface: cyl(0.01, [0, 0, 0]) },
      },
      edges: {},
    };
    expect(remapPicks([{ kind: "face", id: 3 }], old, neu)).toEqual([{ kind: "face", id: 2 }]);
  });

  it("DROPS a pick whose face was deleted (no same-kind survivor)", () => {
    const old: SelectionRefs = {
      faces: { 0: { normal: [1, 0, 0], centroid: [5, 5, 5], surface: cyl(0.008, [5, 5, 0]) } },
      edges: {},
    };
    const neu: SelectionRefs = {
      faces: {
        0: { normal: [0, 0, 1], centroid: [0, 0, 0], surface: plane([0, 0, 1], [0, 0, 0]) },
      },
      edges: {},
    };
    // The only new face is a plane — no cylinder to match. Pick clears, never rebinds.
    expect(remapPicks([{ kind: "face", id: 0 }], old, neu)).toEqual([]);
  });

  it("remaps an edge pick by its adjacent-surface pair", () => {
    const oldEdge = {
      faceNormals: [
        [0, 0, 1],
        [1, 0, 0],
      ] as [[number, number, number], [number, number, number]],
      midpoint: [0.5, 0, 0] as [number, number, number],
      faceSurfaces: [plane([0, 0, 1], [0, 0, 0]), plane([1, 0, 0], [0, 0, 0])] as [
        SurfaceSignature,
        SurfaceSignature,
      ],
    };
    const old: SelectionRefs = { faces: {}, edges: { 2: oldEdge } };
    const neu: SelectionRefs = { faces: {}, edges: { 9: oldEdge } };
    expect(remapPicks([{ kind: "edge", id: 2 }], old, neu)).toEqual([{ kind: "edge", id: 9 }]);
  });

  it("drops a face pick that has no stored ref (cannot be validated)", () => {
    const old: SelectionRefs = { faces: {}, edges: {} };
    const neu: SelectionRefs = {
      faces: {
        0: { normal: [0, 0, 1], centroid: [0, 0, 0], surface: plane([0, 0, 1], [0, 0, 0]) },
      },
      edges: {},
    };
    expect(remapPicks([{ kind: "face", id: 7 }], old, neu)).toEqual([]);
  });

  it("remaps a vertex pick by its VertexRef position (R12)", () => {
    // Old: corner at origin is vertex id 0. New build re-numbers it to id 7.
    const old: SelectionRefs = {
      faces: {},
      edges: {},
      vertices: { 0: { position: [0, 0, 0] } },
    };
    const neu: SelectionRefs = {
      faces: {},
      edges: {},
      vertices: {
        3: { position: [0.06, 0.04, 0.03] },
        7: { position: [0, 0, 0] },
      },
    };
    expect(remapPicks([{ kind: "vertex", id: 0 }], old, neu)).toEqual([{ kind: "vertex", id: 7 }]);
  });

  it("DROPS a vertex pick whose corner was deleted (no near position survivor)", () => {
    const old: SelectionRefs = {
      faces: {},
      edges: {},
      vertices: { 0: { position: [5, 5, 5] } },
    };
    const neu: SelectionRefs = {
      faces: {},
      edges: {},
      vertices: { 0: { position: [0, 0, 0] } },
    };
    // Cap is 1 m² — (5,5,5) is far past any survivor. Pick clears, never rebinds.
    expect(remapPicks([{ kind: "vertex", id: 0 }], old, neu)).toEqual([]);
  });

  it("passes body picks through unchanged; drops vertex picks with no stored ref", () => {
    const empty: SelectionRefs = { faces: {}, edges: {}, vertices: {} };
    expect(remapPicks([{ kind: "body", id: 0 }], empty, empty)).toEqual([{ kind: "body", id: 0 }]);
    // No VertexRef in oldRefs → cannot validate → drop rather than keep a stale id.
    expect(remapPicks([{ kind: "vertex", id: 3 }], empty, empty)).toEqual([]);
  });

  it("samePickList detects equality and difference", () => {
    expect(samePickList([{ kind: "face", id: 1 }], [{ kind: "face", id: 1 }])).toBe(true);
    expect(samePickList([{ kind: "face", id: 1 }], [{ kind: "face", id: 2 }])).toBe(false);
    expect(samePickList([{ kind: "face", id: 1 }], [])).toBe(false);
  });
});
