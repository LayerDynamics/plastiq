// isSimManifest type guard — UNIT tests: accepts a well-formed manifest and rejects
// each way it can be malformed.

import { describe, expect, it } from "vitest";

import { isSimManifest } from "./manifest.js";

const validBody = (): Record<string, unknown> => ({
  id: "b0",
  mass: 1,
  com: [0, 0, 0],
  orientation: [0, 0, 0, 1],
  colliders: [
    {
      points: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1],
      faces: [
        [0, 1, 2],
        [0, 1, 3],
        [0, 2, 3],
        [1, 2, 3],
      ],
    },
  ],
});
const valid = (): Record<string, unknown> => ({
  version: 1,
  source: "test",
  gravity: [0, 0, -9.81],
  bodies: [validBody()],
  constraints: [],
});
const bad = (overrides: Record<string, unknown>): unknown => ({ ...valid(), ...overrides });

describe("isSimManifest (unit)", () => {
  it("accepts a well-formed manifest", () => expect(isSimManifest(valid())).toBe(true));

  it("rejects non-objects", () => {
    expect(isSimManifest(null)).toBe(false);
    expect(isSimManifest(42)).toBe(false);
    expect(isSimManifest("manifest")).toBe(false);
  });

  it("rejects a wrong version / non-string source / malformed gravity", () => {
    expect(isSimManifest(bad({ version: 2 }))).toBe(false);
    expect(isSimManifest(bad({ source: 5 }))).toBe(false);
    expect(isSimManifest(bad({ gravity: [0, 0] }))).toBe(false);
  });

  it("rejects missing bodies / constraints arrays", () => {
    expect(isSimManifest(bad({ bodies: "x" }))).toBe(false);
    expect(isSimManifest(bad({ constraints: 0 }))).toBe(false);
  });

  it("rejects a body with a bad id/mass or no colliders", () => {
    expect(isSimManifest(bad({ bodies: [{ ...validBody(), id: 1 }] }))).toBe(false);
    expect(isSimManifest(bad({ bodies: [{ ...validBody(), id: "" }] }))).toBe(false);
    expect(isSimManifest(bad({ bodies: [{ ...validBody(), mass: "1" }] }))).toBe(false);
    expect(isSimManifest(bad({ bodies: [{ ...validBody(), colliders: [] }] }))).toBe(false);
  });

  it("rejects non-finite or wrong-arity gravity / com / orientation", () => {
    expect(isSimManifest(bad({ gravity: [0, 0, NaN] }))).toBe(false);
    expect(isSimManifest(bad({ gravity: [0, 0, Infinity] }))).toBe(false);
    expect(isSimManifest(bad({ gravity: [0, 0, 0, 0] }))).toBe(false);
    expect(isSimManifest(bad({ gravity: [0, 0, "x"] }))).toBe(false);
    expect(isSimManifest(bad({ bodies: [{ ...validBody(), com: [0, 0, NaN] }] }))).toBe(false);
    expect(isSimManifest(bad({ bodies: [{ ...validBody(), com: [0, 0] }] }))).toBe(false);
    expect(isSimManifest(bad({ bodies: [{ ...validBody(), orientation: [0, 0, 0, NaN] }] }))).toBe(
      false,
    );
    expect(isSimManifest(bad({ bodies: [{ ...validBody(), orientation: [0, 0, 0] }] }))).toBe(
      false,
    );
  });

  it("rejects a non-finite or negative mass", () => {
    expect(isSimManifest(bad({ bodies: [{ ...validBody(), mass: NaN }] }))).toBe(false);
    expect(isSimManifest(bad({ bodies: [{ ...validBody(), mass: Infinity }] }))).toBe(false);
    expect(isSimManifest(bad({ bodies: [{ ...validBody(), mass: -1 }] }))).toBe(false);
  });

  const withCollider = (collider: Record<string, unknown>): unknown =>
    bad({ bodies: [{ ...validBody(), colliders: [collider] }] });

  it("rejects collider points that are too few or not a multiple of 3", () => {
    // 3 vertices (9 numbers) passes %3 but is below the 12-number / 4-vertex minimum.
    expect(
      isSimManifest(withCollider({ points: [0, 0, 0, 1, 0, 0, 0, 1, 0], faces: [[0, 1, 2]] })),
    ).toBe(false);
    // 13 numbers is not a whole number of vertices.
    expect(
      isSimManifest(
        withCollider({ points: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0], faces: [[0, 1, 2]] }),
      ),
    ).toBe(false);
  });

  it("rejects a collider with too few faces", () => {
    expect(
      isSimManifest(
        withCollider({ points: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1], faces: [[0, 1, 2]] }),
      ),
    ).toBe(false);
  });

  it("rejects non-triangular faces and out-of-range / non-integer face indices", () => {
    const pts = [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1];
    expect(
      isSimManifest(
        withCollider({
          points: pts,
          faces: [
            [0, 1],
            [0, 2, 3],
            [1, 2, 3],
            [0, 1, 3],
          ],
        }),
      ),
    ).toBe(false);
    expect(
      isSimManifest(
        withCollider({
          points: pts,
          faces: [
            [0, 1, 9],
            [0, 2, 3],
            [1, 2, 3],
            [0, 1, 3],
          ],
        }),
      ),
    ).toBe(false);
    expect(
      isSimManifest(
        withCollider({
          points: pts,
          faces: [
            [0, 1, 1.5],
            [0, 2, 3],
            [1, 2, 3],
            [0, 1, 3],
          ],
        }),
      ),
    ).toBe(false);
    expect(
      isSimManifest(
        withCollider({
          points: pts,
          faces: [
            [0, 1, -1],
            [0, 2, 3],
            [1, 2, 3],
            [0, 1, 3],
          ],
        }),
      ),
    ).toBe(false);
  });

  it("rejects malformed constraints", () => {
    const twoBodies = [validBody(), { ...validBody(), id: "b1" }];
    const con = { kind: "hinge", bodyA: "b0", bodyB: "b1", origin: [0, 0, 0], axis: [0, 0, 1] };
    const withCon = (c: Record<string, unknown>): unknown =>
      bad({ bodies: twoBodies, constraints: [c] });
    expect(isSimManifest(withCon({ ...con, kind: "weld" }))).toBe(false);
    expect(isSimManifest(withCon({ ...con, bodyA: 1 }))).toBe(false);
    expect(isSimManifest(withCon({ ...con, origin: [0, 0] }))).toBe(false);
    expect(isSimManifest(withCon({ ...con, axis: [0, 0, NaN] }))).toBe(false);
    // A well-formed constraint is accepted.
    expect(isSimManifest(withCon(con))).toBe(true);
  });

  it("accepts every constraint kind in the vocabulary", () => {
    const twoBodies = [validBody(), { ...validBody(), id: "b1" }];
    for (const kind of ["hinge", "slider", "cylindrical", "ball", "planar", "fixed"]) {
      const con = { kind, bodyA: "b0", bodyB: "b1", origin: [0, 0, 0], axis: [0, 0, 1] };
      expect(isSimManifest(bad({ bodies: twoBodies, constraints: [con] }))).toBe(true);
    }
  });

  it("rejects a constraint whose body ref names no declared body", () => {
    const con = { kind: "hinge", bodyA: "b0", bodyB: "ghost", origin: [0, 0, 0], axis: [0, 0, 1] };
    expect(isSimManifest(bad({ constraints: [con] }))).toBe(false);
    const con2 = { ...con, bodyA: "ghost", bodyB: "b0" };
    expect(isSimManifest(bad({ constraints: [con2] }))).toBe(false);
  });

  it("rejects duplicate body ids", () => {
    expect(isSimManifest(bad({ bodies: [validBody(), validBody()] }))).toBe(false);
  });
});
