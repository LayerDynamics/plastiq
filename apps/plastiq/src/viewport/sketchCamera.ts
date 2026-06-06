// The orthographic camera that makes the 3D viewport coincide with the 2D sketch
// overlay (M3 "normal to"). While sketching, the scene is rendered straight down
// the datum-plane normal with an ORTHO camera (no perspective foreshortening), so
// the plane's (u,v) project to screen exactly as the overlay's `view2D` affine maps
// them — the model behind the transparent overlay lines up with what you draw.
//
// view2D is the single source of truth (the overlay owns pan/zoom); this derives
// the camera from it. Pure (no three.js / DOM), so the coincidence is unit-tested.

import { planeYAxis, type DatumPlane } from "@plastiq/cad";
import type { View2D } from "../sketch/transform2d.js";

export interface SketchOrthoFrame {
  position: [number, number, number];
  target: [number, number, number];
  up: [number, number, number];
  left: number;
  right: number;
  top: number;
  bottom: number;
  near: number;
  far: number;
}

/** Metres the camera sits off the plane along its normal; near/far clip ±DEPTH
 * so the model on both sides of the sketch plane stays visible. */
const DEPTH = 1;

/**
 * Camera frame for sketching on `plane`, matching the overlay's `view2D` over a
 * `width`×`height` viewport: looks down the plane normal with right = plane xAxis
 * (u) and up = plane yAxis (v); the frustum is sized so 1 metre = `view.scale` px
 * and centred so the plane origin projects to (`view.panX`, `view.panY`).
 */
export function sketchOrthoFrame(
  plane: DatumPlane,
  view: View2D,
  width: number,
  height: number,
): SketchOrthoFrame {
  const x = plane.xAxis;
  const y = planeYAxis(plane);
  const n = plane.normal;
  const o = plane.origin;
  // The plane (u,v) under the screen centre = the frustum centre. Mirrors
  // transform2d.toWorld at (width/2, height/2): u=(cx−panX)/scale, v=(panY−cy)/scale.
  const centerU = (width / 2 - view.panX) / view.scale;
  const centerV = (view.panY - height / 2) / view.scale;
  const halfW = width / (2 * view.scale);
  const halfH = height / (2 * view.scale);
  const center: [number, number, number] = [
    o[0] + x[0] * centerU + y[0] * centerV,
    o[1] + x[1] * centerU + y[1] * centerV,
    o[2] + x[2] * centerU + y[2] * centerV,
  ];
  return {
    position: [center[0] + n[0] * DEPTH, center[1] + n[1] * DEPTH, center[2] + n[2] * DEPTH],
    target: center,
    up: [y[0], y[1], y[2]],
    left: -halfW,
    right: halfW,
    top: halfH,
    bottom: -halfH,
    near: 0.001,
    far: 2 * DEPTH,
  };
}
