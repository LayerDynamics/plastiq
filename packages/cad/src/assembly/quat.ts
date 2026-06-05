// Quaternion + pose math for the assembly mate solver. Quaternions are [x,y,z,w].

export type Vec3 = readonly [number, number, number];
export type Quat = readonly [number, number, number, number];

export const IDENTITY_QUAT: Quat = [0, 0, 0, 1];

/** Hamilton product a∘b (apply b, then a). */
export function quatMul(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

/** Rotate vector v by quaternion q. */
export function quatRotate(q: Quat, v: Vec3): Vec3 {
  const [qx, qy, qz, qw] = q;
  const [vx, vy, vz] = v;
  // t = 2·(q_xyz × v)
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  // v + qw·t + q_xyz × t
  return [
    vx + qw * tx + (qy * tz - qz * ty),
    vy + qw * ty + (qz * tx - qx * tz),
    vz + qw * tz + (qx * ty - qy * tx),
  ];
}

/** Unit quaternion from a rotation vector (axis·angle); zero → identity. */
export function quatFromRotVec(r: Vec3): Quat {
  const angle = Math.hypot(r[0], r[1], r[2]);
  if (angle < 1e-12) return IDENTITY_QUAT;
  const s = Math.sin(angle / 2) / angle;
  return [r[0] * s, r[1] * s, r[2] * s, Math.cos(angle / 2)];
}

export function quatNormalize(q: Quat): Quat {
  const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

export function vAdd(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}
export function vSub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
export function vDot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
export function vCross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
export function vLen(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}
export function vNorm(a: Vec3): Vec3 {
  const n = vLen(a) || 1;
  return [a[0] / n, a[1] / n, a[2] / n];
}
