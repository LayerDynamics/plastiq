import { describe, expect, it } from "vitest";
import * as THREE from "three";
import type { EdgeRef, VertexRef } from "@plastiq/cad";
import {
  edgeEndpoint,
  formatMeasurement,
  formatMm,
  measureEndpointPosition,
  measureEndpoints,
  measurePoints,
  measurePositions,
  nextMeasure,
  SECOND_POINT_PROMPT,
  vertexEndpoint,
  worldEndpoint,
} from "./measure.js";

describe("measure — point-to-point distance + readout (FR-13)", () => {
  it("computes distance and per-axis deltas in SI metres", () => {
    const m = measurePoints(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0.03, 0.04, 0));
    expect(m.distance).toBeCloseTo(0.05, 9); // 3-4-5
    expect(m.delta).toEqual([0.03, 0.04, 0]);
  });

  it("deltas are absolute regardless of point order", () => {
    const a = new THREE.Vector3(0.01, 0.02, 0.03);
    const b = new THREE.Vector3(0, 0, 0);
    expect(measurePoints(a, b).delta).toEqual([0.01, 0.02, 0.03]);
  });

  it("formats metres as millimetres", () => {
    expect(formatMm(0.05)).toBe("50.00 mm");
    expect(formatMm(0.0012345)).toBe("1.23 mm");
  });

  it("the readout shows total + axis breakdown in mm", () => {
    const m = measurePoints(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0.03, 0.04, 0));
    expect(formatMeasurement(m)).toBe("50.00 mm  (Δ 30.00 mm · 40.00 mm · 0.00 mm)");
  });
});

describe("nextMeasure — two-click measure state machine (FR-13)", () => {
  it("the first click banks the point and prompts for the second", () => {
    const a = worldEndpoint(new THREE.Vector3(0, 0, 0));
    const step = nextMeasure(null, a);
    expect(step.first).toBe(a); // retained for the next click
    expect(step.result).toBe(SECOND_POINT_PROMPT);
    expect(step.a).toBe(a);
    expect(step.b).toBeNull();
  });

  it("the second click resolves the measurement and resets", () => {
    const a = worldEndpoint(new THREE.Vector3(0, 0, 0));
    const b = worldEndpoint(new THREE.Vector3(0.03, 0.04, 0));
    const step = nextMeasure(a, b);
    expect(step.first).toBeNull(); // a fresh measurement starts on the next click
    expect(step.result).toBe("50.00 mm  (Δ 30.00 mm · 40.00 mm · 0.00 mm)");
    expect(step.a).toBe(a);
    expect(step.b).toBe(b);
  });
});

describe("R12 — VertexRef / EdgeRef measure endpoints (analytic signatures)", () => {
  it("captures VertexRefs from two box corners; distance = analytic box diagonal", () => {
    // A parametric box [0,dx]×[0,dy]×[0,dz] has opposite corners at the origin
    // and (dx,dy,dz). The resolve path for a VertexRef is its position signature
    // (B-rep corner point) — the same value tessellateTagged emits and
    // selectionRefs.vertices stores. Measure must use those signatures, not
    // bare pick indices.
    const dx = 0.06; // 60 mm
    const dy = 0.04; // 40 mm
    const dz = 0.03; // 30 mm
    const cornerA: VertexRef = { position: [0, 0, 0] };
    const cornerB: VertexRef = { position: [dx, dy, dz] };

    const a = vertexEndpoint(cornerA);
    const b = vertexEndpoint(cornerB);

    // Banked endpoints ARE the VertexRefs (persistent), not {kind:"vertex", id:N}.
    expect(a).toEqual({ kind: "vertex", ref: cornerA });
    expect(b).toEqual({ kind: "vertex", ref: cornerB });
    expect(measureEndpointPosition(a)).toEqual([0, 0, 0]);
    expect(measureEndpointPosition(b)).toEqual([dx, dy, dz]);

    const analytic = Math.hypot(dx, dy, dz); // √(0.06²+0.04²+0.03²) = 0.0781…
    const m = measureEndpoints(a, b);
    expect(m.distance).toBeCloseTo(analytic, 12);
    expect(m.delta).toEqual([dx, dy, dz]);

    // Full two-click machine stores both VertexRefs and the analytic readout.
    const first = nextMeasure(null, a);
    expect(first.first).toEqual(a);
    expect(first.a?.kind).toBe("vertex");
    const done = nextMeasure(first.first, b);
    expect(done.first).toBeNull();
    expect(done.a).toEqual(a);
    expect(done.b).toEqual(b);
    expect(done.a?.kind).toBe("vertex");
    expect(done.b?.kind).toBe("vertex");
    if (done.a?.kind === "vertex" && done.b?.kind === "vertex") {
      expect(done.a.ref.position).toEqual([0, 0, 0]);
      expect(done.b.ref.position).toEqual([dx, dy, dz]);
    }
    expect(done.result).toBe(formatMeasurement(m));
    // Sanity: 78.10 mm diagonal for a 60×40×30 mm box.
    expect(done.result.startsWith("78.10 mm")).toBe(true);
  });

  it("edge–edge measure stores EdgeRefs with analytic faceSurfaces + midpoint", () => {
    const e0: EdgeRef = {
      faceNormals: [
        [0, 0, 1],
        [1, 0, 0],
      ],
      midpoint: [0.03, 0, 0.015],
      faceSurfaces: [
        { kind: "plane", normal: [0, 0, 1], origin: [0, 0, 0.03] },
        { kind: "plane", normal: [1, 0, 0], origin: [0.06, 0, 0] },
      ],
    };
    const e1: EdgeRef = {
      faceNormals: [
        [0, 0, -1],
        [-1, 0, 0],
      ],
      midpoint: [0, 0.02, 0],
      faceSurfaces: [
        { kind: "plane", normal: [0, 0, -1], origin: [0, 0, 0] },
        { kind: "plane", normal: [-1, 0, 0], origin: [0, 0, 0] },
      ],
    };
    const a = edgeEndpoint(e0);
    const b = edgeEndpoint(e1);
    expect(a.kind).toBe("edge");
    expect(b.kind).toBe("edge");
    if (a.kind === "edge" && b.kind === "edge") {
      // Analytic signatures preserved end-to-end (not bare edge ids).
      expect(a.ref.faceSurfaces).toEqual(e0.faceSurfaces);
      expect(b.ref.faceSurfaces).toEqual(e1.faceSurfaces);
    }
    const m = measureEndpoints(a, b);
    // Midpoint-to-midpoint distance of the two edges.
    expect(m.distance).toBeCloseTo(
      measurePositions(e0.midpoint!, e1.midpoint!).distance,
      12,
    );
    const done = nextMeasure(a, b);
    expect(done.a?.kind).toBe("edge");
    expect(done.b?.kind).toBe("edge");
  });

  it("measurePositions is the pure SI core shared by world / vertex / edge paths", () => {
    const m = measurePositions([0, 0, 0], [0.03, 0.04, 0]);
    expect(m.distance).toBeCloseTo(0.05, 9);
  });
});
