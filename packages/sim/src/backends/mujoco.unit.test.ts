// MuJoCo backend — UNIT tests. Each method/branch in ISOLATION, asserting its exact
// contract rather than emergent physics:
//   • buildMjcf() — the constraint-graph → kinematic-tree mapping, asserted on the
//     emitted MJCF string (free/fixed/hinge/rotated/missing-body/loop branches, plus
//     the float + scalar-first-quaternion formatters). No wasm.
//   • engine method contracts — the error paths and bookkeeping (pose out-of-range,
//     restore body-count + foreign-snapshot guards, bodyCount, idempotent dispose).

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { MujocoBackend, buildMjcf } from "./mujoco.js";
import type { PhysicsSnapshot } from "../engine.js";
import {
  S,
  boxHull,
  freeBodyManifest,
  fixedJointManifest,
  hingeManifest,
  loopFixedManifest,
  loopHingeManifest,
  missingBodyManifest,
  restManifest,
  rotatedFreeManifest,
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

  it("warns and drops a constraint that references a missing body, still emitting both bodies", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const xml = buildMjcf(missingBodyManifest(), 1 / 60);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain("nonexistent");
    expect(xml).toContain('<body name="b0"');
    expect(xml).toContain('<body name="b1"');
    expect(xml).not.toContain("<joint"); // the only constraint was dropped
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

  it("drops a loop-closing HINGE with a warning (no equality — MuJoCo has none)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const xml = buildMjcf(loopHingeManifest(), 1 / 60);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain("closes a kinematic loop");
    expect(xml).not.toContain("<weld");
    expect(xml).not.toContain("<equality>");
  });
});

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

  it("spawn() returns the full body count even when a constraint is dropped", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const e = freshEngine();
    expect(e.spawn(missingBodyManifest())).toBe(2);
    expect(warn).toHaveBeenCalledTimes(1);
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
