// Measure tool math (SPEC-5 FR-13 + R12). Pure geometry + formatting over picked
// endpoints, so it unit-tests without a renderer. Endpoints are either a bare
// world point (surface hit) or a persistent VertexRef / EdgeRef (analytic
// signatures — not transient pick indices), so a vertex–vertex or edge–edge
// measurement can re-bind after a parametric rebuild the same way dress-ups do.

import type { EdgeRef, VertexRef } from "@plastiq/cad";
import type * as THREE from "three";

export interface Measurement {
  /** Straight-line distance in SI metres. */
  distance: number;
  /** Per-axis deltas |Δx|,|Δy|,|Δz| in SI metres. */
  delta: readonly [number, number, number];
}

/**
 * A measure endpoint. Vertex/edge carry persistent refs (R12 / FR-16); world is
 * the free-form surface/fallback point when no entity ref is available.
 */
export type MeasureEndpoint =
  | { kind: "world"; position: readonly [number, number, number] }
  | { kind: "vertex"; ref: VertexRef }
  | { kind: "edge"; ref: EdgeRef };

/** SI position of a measure endpoint (vertex position / edge midpoint / world). */
export function measureEndpointPosition(
  ep: MeasureEndpoint,
): readonly [number, number, number] {
  if (ep.kind === "vertex") return ep.ref.position;
  if (ep.kind === "edge") {
    const m = ep.ref.midpoint;
    if (m) return m;
    // Midpoint-less legacy EdgeRef — no positional anchor; treat as origin so
    // callers still get a finite readout rather than throwing mid-click.
    return [0, 0, 0];
  }
  return ep.position;
}

/** Distance + axis deltas between two SI positions. */
export function measurePositions(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): Measurement {
  const dx = Math.abs(b[0] - a[0]);
  const dy = Math.abs(b[1] - a[1]);
  const dz = Math.abs(b[2] - a[2]);
  return {
    distance: Math.hypot(dx, dy, dz),
    delta: [dx, dy, dz],
  };
}

/** Distance + axis deltas between two measure endpoints (uses their signatures). */
export function measureEndpoints(a: MeasureEndpoint, b: MeasureEndpoint): Measurement {
  return measurePositions(measureEndpointPosition(a), measureEndpointPosition(b));
}

/** Distance + axis deltas between two world points (THREE.Vector3 conveniences). */
export function measurePoints(a: THREE.Vector3, b: THREE.Vector3): Measurement {
  return measurePositions([a.x, a.y, a.z], [b.x, b.y, b.z]);
}

/** Format a length in SI metres as a millimetre readout. */
export function formatMm(meters: number): string {
  return `${(meters * 1000).toFixed(2)} mm`;
}

/** A one-line readout: total distance + ΔX/ΔY/ΔZ in mm. */
export function formatMeasurement(m: Measurement): string {
  const [dx, dy, dz] = m.delta;
  return `${formatMm(m.distance)}  (Δ ${formatMm(dx)} · ${formatMm(dy)} · ${formatMm(dz)})`;
}

/** Prompt shown after the first point is banked, while awaiting the second click. */
export const SECOND_POINT_PROMPT = "Click second point";

/**
 * Advance the two-click measure interaction (FR-13). `first` is the endpoint
 * banked by the previous click (null to start a fresh measurement); `point` is
 * the endpoint just clicked. Returns the endpoint to retain for the next click
 * and the readout to display: the first click banks the endpoint and prompts for
 * the second; the second resolves the measurement and resets `first` so the
 * following click starts a new measurement.
 *
 * When both endpoints are vertex or both are edge, the banked values are the
 * persistent VertexRef / EdgeRef signatures — not bare transient pick indices.
 */
export function nextMeasure(
  first: MeasureEndpoint | null,
  point: MeasureEndpoint,
): { first: MeasureEndpoint | null; result: string; a: MeasureEndpoint | null; b: MeasureEndpoint | null } {
  if (!first) return { first: point, result: SECOND_POINT_PROMPT, a: point, b: null };
  return {
    first: null,
    result: formatMeasurement(measureEndpoints(first, point)),
    a: first,
    b: point,
  };
}

/** Build a world MeasureEndpoint from a THREE.Vector3 (surface / free-space hit). */
export function worldEndpoint(p: THREE.Vector3): MeasureEndpoint {
  return { kind: "world", position: [p.x, p.y, p.z] };
}

/** Build a vertex MeasureEndpoint from a captured VertexRef (R12). */
export function vertexEndpoint(ref: VertexRef): MeasureEndpoint {
  return { kind: "vertex", ref };
}

/** Build an edge MeasureEndpoint from a captured EdgeRef (analytic faceSurfaces). */
export function edgeEndpoint(ref: EdgeRef): MeasureEndpoint {
  return { kind: "edge", ref };
}
