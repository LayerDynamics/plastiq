// Live camera orientation for the view cube (SPEC-5 FR-12).
//
// The cube is a DOM overlay, outside the r3f Canvas, so it cannot read the
// camera directly — it needs the orientation as React state to re-render. This
// is that channel: an r3f component inside the Canvas samples the camera each
// frame and publishes it here ONLY when it actually changed, so orbiting
// re-renders the cube while a still camera costs nothing.
//
// The published value is the camera's world quaternion. Everything the cube
// needs (which faces point at the viewer, where each vertex lands) follows from
// rotating the cube's own axes by its INVERSE — see `cubeBasis`.

import * as THREE from "three";
import { create } from "zustand";

/** Quaternion (x, y, z, w). */
export type Quat = readonly [number, number, number, number];

/**
 * The orientation to draw before the camera has reported one — the viewport's
 * OWN starting camera: position [0.12, 0.1, 0.16] looking at [0, 0, 0.02] with
 * Z up (three/Viewport3D.tsx). Kept in step with that literal so the cube's
 * first paint matches the scene behind it; a mismatch shows as a one-frame flick
 * to a different orientation on load.
 *
 * Not the identity, which points straight down Z and would render every other
 * face edge-on — a cube that looks broken.
 */
export const DEFAULT_VIEW_QUAT: Quat = (() => {
  const target = new THREE.Vector3(0, 0, 0.02);
  const m = new THREE.Matrix4().lookAt(
    new THREE.Vector3(0.12, 0.1, 0.16),
    target,
    new THREE.Vector3(0, 0, 1),
  );
  const q = new THREE.Quaternion().setFromRotationMatrix(m);
  return [q.x, q.y, q.z, q.w];
})();

/** A 4x4 column-major matrix, as three.js stores them. */
export type Mat4 = readonly number[];

/** Identity, before a camera has reported anything. */
const IDENTITY_M4: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

interface CameraOrientationState {
  /** The viewport camera's world quaternion. */
  quat: Quat;
  setQuat: (q: Quat) => void;
  /**
   * projection · viewMatrix — everything needed to take a WORLD point to
   * normalised device coordinates, plus the canvas size to land it in pixels.
   *
   * The sketch overlay needs the full transform, not just the orientation: its
   * glyphs sit on world points and must stay on them through orbit, pan, zoom
   * and the perspective divide. A scale-and-pan 2D view cannot express that —
   * the camera is perspective and generally not square-on to the sketch plane.
   */
  viewProjection: Mat4;
  /** Canvas size in CSS pixels (NDC → px). */
  canvas: { w: number; h: number };
  setProjection: (m: Mat4, w: number, h: number) => void;
}

export const useCameraOrientation = create<CameraOrientationState>((set) => ({
  quat: DEFAULT_VIEW_QUAT,
  setQuat: (q) => set({ quat: q }),
  viewProjection: IDENTITY_M4,
  canvas: { w: 1, h: 1 },
  setProjection: (viewProjection, w, h) => set({ viewProjection, canvas: { w, h } }),
}));

/** Whether a view-projection changed enough to re-render what depends on it. */
export function projectionChanged(a: Mat4, b: Mat4): boolean {
  for (let i = 0; i < 16; i++) {
    if (Math.abs((a[i] ?? 0) - (b[i] ?? 0)) > 1e-9) return true;
  }
  return false;
}

/**
 * A point on the sketch plane, in CSS pixels over the canvas.
 *
 * `frame` is the plane's world frame (origin + normal + xAxis); the in-plane v
 * axis is normal × xAxis, matching how the 3D scene lays the sketch out, so a
 * glyph drawn here lands exactly on the geometry it annotates. Returns null when
 * the point is behind the camera, where there is no honest screen position.
 */
export function projectPlanePoint(
  frame: { origin: Vec3; normal: Vec3; xAxis: Vec3 },
  viewProjection: Mat4,
  canvas: { w: number; h: number },
  uv: readonly [number, number],
): { x: number; y: number } | null {
  const [ox, oy, oz] = frame.origin;
  const [nx, ny, nz] = frame.normal;
  const [xx, xy, xz] = frame.xAxis;
  // In-plane Y = normal × xAxis.
  const yx = ny * xz - nz * xy;
  const yy = nz * xx - nx * xz;
  const yz = nx * xy - ny * xx;
  const wx = ox + xx * uv[0] + yx * uv[1];
  const wy = oy + xy * uv[0] + yy * uv[1];
  const wz = oz + xz * uv[0] + yz * uv[1];
  const m = viewProjection;
  // Column-major: clip = M · (wx, wy, wz, 1).
  const cx = (m[0] ?? 0) * wx + (m[4] ?? 0) * wy + (m[8] ?? 0) * wz + (m[12] ?? 0);
  const cy = (m[1] ?? 0) * wx + (m[5] ?? 0) * wy + (m[9] ?? 0) * wz + (m[13] ?? 0);
  const cw = (m[3] ?? 0) * wx + (m[7] ?? 0) * wy + (m[11] ?? 0) * wz + (m[15] ?? 0);
  if (!Number.isFinite(cw) || cw <= 1e-9) return null; // behind the camera
  return {
    x: ((cx / cw) * 0.5 + 0.5) * canvas.w,
    y: (0.5 - (cy / cw) * 0.5) * canvas.h,
  };
}

/**
 * Whether two orientations differ enough to be worth a re-render.
 *
 * |dot| is 1 for identical rotations (and for q vs −q, which represent the SAME
 * rotation — hence the abs). The threshold is about a twentieth of a degree:
 * fine enough that a slow orbit still animates smoothly, coarse enough that
 * floating-point jitter in a resting camera cannot spin the React tree.
 */
export function orientationChanged(a: Quat, b: Quat): boolean {
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  return Math.abs(dot) < 0.9999999;
}

/** A 3-vector in the cube's own (world/CAD, Z-up) frame. */
export type Vec3 = readonly [number, number, number];

/**
 * The cube's world axes expressed in CAMERA space: rotate each world axis by the
 * camera's inverse rotation.
 *
 * With this, a point `p` on the unit cube lands at `x·right + y·up + z·fwd`
 * where the returned rows are those camera-space axes. Screen x is the camera-x
 * component, screen y is the NEGATED camera-y component (SVG y grows downward),
 * and the camera-z component is depth — positive z is toward the viewer, which
 * is exactly the visibility test for a face normal.
 */
export function cubeBasis(q: Quat): { x: Vec3; y: Vec3; z: Vec3 } {
  const [qx, qy, qz, qw] = q;
  // Rotation matrix of the quaternion. Its COLUMNS are the camera's axes in
  // world space, so its ROWS are the world axes in camera space — i.e. the
  // inverse rotation applied to each world basis vector, without building a
  // second quaternion.
  const xx = qx * qx;
  const yy = qy * qy;
  const zz = qz * qz;
  const xy = qx * qy;
  const xz = qx * qz;
  const yz = qy * qz;
  const wx = qw * qx;
  const wy = qw * qy;
  const wz = qw * qz;
  return {
    x: [1 - 2 * (yy + zz), 2 * (xy - wz), 2 * (xz + wy)],
    y: [2 * (xy + wz), 1 - 2 * (xx + zz), 2 * (yz - wx)],
    z: [2 * (xz - wy), 2 * (yz + wx), 1 - 2 * (xx + yy)],
  };
}

/**
 * Project a point on the unit cube to the gizmo's 2D space, plus its depth.
 *
 * Orthographic on purpose: a view cube is a direction indicator, and perspective
 * on a 2 cm gizmo only skews it. `depth` > 0 means the point faces the viewer.
 */
export function projectCubePoint(
  basis: { x: Vec3; y: Vec3; z: Vec3 },
  p: Vec3,
  centre: number,
  scale: number,
): { x: number; y: number; depth: number } {
  const cx = basis.x[0] * p[0] + basis.y[0] * p[1] + basis.z[0] * p[2];
  const cy = basis.x[1] * p[0] + basis.y[1] * p[1] + basis.z[1] * p[2];
  const cz = basis.x[2] * p[0] + basis.y[2] * p[1] + basis.z[2] * p[2];
  return { x: centre + scale * cx, y: centre - scale * cy, depth: cz };
}
