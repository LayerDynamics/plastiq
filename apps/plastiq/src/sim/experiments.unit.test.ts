import { describe, expect, it } from "vitest";
import type { SimManifest } from "@plastiq/sim";
import {
  applyExperiment,
  buildTelemetry,
  DEFAULT_SIM_EXPERIMENT,
  experimentWantsGround,
} from "./experiments.js";

function boxHull(h: number) {
  return {
    points: [
      -h, -h, -h, h, -h, -h, h, h, -h, -h, h, -h, -h, -h, h, h, -h, h, h, h, h, -h, h, h,
    ],
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

function singleBody(z = 0.05): SimManifest {
  return {
    version: 1,
    source: "test:part",
    gravity: [0, 0, -9.81],
    bodies: [
      {
        id: "body0",
        mass: 1,
        com: [0, 0, z],
        orientation: [0, 0, 0, 1],
        colliders: [boxHull(0.03)],
      },
    ],
    constraints: [],
  };
}

describe("experimentWantsGround", () => {
  it("forces ground for drop-test and rest; never for free-fall/zero-g", () => {
    expect(experimentWantsGround({ kind: "drop-test", ground: false })).toBe(true);
    expect(experimentWantsGround({ kind: "rest", ground: false })).toBe(true);
    expect(experimentWantsGround({ kind: "free-fall", ground: true })).toBe(false);
    expect(experimentWantsGround({ kind: "zero-g", ground: true })).toBe(false);
  });
});

describe("applyExperiment", () => {
  it("drop-test lifts dynamic bodies and injects a ground plane", () => {
    const m = applyExperiment(singleBody(0.05), {
      ...DEFAULT_SIM_EXPERIMENT,
      kind: "drop-test",
      dropHeight: 0.2,
      ground: true,
    });
    const part = m.bodies.find((b) => b.id === "body0")!;
    expect(part.com[2]).toBeCloseTo(0.25, 9);
    expect(m.bodies.some((b) => b.id === "__experiment_ground" && b.fixed)).toBe(true);
    expect(m.gravity[2]).toBeCloseTo(-9.81, 6);
    expect(m.source).toContain("exp:drop-test");
  });

  it("zero-g clears gravity and never injects ground", () => {
    const m = applyExperiment(singleBody(), {
      ...DEFAULT_SIM_EXPERIMENT,
      kind: "zero-g",
      gravityScale: 1,
      dropHeight: 0,
      ground: true, // ignored for zero-g
    });
    expect(m.gravity).toEqual([0, 0, 0]);
    expect(m.bodies.every((b) => b.id !== "__experiment_ground")).toBe(true);
  });

  it("free-fall lifts but never injects ground", () => {
    const m = applyExperiment(singleBody(0.1), {
      ...DEFAULT_SIM_EXPERIMENT,
      kind: "free-fall",
      gravityScale: 1,
      dropHeight: 0.3,
      ground: true, // ignored for free-fall
    });
    expect(m.bodies.find((b) => b.id === "body0")!.com[2]).toBeCloseTo(0.4, 9);
    expect(m.bodies.every((b) => b.id !== "__experiment_ground")).toBe(true);
  });

  it("gravityScale multiplies Earth gravity", () => {
    const m = applyExperiment(singleBody(), {
      ...DEFAULT_SIM_EXPERIMENT,
      kind: "free-fall",
      gravityScale: 0.16,
      dropHeight: 0,
      ground: false,
    });
    expect(m.gravity[2]).toBeCloseTo(-9.81 * 0.16, 6);
  });

  it("does not lift fixed bodies", () => {
    const src = singleBody(0.1);
    src.bodies[0]!.fixed = true;
    const m = applyExperiment(src, {
      ...DEFAULT_SIM_EXPERIMENT,
      kind: "drop-test",
      gravityScale: 1,
      dropHeight: 1,
      ground: true,
    });
    expect(m.bodies.find((b) => b.id === "body0")!.com[2]).toBeCloseTo(0.1, 9);
  });

  it("rest applies a smaller clearance lift and injects ground", () => {
    const m = applyExperiment(singleBody(0.1), {
      ...DEFAULT_SIM_EXPERIMENT,
      kind: "rest",
      dropHeight: 0.2,
    });
    expect(m.bodies.find((b) => b.id === "body0")!.com[2]).toBeCloseTo(0.1 + 0.05, 9);
    expect(m.bodies.some((b) => b.id === "__experiment_ground")).toBe(true);
  });
});

describe("buildTelemetry", () => {
  it("reports max speed, min dynamic Z, and settled flag", () => {
    const t = buildTelemetry(1.5, "drop-test", [
      { id: "a", position: [0, 0, 0.2], speed: 1.2, fixed: false },
      { id: "g", position: [0, 0, -0.1], speed: 0, fixed: true },
      { id: "b", position: [0, 0, 0.05], speed: 3.4, fixed: false },
    ]);
    expect(t.time).toBe(1.5);
    expect(t.maxSpeed).toBeCloseTo(3.4, 9);
    expect(t.minDynamicZ).toBeCloseTo(0.05, 9);
    expect(t.bodies).toHaveLength(3);
    expect(t.settled).toBe(false);
  });

  it("marks settled when dynamic bodies are nearly still after start", () => {
    const t = buildTelemetry(0.5, "drop-test", [
      { id: "a", position: [0, 0, 0.02], speed: 0.005, fixed: false },
      { id: "g", position: [0, 0, -0.02], speed: 0, fixed: true },
    ]);
    expect(t.settled).toBe(true);
  });

  it("does not mark settled at t≈0 even if speeds are low", () => {
    const t = buildTelemetry(0.01, "drop-test", [
      { id: "a", position: [0, 0, 0.2], speed: 0, fixed: false },
    ]);
    expect(t.settled).toBe(false);
  });
});
