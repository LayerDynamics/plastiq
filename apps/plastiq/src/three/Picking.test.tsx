// @vitest-environment jsdom
// Picking — R3F effect component (returns null; GPU-id render-target picking). It
// wires canvas pointer events, so it needs a DOM (jsdom). With part=null it mounts
// and no-ops cleanly; the real GPU picking needs WebGL (e2e).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import ReactThreeTestRenderer from "@react-three/test-renderer";

import { completeBrepFacePicks, Picking } from "./Picking.js";
import { Picker } from "../viewport/pick.js";
import { buildPart } from "../viewport/buildMesh.js";
import { useCadStore } from "../store/store.js";
import type { TransferMesh } from "../worker/protocol.js";

// Both fixture faces lie in the z=0 plane, so they share its analytic signature
// (§2.1) — the identity a FaceGroup carries alongside its averaged normal.
const PLANE_Z0 = { kind: "plane", normal: [0, 0, 1], origin: [0, 0, 0] } as const;

// A unit quad (two triangles, two faces, four corners, one edge) — enough for a
// real BuiltPart so the component mounts and runs its highlight pass.
function quad(): TransferMesh {
  return {
    vertices: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    faceGroups: [
      { faceId: 7, start: 0, count: 3, normal: [0, 0, 1], centroid: [0.667, 0.333, 0], surface: PLANE_Z0 },
      { faceId: 9, start: 3, count: 3, normal: [0, 0, 1], centroid: [0.333, 0.667, 0], surface: PLANE_Z0 },
    ],
    edges: [
      {
        edgeId: 4,
        positions: new Float32Array([0, 0, 0, 1, 0, 0]),
        faceNormals: [
          [0, 0, 1],
          [0, -1, 0],
        ],
        faceSurfaces: [PLANE_Z0, { kind: "plane", normal: [0, -1, 0], origin: [0, 0, 0] }],
        midpoint: [0.5, 0, 0],
      },
    ],
    vertexIds: [11, 12, 13, 14],
    vertexPositions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
  };
}

// The same unit quad, but with its four sides as separate B-rep edges, so the
// candidate-cache assertion has several edge geometries to count bounding-sphere
// computes against (the single-edge quad() can't distinguish per-edge from per-move).
function multiEdgeQuad(): TransferMesh {
  const edge = (
    edgeId: number,
    positions: number[],
    midpoint: [number, number, number],
    faceIds: readonly [number, number] = [7, -1],
  ): TransferMesh["edges"][number] => ({
    edgeId,
    positions: new Float32Array(positions),
    faceNormals: [
      [0, 0, 1],
      [0, -1, 0],
    ],
    faceSurfaces: [PLANE_Z0, { kind: "plane", normal: [0, -1, 0], origin: [0, 0, 0] }],
    midpoint,
    faceIds,
  });
  return {
    vertices: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    faceGroups: [
      { faceId: 7, start: 0, count: 3, normal: [0, 0, 1], centroid: [0.667, 0.333, 0], surface: PLANE_Z0 },
      { faceId: 9, start: 3, count: 3, normal: [0, 0, 1], centroid: [0.333, 0.667, 0], surface: PLANE_Z0 },
    ],
    edges: [
      edge(1, [0, 0, 0, 1, 0, 0], [0.5, 0, 0]),
      edge(2, [1, 0, 0, 1, 1, 0], [1, 0.5, 0]),
      edge(3, [1, 1, 0, 0, 1, 0], [0.5, 1, 0]),
      edge(4, [0, 1, 0, 0, 0, 0], [0, 0.5, 0]),
    ],
    vertexIds: [11, 12, 13, 14],
    vertexPositions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
  };
}

// A no-drag left click: pointerdown on the canvas (sets the down anchor), then
// pointerup on window (the global handler that resolves the click) at the same
// coords so it reads as a click, not an orbit drag. MouseEvent carries the
// clientX/clientY/modifier fields the handlers read; the type strings route it to
// the pointerdown/pointerup listeners.
function click(canvas: HTMLElement, x: number, y: number): void {
  canvas.dispatchEvent(new MouseEvent("pointerdown", { clientX: x, clientY: y, bubbles: true }));
  window.dispatchEvent(new MouseEvent("pointerup", { clientX: x, clientY: y, bubbles: true }));
}

// The same no-drag click, but with Shift held on both events — the CAD-standard
// "add this entity to the current selection" gesture (additive pick).
function shiftClick(canvas: HTMLElement, x: number, y: number): void {
  canvas.dispatchEvent(
    new MouseEvent("pointerdown", { clientX: x, clientY: y, shiftKey: true, bubbles: true }),
  );
  window.dispatchEvent(
    new MouseEvent("pointerup", { clientX: x, clientY: y, shiftKey: true, bubbles: true }),
  );
}

describe("Picking (R3F)", () => {
  it("mounts and renders nothing without a part (guard)", async () => {
    const r = await ReactThreeTestRenderer.create(<Picking part={null} />);
    expect(r.scene.children.length).toBe(0);
    await r.unmount();
  });
});

describe("Picking — measure tool wiring (FR-13)", () => {
  beforeEach(() => useCadStore.getState().reset());
  afterEach(() => {
    vi.restoreAllMocks();
    useCadStore.getState().reset();
  });

  it("collects two clicked points and publishes the measurement to the store", async () => {
    const part = buildPart(quad());
    useCadStore.getState().toggleMeasure();
    expect(useCadStore.getState().measuring).toBe(true);
    // Edge mode so that if the measure branch ever regresses, the click falls
    // through to CPU-only selection (a clean assertion failure here) rather than
    // the face/body GPU path that jsdom can't run.
    useCadStore.getState().setSelMode("edge");

    // jsdom can't raycast (zero-size getBoundingClientRect), so stub the world
    // point each click resolves to: a 3-4-5 separation → 50 mm.
    vi.spyOn(Picker.prototype, "pickPoint")
      .mockReturnValueOnce(new THREE.Vector3(0, 0, 0))
      .mockReturnValueOnce(new THREE.Vector3(0.03, 0.04, 0));

    let canvas: HTMLCanvasElement | undefined;
    const r = await ReactThreeTestRenderer.create(<Picking part={part} />, {
      beforeReturn: (c) => {
        canvas = c;
      },
    });
    expect(canvas).toBeDefined();

    // First click banks the point and prompts for the second.
    click(canvas!, 10, 10);
    expect(useCadStore.getState().measureResult).toBe("Click second point");

    // Second click resolves the distance + axis deltas into the readout.
    click(canvas!, 20, 20);
    expect(useCadStore.getState().measureResult).toBe(
      "50.00 mm  (Δ 30.00 mm · 40.00 mm · 0.00 mm)",
    );

    await r.unmount();
  });

  it("a click does not measure (or call pickPoint) when the tool is off", async () => {
    const part = buildPart(quad());
    // Edge mode keeps the selection path on CPU raycasting (the face/body GPU-id
    // fallback needs real WebGL, which jsdom lacks); the point is only that the
    // measure branch never runs while the tool is off.
    useCadStore.getState().setSelMode("edge");
    expect(useCadStore.getState().measuring).toBe(false);
    const pickPoint = vi.spyOn(Picker.prototype, "pickPoint");

    let canvas: HTMLCanvasElement | undefined;
    const r = await ReactThreeTestRenderer.create(<Picking part={part} />, {
      beforeReturn: (c) => {
        canvas = c;
      },
    });

    click(canvas!, 10, 10);
    expect(pickPoint).not.toHaveBeenCalled();
    expect(useCadStore.getState().measureResult).toBeNull();

    await r.unmount();
  });
});

describe("Picking — additive selection (Shift+click)", () => {
  beforeEach(() => useCadStore.getState().reset());
  afterEach(() => {
    vi.restoreAllMocks();
    useCadStore.getState().reset();
  });

  it("Shift+click adds a second entity to the selection instead of no-opping", async () => {
    const part = buildPart(quad());
    // Edge mode keeps the pick path on CPU raycasting (which we stub) and off the
    // face/body GPU-id fallback that jsdom's missing WebGL can't run.
    useCadStore.getState().setSelMode("edge");

    // jsdom has zero-size getBoundingClientRect, so the real raycast/screen-nearest
    // fallbacks are unreliable — stub each click's resolved hit deterministically.
    vi.spyOn(Picker.prototype, "pick")
      .mockReturnValueOnce({ kind: "edge", id: 4 })
      .mockReturnValueOnce({ kind: "edge", id: 8 });

    let canvas: HTMLCanvasElement | undefined;
    const r = await ReactThreeTestRenderer.create(<Picking part={part} />, {
      beforeReturn: (c) => {
        canvas = c;
      },
    });
    expect(canvas).toBeDefined();

    // A plain click selects the first entity (replacing any prior selection).
    click(canvas!, 10, 10);
    expect(useCadStore.getState().picks).toEqual([{ kind: "edge", id: 4 }]);

    // Shift+click must ADD the second entity, keeping the first selected. Against
    // the unfixed code this pick never lands, so the selection would stay [edge 4].
    shiftClick(canvas!, 30, 30);
    expect(useCadStore.getState().picks).toEqual([
      { kind: "edge", id: 4 },
      { kind: "edge", id: 8 },
    ]);

    await r.unmount();
  });

  it("face mode rejects edge hits (R5 — selMode is a strict click filter)", async () => {
    const part = buildPart(quad());
    // Remove vertices so the only stubbed non-face hit is the edge — face mode must
    // ignore it rather than cascading through (the pre-R5 permissive behaviour).
    part.vertexPoints = null;
    useCadStore.getState().setSelMode("face");

    vi.spyOn(Picker.prototype, "pick").mockImplementation((_part, _ndc, _camera, mode) =>
      mode === "edge" ? { kind: "edge", id: 4 } : null,
    );

    let canvas: HTMLCanvasElement | undefined;
    const r = await ReactThreeTestRenderer.create(<Picking part={part} />, {
      beforeReturn: (c) => {
        canvas = c;
      },
    });

    click(canvas!, 10, 10);
    // Strict face mode: an edge under the cursor is NOT selected.
    expect(useCadStore.getState().picks).toEqual([]);

    await r.unmount();
  });

  it("null selMode keeps the permissive vertex→edge→face cascade (R5)", async () => {
    const part = buildPart(quad());
    part.vertexPoints = null;
    useCadStore.getState().setSelMode(null);

    vi.spyOn(Picker.prototype, "pick").mockImplementation((_part, _ndc, _camera, mode) =>
      mode === "edge" ? { kind: "edge", id: 4 } : null,
    );

    let canvas: HTMLCanvasElement | undefined;
    const r = await ReactThreeTestRenderer.create(<Picking part={part} />, {
      beforeReturn: (c) => {
        canvas = c;
      },
    });

    click(canvas!, 10, 10);
    expect(useCadStore.getState().picks).toEqual([{ kind: "edge", id: 4 }]);

    await r.unmount();
  });

  it("edge mode only accepts edge hits (R5)", async () => {
    const part = buildPart(quad());
    useCadStore.getState().setSelMode("edge");

    // A face-only raycast must not land under edge mode.
    vi.spyOn(Picker.prototype, "pick").mockImplementation((_part, _ndc, _camera, mode) =>
      mode === "face" ? { kind: "face", id: 7 } : mode === "edge" ? { kind: "edge", id: 4 } : null,
    );

    let canvas: HTMLCanvasElement | undefined;
    const r = await ReactThreeTestRenderer.create(<Picking part={part} />, {
      beforeReturn: (c) => {
        canvas = c;
      },
    });

    click(canvas!, 10, 10);
    expect(useCadStore.getState().picks).toEqual([{ kind: "edge", id: 4 }]);

    await r.unmount();
  });
});

describe("Picking — complete boundary face promotion", () => {
  it("promotes a B-rep face only when all adjacent edges and corner points are selected", () => {
    const part = buildPart(multiEdgeQuad());
    const allEdges = [1, 2, 3, 4].map((id) => ({ kind: "edge" as const, id }));
    const allVertices = [11, 12, 13, 14].map((id) => ({ kind: "vertex" as const, id }));

    expect(completeBrepFacePicks(part, [...allEdges, ...allVertices.slice(0, 3)])).toEqual([]);
    expect(completeBrepFacePicks(part, [...allEdges.slice(0, 3), ...allVertices])).toEqual([]);
    expect(completeBrepFacePicks(part, [...allEdges, ...allVertices])).toEqual([{ kind: "face", id: 7 }]);
  });
});

describe("Picking — hover candidate caching (perf)", () => {
  beforeEach(() => useCadStore.getState().reset());
  afterEach(() => {
    vi.restoreAllMocks();
    useCadStore.getState().reset();
  });

  it("computes each edge's bounding sphere at most once across many hover moves", async () => {
    const part = buildPart(multiEdgeQuad());
    const edgeCount = part.edges.length;
    expect(edgeCount).toBe(4);
    useCadStore.getState().setSelMode("edge");

    // A null raycast hit routes every pointer-move through the screen-nearest
    // fallback → selectionCandidates, which is the cached path under test.
    vi.spyOn(Picker.prototype, "pick").mockReturnValue(null);
    // Spy that still calls through, so each geometry's boundingSphere is really set
    // (the cache guard keys off it). We only assert how OFTEN it's recomputed.
    const sphereSpy = vi.spyOn(THREE.BufferGeometry.prototype, "computeBoundingSphere");

    let canvas: HTMLCanvasElement | undefined;
    const r = await ReactThreeTestRenderer.create(<Picking part={part} />, {
      beforeReturn: (c) => {
        canvas = c;
      },
    });
    expect(canvas).toBeDefined();

    // Count only what the hover moves trigger, not any mount-time work.
    sphereSpy.mockClear();

    const MOVES = 6;
    for (let i = 0; i < MOVES; i++) {
      canvas!.dispatchEvent(
        new MouseEvent("pointermove", { clientX: 10 + i, clientY: 20 + i, bubbles: true }),
      );
    }

    // Cached: at most one bounding-sphere compute per edge for the whole hover
    // session. The pre-fix code recomputed every edge on every move (edgeCount *
    // MOVES = 24), so this would have been 24 without the per-part candidate cache.
    expect(sphereSpy.mock.calls.length).toBeLessThanOrEqual(edgeCount);
    expect(sphereSpy.mock.calls.length).toBeLessThan(edgeCount * MOVES);

    await r.unmount();
  });
});
