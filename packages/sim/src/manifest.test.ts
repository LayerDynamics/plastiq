// parseManifest structural validation + hullVolume.

import { describe, expect, it } from "vitest";

import { hullVolume, parseManifest, type HullCollider, type SimManifest } from "./manifest.js";

function boxHull(h: number): HullCollider {
  return {
    points: [-h, -h, -h, h, -h, -h, h, h, -h, -h, h, -h, -h, -h, h, h, -h, h, h, h, h, -h, h, h],
    faces: [
      [0, 3, 2],
      [0, 2, 1],
      [4, 5, 6],
      [4, 6, 7],
      [0, 1, 5],
      [0, 5, 4],
      [3, 7, 6],
      [3, 6, 2],
      [0, 4, 7],
      [0, 7, 3],
      [1, 2, 6],
      [1, 6, 5],
    ],
  };
}

function valid(): SimManifest {
  return {
    version: 1,
    source: "test",
    gravity: [0, 0, -9.81],
    bodies: [
      { id: "a", mass: 1, com: [0, 0, 0], orientation: [0, 0, 0, 1], colliders: [boxHull(0.05)] },
    ],
    constraints: [],
  };
}

const parse = (m: unknown): SimManifest => parseManifest(JSON.stringify(m));

describe("parseManifest", () => {
  it("accepts a well-formed manifest", () => {
    expect(() => parse(valid())).not.toThrow();
    expect(parse(valid()).bodies).toHaveLength(1);
  });

  it("rejects an unsupported version", () => {
    expect(() => parse({ ...valid(), version: 2 })).toThrow(/version/);
  });

  it("rejects a bad gravity vector", () => {
    expect(() => parse({ ...valid(), gravity: [0, 0] })).toThrow(/gravity/);
  });

  it("rejects a negative / non-finite mass", () => {
    const m = valid();
    m.bodies[0]!.mass = -1;
    expect(() => parse(m)).toThrow(/mass/);
  });

  it("rejects a malformed com / orientation", () => {
    const bad = valid();
    bad.bodies[0]!.com = [0, 0] as unknown as [number, number, number];
    expect(() => parse(bad)).toThrow(/com/);
    const bad2 = valid();
    bad2.bodies[0]!.orientation = [0, 0, 0] as unknown as [number, number, number, number];
    expect(() => parse(bad2)).toThrow(/orientation/);
  });

  it("rejects a body with no colliders or a degenerate collider", () => {
    const none = valid();
    none.bodies[0]!.colliders = [];
    expect(() => parse(none)).toThrow(/colliders/);
    const degenerate = valid();
    degenerate.bodies[0]!.colliders = [{ points: [0, 0, 0], faces: [[0, 0, 0]] }];
    expect(() => parse(degenerate)).toThrow(/points/);
  });

  it("rejects a collider face with an out-of-range or non-triangular vertex index", () => {
    // A valid box hull has 8 vertices; index 99 is out of range.
    const outOfRange = valid();
    const hull = boxHull(0.05);
    outOfRange.bodies[0]!.colliders = [{ points: hull.points, faces: [...hull.faces.slice(1), [0, 1, 99]] }];
    expect(() => parse(outOfRange)).toThrow(/out of range/);

    const notTriangle = valid();
    const hull2 = boxHull(0.05);
    notTriangle.bodies[0]!.colliders = [
      { points: hull2.points, faces: [...hull2.faces.slice(1), [0, 1] as unknown as number[]] },
    ];
    expect(() => parse(notTriangle)).toThrow(/non-triangular/);
  });

  it("rejects an unknown constraint kind", () => {
    const m = valid();
    m.constraints = [
      { kind: "weld", bodyA: "a", bodyB: "a", origin: [0, 0, 0], axis: [0, 0, 1] } as unknown as SimManifest["constraints"][number],
    ];
    expect(() => parse(m)).toThrow(/unknown kind/);
  });

  it("accepts every constraint kind in the vocabulary", () => {
    const m = valid();
    m.bodies.push({ id: "b", mass: 1, com: [0.1, 0, 0], orientation: [0, 0, 0, 1], colliders: [boxHull(0.05)] });
    m.constraints = (["hinge", "slider", "cylindrical", "ball", "planar", "fixed"] as const).map(
      (kind) => ({ kind, bodyA: "a", bodyB: "b", origin: [0, 0, 0], axis: [0, 0, 1] }),
    );
    expect(() => parse(m)).not.toThrow();
    expect(parse(m).constraints).toHaveLength(6);
  });

  it("rejects a constraint whose body ref names no declared body (no spawn-time drop)", () => {
    const m = valid();
    m.bodies.push({ id: "b", mass: 1, com: [0.1, 0, 0], orientation: [0, 0, 0, 1], colliders: [boxHull(0.05)] });
    m.constraints = [{ kind: "hinge", bodyA: "a", bodyB: "ghost", origin: [0, 0, 0], axis: [0, 1, 0] }];
    expect(() => parse(m)).toThrow(/references missing body 'ghost'/);
    const m2 = valid();
    m2.constraints = [{ kind: "fixed", bodyA: "ghost", bodyB: "a", origin: [0, 0, 0], axis: [0, 0, 1] }];
    expect(() => parse(m2)).toThrow(/references missing body 'ghost'/);
  });

  it("rejects duplicate body ids", () => {
    const m = valid();
    m.bodies.push({ id: "a", mass: 1, com: [0.1, 0, 0], orientation: [0, 0, 0, 1], colliders: [boxHull(0.05)] });
    expect(() => parse(m)).toThrow(/duplicate body id 'a'/);
  });
});

describe("hullVolume", () => {
  it("computes a cube's volume (winding-independent)", () => {
    // A 0.1 m cube → 0.001 m³.
    expect(hullVolume(boxHull(0.05))).toBeCloseTo(0.001, 9);
  });
});
