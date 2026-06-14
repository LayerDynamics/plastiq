// Proof for the body-local constraint-frame transform: for a rotated body the
// local anchor/axis differ from the world value (the bug the backends had), and
// for an identity-oriented body they equal the plain world delta (so the fix
// leaves identity-oriented manifests — every existing test/E2E — unchanged).

import { describe, expect, it } from "vitest";
import { conjugate, localAnchor, localAxis, quatMul, type SimQuat } from "./frame.js";

const IDENT: SimQuat = [0, 0, 0, 1];
const S = Math.SQRT1_2; // sin/cos of 45° → a 90° rotation about Z is [0,0,S,S]
const ROT_Z90: SimQuat = [0, 0, S, S];

describe("frame — body-local constraint transform", () => {
  it("identity orientation: local == world delta (identity-oriented bodies unaffected)", () => {
    expect(localAxis([1, 2, 3], IDENT)).toEqual([1, 2, 3]);
    const a = localAnchor([1, 2, 3], [1, 0, 0], IDENT);
    expect(a[0]).toBeCloseTo(0, 12);
    expect(a[1]).toBeCloseTo(2, 12);
    expect(a[2]).toBeCloseTo(3, 12);
  });

  it("rotated body: axis is inverse-rotated into the local frame (≠ raw world axis)", () => {
    // The body is rotated +90° about Z (its local +X points along world +Y). A
    // world +X axis is therefore local −Y. The old code used the raw world axis
    // [1,0,0] here — wrong for this body.
    const local = localAxis([1, 0, 0], ROT_Z90);
    expect(local[0]).toBeCloseTo(0, 12);
    expect(local[1]).toBeCloseTo(-1, 12);
    expect(local[2]).toBeCloseTo(0, 12);
  });

  it("rotated body: anchor is offset then inverse-rotated", () => {
    // World pivot (1,0,0), body translated to (0,0,0) and rotated +90° about Z.
    const local = localAnchor([1, 0, 0], [0, 0, 0], ROT_Z90);
    expect(local[0]).toBeCloseTo(0, 12);
    expect(local[1]).toBeCloseTo(-1, 12);
    expect(local[2]).toBeCloseTo(0, 12);
  });

  it("conjugate negates the vector part, keeps w (unit-quat inverse)", () => {
    expect(conjugate([0.1, 0.2, 0.3, 0.4])).toEqual([-0.1, -0.2, -0.3, 0.4]);
    // Round trip: rotating into local then back by the conjugate is identity.
    const back = localAxis(localAxis([0.3, 0.7, -0.2], ROT_Z90), conjugate(ROT_Z90));
    expect(back[0]).toBeCloseTo(0.3, 12);
    expect(back[1]).toBeCloseTo(0.7, 12);
    expect(back[2]).toBeCloseTo(-0.2, 12);
  });
});

describe("frame — quatMul (quaternion composition)", () => {
  const near = (q: SimQuat, e: readonly number[]): void => {
    for (let i = 0; i < 4; i++) expect(q[i]).toBeCloseTo(e[i]!, 12);
  };

  it("identity is the left and right unit", () => {
    const q: SimQuat = [0.1, 0.2, 0.3, 0.4];
    near(quatMul(IDENT, q), q);
    near(quatMul(q, IDENT), q);
  });

  it("composes two 90°-Z rotations into a 180°-Z rotation", () => {
    near(quatMul(ROT_Z90, ROT_Z90), [0, 0, 1, 0]);
  });

  it("conjugate(q)·q == identity (the parent-relative child-orientation use)", () => {
    near(quatMul(conjugate(ROT_Z90), ROT_Z90), IDENT);
  });
});
