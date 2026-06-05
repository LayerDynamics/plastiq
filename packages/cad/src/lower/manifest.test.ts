import { describe, expect, it } from "vitest";
import {
  isSimManifest,
  SIM_MANIFEST_VERSION,
  type BoundBodyData,
  type SimManifest,
} from "./manifest.js";

/** A minimal valid body (a unit-ish box of aluminium). */
function validBody(name = "box"): BoundBodyData {
  return {
    name,
    shape: { kind: "box", halfExtents: [0.005, 0.01, 0.015] },
    translation: [0, 0, 0],
    orientation: [0, 0, 0, 1],
    material: { name: "aluminum_6061", density: 2700, friction: 0.4, restitution: 0.2 },
    mass: {
      volume: 6e-6,
      mass: 0.0162,
      com: [0, 0, 0],
      inertia: [1e-7, 0, 0, 0, 1e-7, 0, 0, 0, 1e-7],
    },
  };
}

function validManifest(): SimManifest {
  return { version: SIM_MANIFEST_VERSION, source: "test", bodies: [validBody()], constraints: [] };
}

describe("isSimManifest", () => {
  it("accepts a well-formed manifest", () => {
    expect(isSimManifest(validManifest())).toBe(true);
  });

  it("accepts each shape variant", () => {
    const shapes = [
      { kind: "sphere", center: [0, 0, 0], radius: 0.01 },
      { kind: "capsule", a: [0, 0, 0], b: [0, 0.1, 0], radius: 0.01 },
      { kind: "box", halfExtents: [0.01, 0.01, 0.01] },
      {
        kind: "convexHull",
        vertices: [
          [0, 0, 0],
          [1, 0, 0],
          [0, 1, 0],
          [0, 0, 1],
        ],
        faces: [
          [0, 1, 2],
          [0, 1, 3],
          [0, 2, 3],
          [1, 2, 3],
        ],
      },
    ] as const;
    for (const shape of shapes) {
      const m = { ...validManifest(), bodies: [{ ...validBody(), shape }] };
      expect(isSimManifest(m), `${shape.kind} should be valid`).toBe(true);
    }
  });

  it("accepts the four lowered constraint kinds referencing existing bodies", () => {
    const m: SimManifest = {
      version: SIM_MANIFEST_VERSION,
      source: "test",
      bodies: [validBody("a"), validBody("b")],
      constraints: [
        { kind: "hinge", bodyA: "a", bodyB: "b", anchor: [0, 0, 0], axis: [0, 0, 1] },
        { kind: "fixed", bodyA: "a", bodyB: "b" },
        {
          kind: "distance",
          bodyA: "a",
          bodyB: "b",
          anchorA: [0, 0, 0],
          anchorB: [0, 0, 0],
          distance: 0.1,
        },
        {
          kind: "spring",
          bodyA: "a",
          bodyB: "b",
          anchorA: [0, 0, 0],
          anchorB: [0, 0, 0],
          rest: 0.1,
          stiffness: 100,
        },
      ],
    };
    expect(isSimManifest(m)).toBe(true);
  });

  it("rejects a wrong version", () => {
    expect(isSimManifest({ ...validManifest(), version: 2 })).toBe(false);
  });

  it("rejects a non-finite coordinate (NaN / Infinity)", () => {
    const nan = {
      ...validManifest(),
      bodies: [{ ...validBody(), translation: [0, Number.NaN, 0] }],
    };
    const inf = {
      ...validManifest(),
      bodies: [{ ...validBody(), translation: [0, 0, Number.POSITIVE_INFINITY] }],
    };
    expect(isSimManifest(nan)).toBe(false);
    expect(isSimManifest(inf)).toBe(false);
  });

  it("rejects an unknown shape kind", () => {
    const m = { ...validManifest(), bodies: [{ ...validBody(), shape: { kind: "torus", r: 1 } }] };
    expect(isSimManifest(m)).toBe(false);
  });

  it("rejects a constraint referencing a missing body", () => {
    const m = {
      ...validManifest(),
      constraints: [{ kind: "fixed", bodyA: "box", bodyB: "ghost" }],
    };
    expect(isSimManifest(m)).toBe(false);
  });

  it("rejects duplicate body names", () => {
    const m = { ...validManifest(), bodies: [validBody("dup"), validBody("dup")] };
    expect(isSimManifest(m)).toBe(false);
  });

  it("rejects invalid material ranges (restitution > 1, density <= 0)", () => {
    const badRest = {
      ...validManifest(),
      bodies: [
        { ...validBody(), material: { name: "x", density: 1, friction: 0, restitution: 1.5 } },
      ],
    };
    const badDensity = {
      ...validManifest(),
      bodies: [
        { ...validBody(), material: { name: "x", density: 0, friction: 0, restitution: 0.5 } },
      ],
    };
    expect(isSimManifest(badRest)).toBe(false);
    expect(isSimManifest(badDensity)).toBe(false);
  });

  it("rejects a convex hull with an out-of-range face index", () => {
    const m = {
      ...validManifest(),
      bodies: [
        {
          ...validBody(),
          shape: {
            kind: "convexHull",
            vertices: [
              [0, 0, 0],
              [1, 0, 0],
              [0, 1, 0],
              [0, 0, 1],
            ],
            faces: [[0, 1, 9]],
          },
        },
      ],
    };
    expect(isSimManifest(m)).toBe(false);
  });

  it("rejects non-objects", () => {
    expect(isSimManifest(null)).toBe(false);
    expect(isSimManifest(42)).toBe(false);
    expect(isSimManifest("nope")).toBe(false);
  });
});
