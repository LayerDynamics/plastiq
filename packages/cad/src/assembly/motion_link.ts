// Motion links (SPEC-4 FR-29). A `MotionLink` couples two joint coordinates by a
// constant ratio — a gear/belt/rack relation. The driven joint's coordinate is
// the driver's times the ratio (a negative ratio reverses sense, e.g. meshing
// external gears; the magnitude is the gear ratio N_driver/N_driven).

export interface MotionLink {
  /** Index of the driving joint. */
  readonly driver: number;
  /** Index of the driven joint. */
  readonly driven: number;
  /** Driven = driver × ratio (sign included). */
  readonly ratio: number;
}

export function makeMotionLink(driver: number, driven: number, ratio: number): MotionLink {
  if (ratio === 0 || !Number.isFinite(ratio)) {
    throw new Error(`motion-link ratio must be finite and non-zero, got ${ratio}`);
  }
  return { driver, driven, ratio };
}

/** The driven joint coordinate for a given driver coordinate. */
export function drivenCoordinate(link: MotionLink, driverCoordinate: number): number {
  return driverCoordinate * link.ratio;
}

/** The driver coordinate that produces a given driven coordinate (inverse). */
export function driverCoordinate(link: MotionLink, drivenValue: number): number {
  return drivenValue / link.ratio;
}
