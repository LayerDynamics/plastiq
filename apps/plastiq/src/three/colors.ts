// The viewport palette — the single source of truth for the r3f viewport and its
// gizmos. These are the EXACT values the legacy SceneController/buildMesh used, so
// the rewrite is visually identical (same dark stage, same light-grey faces, same
// blue hover, same orange selection). buildMesh's FACE_MATERIAL/ENTITY_COLOR are
// re-exported here so face/edge/vertex highlighting keeps one source.

export { FACE_MATERIAL, ENTITY_COLOR } from "../viewport/buildMesh.js";

/** Viewport background (the dark stage). */
export const VIEWPORT_BG = 0x0b0d12;

/** Base solid-face colour (light grey). Matches buildMesh's face base material. */
export const FACE_BASE = 0xd6dbe6;

/** Ground grid colours: centre lines, then the fine cells. */
export const GRID_CENTER = 0x33405a;
export const GRID_CELL = 0x1b2230;

/** Selection orange — the highlight colour, reused by gizmos that signal a pick
 * or an active handle (same hue as ENTITY_COLOR.selected and the UI accents). */
export const SELECT_ORANGE = 0xffa23a;

/** Hover blue — the secondary accent (axes, in-progress handles). */
export const ACCENT_BLUE = 0x4ea1ff;
