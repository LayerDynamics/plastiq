// Mate authoring input path (M4.2 / §2.9).
//
// This covers the step that did not exist: `addMatePick` had NO caller anywhere
// in the app, so "Add mate → Picking 0/2" could never advance and every mate
// menu item was permanently disabled for a real user. The existing e2e passed
// only because it drove the store seam directly, bypassing the missing wiring —
// so these tests resolve a pick the way a viewport CLICK does, then drive the
// real store through to a solved mate.

import { beforeEach, describe, expect, it } from "vitest";
import type * as THREE from "three";
import { buildPart } from "./buildMesh.js";
import { resolveMatePick } from "./matePick.js";
import { useCadStore } from "../store/store.js";
import type { TransferMesh } from "../worker/protocol.js";

// Both fixture faces lie in the z=0 plane, so they share its analytic signature
// (§2.1) — the identity a FaceGroup carries alongside its averaged normal.
const PLANE_Z0 = { kind: "plane", normal: [0, 0, 1], origin: [0, 0, 0] } as const;

/** A unit quad in z=0 split into two B-rep faces (the pick.test.ts fixture). */
function quad(): TransferMesh {
  return {
    vertices: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    faceGroups: [
      { faceId: 7, start: 0, count: 3, normal: [0, 0, 1], centroid: [0.667, 0.333, 0], surface: PLANE_Z0 },
      { faceId: 9, start: 3, count: 3, normal: [0, 0, 1], centroid: [0.333, 0.667, 0], surface: PLANE_Z0 },
    ],
    edges: [],
    vertexIds: [11, 12, 13, 14],
    vertexPositions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
  };
}

const meshOf = (): THREE.Mesh => buildPart(quad()).mesh;

describe("resolveMatePick — an instance click → a mate pick", () => {
  it("resolves the clicked triangle to its B-rep faceId and world point", () => {
    const pick = resolveMatePick({
      instanceId: "i1",
      button: 0,
      faceIndex: 1, // second triangle → the group carrying faceId 9
      object: meshOf(),
      point: { x: 0.3, y: 0.7, z: 0 },
    });
    expect(pick).toEqual({ instanceId: "i1", faceId: 9, worldPoint: [0.3, 0.7, 0] });
  });

  it("ignores a right/middle click (those open the menu, they don't author a mate)", () => {
    const object = meshOf();
    expect(resolveMatePick({ instanceId: "i1", button: 2, faceIndex: 0, object, point: { x: 0, y: 0, z: 0 } })).toBeNull();
    expect(resolveMatePick({ instanceId: "i1", button: 1, faceIndex: 0, object, point: { x: 0, y: 0, z: 0 } })).toBeNull();
  });

  it("ignores a hit that carries no triangle, or one outside every face group", () => {
    const object = meshOf();
    expect(
      resolveMatePick({ instanceId: "i1", button: 0, faceIndex: undefined, object, point: { x: 0, y: 0, z: 0 } }),
    ).toBeNull();
    expect(
      resolveMatePick({ instanceId: "i1", button: 0, faceIndex: 99, object, point: { x: 0, y: 0, z: 0 } }),
    ).toBeNull();
  });
});

describe("mate picking drives the real store (the path that had no caller)", () => {
  beforeEach(() => {
    useCadStore.setState({
      assembly: { instances: [], mates: [], joints: [] },
      matePicks: [],
      selectionRefs: { faces: {}, edges: {} },
      assemblyResult: null,
    });
  });

  it("two resolved instance clicks advance Picking 0/2 → 2/2 and apply a mate", () => {
    const store = useCadStore.getState();
    // Two instances of the part, and the face refs a build publishes.
    const a = store.addInstance();
    const b = store.addInstance();
    useCadStore.setState({
      selectionRefs: {
        faces: {
          7: { normal: [0, 0, 1], centroid: [0.667, 0.333, 0] },
          9: { normal: [0, 0, 1], centroid: [0.333, 0.667, 0] },
        },
        edges: {},
      },
    });

    const object = meshOf();
    // Click instance A's face 7, then instance B's face 9 — exactly what the
    // viewport handler now does on a left-click.
    for (const [instanceId, faceIndex, point] of [
      [a, 0, { x: 0.6, y: 0.3, z: 0 }],
      [b, 1, { x: 0.3, y: 0.6, z: 0 }],
    ] as const) {
      const pick = resolveMatePick({ instanceId, button: 0, faceIndex, object, point });
      expect(pick).not.toBeNull();
      useCadStore.getState().addMatePick(pick!);
    }

    // The counter AssemblyTree renders, and every mate menu item's gate.
    expect(useCadStore.getState().matePicks).toHaveLength(2);

    useCadStore.getState().applyMate("coincident");
    const after = useCadStore.getState();
    expect(after.assembly.mates).toHaveLength(1);
    expect(after.assembly.mates[0]!.kind).toBe("coincident");
    // The solver ran — a verdict is published rather than left null.
    expect(after.assemblyResult).not.toBeNull();
    // Picks are consumed, so the next mate starts from 0/2 again.
    expect(after.matePicks).toHaveLength(0);
  });

  it("a pick on an unknown face id is dropped (no ref ⇒ nothing to mate)", () => {
    const store = useCadStore.getState();
    const a = store.addInstance();
    // selectionRefs deliberately empty: the build published no face 7.
    useCadStore.getState().addMatePick({ instanceId: a, faceId: 7, worldPoint: [0, 0, 0] });
    expect(useCadStore.getState().matePicks).toHaveLength(0);
  });
});
