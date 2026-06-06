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
