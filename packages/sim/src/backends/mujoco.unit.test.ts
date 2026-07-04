// MuJoCo backend — UNIT tests. Each method/branch in ISOLATION, asserting its exact
// contract rather than emergent physics:
//   • buildMjcf() — the constraint-graph → kinematic-tree mapping, asserted on the
//     emitted MJCF string (free/fixed/hinge/slider/cylindrical/ball/planar/rotated/
//     missing-body/loop branches, plus the float + scalar-first-quaternion
//     formatters). No wasm.
//   • engine method contracts — the error paths and bookkeeping (pose out-of-range,
//     restore body-count + foreign-snapshot guards, bodyCount, idempotent dispose).

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { MujocoBackend, buildMjcf } from "./mujoco.js";
import type { PhysicsSnapshot } from "../engine.js";
import type { SimManifest } from "../manifest.js";
import {
  S,
  ballManifest,
  boxHull,
  cylindricalManifest,
  freeBodyManifest,
  fixedJointManifest,
  hingeManifest,
  loopFixedManifest,
  loopHingeManifest,
  missingBodyManifest,
  planarManifest,
  restManifest,
  rotatedFreeManifest,
  sliderManifest,
} from "./fixtures.js";

afterEach(() => vi.restoreAllMocks());

describe("buildMjcf — manifest → MJCF mapping", () => {
  it("wraps the document with options carrying the timestep + gravity", () => {
    const xml = buildMjcf(freeBodyManifest(), 1 / 240);
    expect(xml).toMatch(/^<mujoco model="plastiq-sim">/);
    expect(xml).toContain(`<option timestep="${1 / 240}" gravity="0 0 -9.81"/>`);
    expect(xml.endsWith("</mujoco>")).toBe(true);
  });

  it("an unconstrained dynamic body becomes a <freejoint/> root with a mesh geom", () => {
    const xml = buildMjcf(freeBodyManifest(), 1 / 60);
    expect(xml).toContain('<body name="b0"');
    expect(xml).toContain("<freejoint/>");
    expect(xml).toContain('<mesh name="m0_0"');
    expect(xml).toContain('<geom type="mesh" mesh="m0_0"');
  });

  it("a fixed body becomes a NO-joint static root (no freejoint, no joint)", () => {
    // restManifest: ground (fixed) at b0, cube (free) at b1.
    const xml = buildMjcf(restManifest(), 1 / 60);
    const ground = xml.slice(xml.indexOf('<body name="b0"'), xml.indexOf('<body name="b1"'));
    expect(ground).not.toContain("<freejoint/>");
    expect(ground).not.toContain("<joint");
  });

  it("a hinge constraint becomes a child <joint type=\"hinge\"> nested in its parent", () => {
    // hingeManifest: anchor (fixed) b0 → arm (hinge child) b1.
    const xml = buildMjcf(hingeManifest(), 1 / 60);
    expect(xml).toContain('<joint type="hinge"');
    expect(xml).toContain('axis=');
    // b1 is nested INSIDE b0 (its closing tag comes before b0's).
    const b1Open = xml.indexOf('<body name="b1"');
    const b0Close = xml.indexOf("</body>", xml.indexOf('<body name="b0"'));
    expect(b1Open).toBeLessThan(b0Close);
  });

  it("a fixed constraint nests the child with NO joint (rigid weld into the parent)", () => {
    // fixedJointManifest: ground (fixed) b0 → block (fixed child) b1.
    const xml = buildMjcf(fixedJointManifest(), 1 / 60);
    const b1 = xml.slice(xml.indexOf('<body name="b1"'));
    expect(b1).not.toContain("<freejoint/>");
    expect(b1).not.toContain("<joint");
  });

  it("emits the body orientation as a SCALAR-FIRST (w x y z) quaternion", () => {
    // rotatedFreeManifest body orientation is (x,y,z,w) = [0,0,S,S]; MJCF wants w-first.
    const xml = buildMjcf(rotatedFreeManifest(), 1 / 60);
    expect(xml).toContain(`quat="${S} 0 0 ${S}"`);
  });

  it("THROWS for a constraint that references a missing body (defensive — validators reject upstream)", () => {
    expect(() => buildMjcf(missingBodyManifest(), 1 / 60)).toThrow(
      /mujoco: hinge constraint references missing body 'nonexistent'/,
    );
  });

  it("throws on a non-finite numeric value (the float formatter guards the MJCF)", () => {
    const bad = { ...freeBodyManifest(), gravity: [0, 0, Number.POSITIVE_INFINITY] as [number, number, number] };
    expect(() => buildMjcf(bad, 1 / 60)).toThrow(/non-finite/);
  });

  it("closes a FIXED loop with a <weld> equality", () => {
    const xml = buildMjcf(loopFixedManifest(), 1 / 60);
    expect(xml).toContain("<equality>");
    expect(xml).toContain("<weld body1=");
  });

  it("closes a loop-closing HINGE with TWO <connect> equalities on the axis (no warning, no drop)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const xml = buildMjcf(loopHingeManifest(), 1 / 60);
    expect(warn).not.toHaveBeenCalled();
    expect(xml).toContain("<equality>");
    // Two pinned points on the hinge axis = translation locked, axis rotation free.
    expect(xml.match(/<connect /g)).toHaveLength(2);
    expect(xml).not.toContain("<weld");
  });

  it("a slider constraint becomes a child <joint type=\"slide\"> with the axis (no hinge)", () => {
    const xml = buildMjcf(sliderManifest(), 1 / 60);
    expect(xml).toContain('<joint type="slide" axis="1 0 0"');
    expect(xml).not.toContain('type="hinge"');
  });

  it("a ball constraint becomes a child <joint type=\"ball\"> at the pivot", () => {
    const xml = buildMjcf(ballManifest(), 1 / 60);
    // Pivot [0,0,0] in the child's local frame: child COM is [0.2,0,0] → pos −0.2.
    expect(xml).toContain('<joint type="ball" pos="-0.2 0 0"/>');
  });

  it("a cylindrical constraint becomes a slide + hinge pair on the SAME axis", () => {
    const xml = buildMjcf(cylindricalManifest(), 1 / 60);
    expect(xml.match(/<joint type="slide" axis="1 0 0"/g)).toHaveLength(1);
    expect(xml.match(/<joint type="hinge" pos="[^"]*" axis="1 0 0"/g)).toHaveLength(1);
  });

  it("a planar constraint becomes two orthogonal in-plane slides + a hinge about the normal", () => {
    const xml = buildMjcf(planarManifest(), 1 / 60);
    expect(xml.match(/<joint type="slide"/g)).toHaveLength(2);
    // Normal +Z → the hinge (spin) axis is Z; the slides span the XY plane.
    expect(xml).toMatch(/<joint type="hinge" pos="[^"]*" axis="0 0 1"/);
  });

  it("approximates a loop-closing SLIDER with a <weld> and says so in a warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const xml = buildMjcf(loopKindManifest("slider"), 1 / 60);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain("slide DOF is lost");
    expect(xml).toContain("<weld");
  });

  it("THROWS for a loop-closing CYLINDRICAL or PLANAR (no MuJoCo equality expresses them)", () => {
    expect(() => buildMjcf(loopKindManifest("cylindrical"), 1 / 60)).toThrow(
      /cylindrical constraint .* closes a kinematic loop/,
    );
    expect(() => buildMjcf(loopKindManifest("planar"), 1 / 60)).toThrow(
      /planar constraint .* closes a kinematic loop/,
    );
  });
});

/** The loop-fixed triangle with its LOOP-CLOSING edge swapped to `kind`. BFS
 * from the fixed root `a` reaches both `b` and `c` directly (edges 0 and 2), so
 * the b–c edge (index 1) is the loop closer; the tree edges stay fixed so the
 * loop edge is the only `kind` constraint. */
function loopKindManifest(kind: "slider" | "cylindrical" | "planar"): SimManifest {
  const m = loopFixedManifest();
  const closing = m.constraints[1]!;
  m.constraints[1] = { ...closing, kind, axis: [1, 0, 0] };
  return m;
}

describe("MujocoEngine — method contracts", () => {
  beforeAll(async () => {
    await new MujocoBackend().init(); // load the wasm once (global, idempotent)
  });

  const freshEngine = () => new MujocoBackend().createEngine(1 / 60);

  it("backend.name is the literal \"mujoco\"", () => {
    expect(new MujocoBackend().name).toBe("mujoco");
  });

  it("bodyCount is 0 before spawn, the body count after, and 0 after dispose", () => {
    const e = freshEngine();
    expect(e.bodyCount).toBe(0);
    expect(e.spawn(freeBodyManifest())).toBe(1);
    expect(e.bodyCount).toBe(1);
    e.dispose();
    expect(e.bodyCount).toBe(0);
  });

  it("spawn() propagates the defensive missing-body throw (nothing is half-spawned silently)", () => {
    const e = freshEngine();
    expect(() => e.spawn(missingBodyManifest())).toThrow(/missing body 'nonexistent'/);
    e.dispose();
  });

  it("pose() throws for an out-of-range body index", () => {
    const e = freshEngine();
    e.spawn(freeBodyManifest()); // one body → index 0 only
    expect(() => e.pose(1)).toThrow(/no body at index 1/);
    expect(() => e.pose(-1)).toThrow();
    e.dispose();
  });

  it("restore() throws when the snapshot body count differs from the world", () => {
    const e = freshEngine();
    e.spawn(freeBodyManifest()); // 1 body
    const twoBody: PhysicsSnapshot = {
      bodies: [
        { position: [0, 0, 0], orientation: [0, 0, 0, 1], linearVelocity: [0, 0, 0], angularVelocity: [0, 0, 0] },
        { position: [0, 0, 0], orientation: [0, 0, 0, 1], linearVelocity: [0, 0, 0], angularVelocity: [0, 0, 0] },
      ],
    };
    expect(() => e.restore(twoBody)).toThrow(/snapshot has 2 bodies, world has 1/);
    e.dispose();
  });

  it("restore() of a FOREIGN snapshot (not from this engine) warns and leaves the world unchanged", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const e = freshEngine();
    e.spawn(freeBodyManifest());
    for (let i = 0; i < 20; i++) e.step();
    const before = e.pose(0).position;
    // Right body count, but a hand-built object the engine's WeakMap never saw.
    const foreign: PhysicsSnapshot = {
      bodies: [
        { position: [9, 9, 9], orientation: [0, 0, 0, 1], linearVelocity: [0, 0, 0], angularVelocity: [0, 0, 0] },
      ],
    };
    e.restore(foreign);
    const after = e.pose(0).position;
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain("restore()");
    expect(after).toEqual(before); // no-op, not corrupted to [9,9,9]
    e.dispose();
  });

  it("dispose() is idempotent (a second call does not throw)", () => {
    const e = freshEngine();
    e.spawn(boxHullManifest());
    e.dispose();
    expect(() => e.dispose()).not.toThrow();
  });
});

// A trivial single-body manifest used only by the idempotent-dispose test.
function boxHullManifest() {
  return {
    version: 1 as const,
    source: "test:box",
    gravity: [0, 0, -9.81] as [number, number, number],
    bodies: [{ id: "b0", mass: 1, com: [0, 0, 0] as [number, number, number], orientation: [0, 0, 0, 1] as [number, number, number, number], colliders: [boxHull(0.05)] }],
    constraints: [],
  };
}
