// Sketch ↔ screen 2D affine (SPEC-5 M3.1). The sketch editor works in the plane's
// (u,v) coordinates (SI metres); the SVG overlay works in pixels. The mapping is
// a pan + uniform zoom with the V axis flipped (screen Y grows downward). Pure
// math, unit-tested — the editor never hand-rolls the transform.

export interface View2D {
  /** Pixels per metre. */
  scale: number;
  /** Screen pixel position of the plane origin (u=0,v=0). */
  panX: number;
  panY: number;
}

export interface Vec2 {
  u: number;
  v: number;
}
export interface Px {
  x: number;
  y: number;
}

/** Plane (u,v) metres → screen pixels. */
export function toScreen(view: View2D, p: Vec2): Px {
  return { x: p.u * view.scale + view.panX, y: -p.v * view.scale + view.panY };
}

/** Screen pixels → plane (u,v) metres. */
export function toWorld(view: View2D, px: Px): Vec2 {
  return { u: (px.x - view.panX) / view.scale, v: -(px.y - view.panY) / view.scale };
}

/**
 * Zoom by `factor` about a screen anchor, keeping the world point under the
 * anchor fixed (the natural wheel-zoom-at-cursor behaviour).
 */
export function zoomAt(view: View2D, anchor: Px, factor: number): View2D {
  const before = toWorld(view, anchor);
  const scale = clampScale(view.scale * factor);
  // Re-derive pan so `before` still maps to `anchor` at the new scale.
  return { scale, panX: anchor.x - before.u * scale, panY: anchor.y + before.v * scale };
}

/** Pan the view by a screen delta. */
export function panBy(view: View2D, dx: number, dy: number): View2D {
  return { ...view, panX: view.panX + dx, panY: view.panY + dy };
}

const MIN_SCALE = 50; // 50 px/m  → ~5 px per cm (zoomed way out)
const MAX_SCALE = 500_000; // 500000 px/m → fine sub-millimetre work

function clampScale(s: number): number {
  return Math.max(MIN_SCALE, Math.min(MAX_SCALE, s));
}

/** A view that centres the origin in a `w`×`h` viewport at a given scale. */
export function centeredView(w: number, h: number, scale = 4000): View2D {
  return { scale, panX: w / 2, panY: h / 2 };
}

/** A "nice" grid step (metres) so a cell is ~50 px at the current zoom. */
export function gridStep(scale: number): number {
  const target = 50 / scale; // metres for ~50 px
  const pow = Math.pow(10, Math.floor(Math.log10(target)));
  for (const m of [1, 2, 5, 10]) if (pow * m >= target) return pow * m;
  return pow * 10;
}
