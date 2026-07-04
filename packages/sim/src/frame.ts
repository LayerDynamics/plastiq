// Body-LOCAL constraint frame helpers (SPEC-5 M4.5). A SimManifest carries a
// joint's pivot `origin` and `axis` in WORLD space, but every physics engine
// (Rapier, Bullet/ammo, cannon-es) expects a constraint's anchor and axis in each
// body's LOCAL frame. The local value is `q⁻¹ · (world − bodyTranslation)` for a
// point and `q⁻¹ · axis` for a direction. For a body whose orientation `q` is
// identity these reduce to the plain world delta / world axis (what a naive
// `origin − translation` does), so identity-oriented bodies are unaffected; a
// body with a non-identity orientation needs the inverse rotation or its hinge is
// anchored at the wrong local point and spins about the wrong local axis.

export type SimVec3 = [number, number, number];
/** Quaternion in (x, y, z, w) order. */
export type SimQuat = readonly [number, number, number, number];

/** Active rotation of `v` by quaternion `q` (q v q*). */
export function quatRotate(q: SimQuat, v: SimVec3): SimVec3 {
  const [x, y, z, w] = q;
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [
    v[0] + w * tx + (y * tz - z * ty),
    v[1] + w * ty + (z * tx - x * tz),
    v[2] + w * tz + (x * ty - y * tx),
  ];
}

/** Conjugate (= inverse, for a unit quaternion) of `q`. */
export function conjugate(q: SimQuat): SimQuat {
  return [-q[0], -q[1], -q[2], q[3]];
}

/** Hamilton product `a · b` of two (x, y, z, w) quaternions (compose rotations,
 * `a` applied after `b`). Used to express a child body's orientation relative to
 * its parent in a kinematic tree: `qChildLocal = conjugate(qParent) · qChild`. */
export function quatMul(a: SimQuat, b: SimQuat): SimQuat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

/** A world point expressed in a body's local frame: `q⁻¹ · (world − translation)`. */
export function localAnchor(world: SimVec3, translation: SimVec3, orientation: SimQuat): SimVec3 {
  return quatRotate(conjugate(orientation), [
    world[0] - translation[0],
    world[1] - translation[1],
    world[2] - translation[2],
  ]);
}

/** A world direction expressed in a body's local frame: `q⁻¹ · axis`. */
export function localAxis(axis: SimVec3, orientation: SimQuat): SimVec3 {
  return quatRotate(conjugate(orientation), axis);
}

/** `axis` scaled to unit length. Throws on a (near-)zero axis — a joint that
 * needs a direction cannot be built from one, and every backend would otherwise
 * fail deep inside its native layer with a far worse message. */
export function normalizeAxis(axis: SimVec3): SimVec3 {
  const len = Math.hypot(axis[0], axis[1], axis[2]);
  if (len < 1e-12) throw new Error("constraint axis must be a non-zero vector");
  return [axis[0] / len, axis[1] / len, axis[2] / len];
}

/**
 * The shortest-arc quaternion rotating world +X onto `axis` (normalized first).
 * Used to build a joint FRAME whose X column is the joint axis — Bullet's
 * btSliderConstraint / btGeneric6DofConstraint express their free/locked axes in
 * such a frame. Each body's local joint frame is then `conjugate(q_body) · axisFrame(axis)`
 * so both frames coincide in world space at spawn (zero initial violation).
 */
export function axisFrame(axis: SimVec3): SimQuat {
  const a = normalizeAxis(axis);
  const w = 1 + a[0]; // 1 + dot(+X, a)
  if (w < 1e-9) return [0, 0, 1, 0]; // a ≈ −X: any 180° turn ⊥ X; about Z maps X→−X
  // Unnormalized [cross(+X, a), 1 + dot(+X, a)], then normalized.
  const q: [number, number, number, number] = [0, -a[2], a[1], w];
  const n = Math.hypot(q[0], q[1], q[2], q[3]);
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

/** Two unit vectors that complete `axis` (normalized) to a right-handed
 * orthonormal basis (axis, u, v) — the Y/Z columns of {@link axisFrame}. Used by
 * the MuJoCo backend to emit a planar joint's two in-plane slide directions. */
export function axisBasis(axis: SimVec3): [SimVec3, SimVec3] {
  const f = axisFrame(axis);
  return [quatRotate(f, [0, 1, 0]), quatRotate(f, [0, 0, 1])];
}
