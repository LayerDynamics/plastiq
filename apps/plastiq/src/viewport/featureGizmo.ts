// Pure write-back for the interactive feature-edit gizmo (FR-11 extension). The
// gizmo's drag handle slides along the feature's axis; this maps the handle's
// position to the feature's primary numeric param (e.g. extrude height). Kept pure
// (plain numbers) so it unit-tests in Node, mirroring sectionTFromOffset — the 3D
// drag gesture itself is not E2E-tested (flaky in a headless canvas).

/**
 * The feature value for a handle dragged to `handleAxisCoord` along the gizmo's
 * unit axis, given the fixed `anchorAxisCoord` (both are world points projected
 * onto the axis, i.e. `point · axis`). The value is the signed extent from the
 * anchor to the handle, floored at `min` so the solid keeps a sliver of thickness
 * (and never inverts) when the handle is dragged back to or past the anchor.
 */
export function featureDragValue(
  anchorAxisCoord: number,
  handleAxisCoord: number,
  min: number,
): number {
  return Math.max(handleAxisCoord - anchorAxisCoord, min);
}
