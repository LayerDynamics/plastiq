// Measure tool math (SPEC-5 FR-13). Pure geometry + formatting over picked world
// points, so it unit-tests without a renderer. The viewport collects two points
// (a click raycasts the part for the nearest surface/edge/vertex point) and
// shows the distance; the component axis breakdown helps as a quick caliper.

import type * as THREE from "three";

export interface Measurement {
  /** Straight-line distance in SI metres. */
  distance: number;
  /** Per-axis deltas |Δx|,|Δy|,|Δz| in SI metres. */
  delta: readonly [number, number, number];
}

/** Distance + axis deltas between two world points. */
export function measurePoints(a: THREE.Vector3, b: THREE.Vector3): Measurement {
  return {
    distance: a.distanceTo(b),
    delta: [Math.abs(b.x - a.x), Math.abs(b.y - a.y), Math.abs(b.z - a.z)],
  };
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
 * Advance the two-click measure interaction (FR-13). `first` is the world point
 * banked by the previous click (null to start a fresh measurement); `point` is
 * the world point just clicked. Returns the point to retain for the next click
 * and the readout to display: the first click banks the point and prompts for the
 * second; the second resolves the measurement and resets `first` so the following
 * click starts a new measurement.
 */
export function nextMeasure(
  first: THREE.Vector3 | null,
  point: THREE.Vector3,
): { first: THREE.Vector3 | null; result: string } {
  if (!first) return { first: point, result: SECOND_POINT_PROMPT };
  return { first: null, result: formatMeasurement(measurePoints(first, point)) };
}
