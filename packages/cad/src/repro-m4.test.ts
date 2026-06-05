// M4 reproducibility (SPEC-4 Task 4.6 / NFR-2): the M4 outputs — the 3D mate
// solver result and the lowered four-bar mechanism manifest (bodies + hinge
// constraints) — serialize byte-identically across two runs. The mate solver is
// pure deterministic TS; the mechanism export also exercises OCCT (the link
// spheres) + joint lowering, extending the M0–M3 reproducibility gate to M4.

import { beforeAll, describe, expect, it } from "vitest";
import { makeJoint } from "./assembly/joint.js";
import { solveMates, type ComponentPose } from "./assembly/solver.js";
import { Component } from "./hierarchy/component.js";
import { makeBody } from "./hierarchy/body.js";
import { canonicalize } from "./lower/canonical.js";
import { exportForSim } from "./lower/export.js";
import { lowerJoints } from "./lower/joints.js";
import { defaultLibrary } from "./material/library.js";
import { initOcct, type Occt } from "./oc/init.js";
import { makeSphere } from "./solid/primitives.js";

const INIT_TIMEOUT_MS = 120_000;

function mateArtifact(): string {
  const fixed: ComponentPose = { position: [0, 0, 0], orientation: [0, 0, 0, 1], fixed: true };
  const free: ComponentPose = { position: [0.3, 0.1, 0], orientation: [0, 0, 0, 1] };
  const r = solveMates(
    [fixed, free],
    [
      {
        kind: "concentric",
        a: { component: 1, point: [0, 0, 0], dir: [0, 0, 1] },
        b: { component: 0, point: [0, 0, 0], dir: [0, 0, 1] },
      },
    ],
  );
  return canonicalize({ poses: r.poses, verdict: r.verdict, freedom: r.freedom });
}

function fourBarArtifact(oc: Occt): string {
  const mech = new Component("four-bar");
  const spheres = [
    { n: "ground", p: [0, 10, -1] as [number, number, number] },
    { n: "crank", p: [0, 10, 0] as [number, number, number] },
    { n: "coupler", p: [0, 11, 0] as [number, number, number] },
    { n: "rocker", p: [2.5, 10, 0] as [number, number, number] },
  ].map((l) => {
    const comp = new Component(l.n);
    comp.placement = { position: l.p, orientation: [0, 0, 0, 1] };
    const b = makeBody(l.n, "structural-steel");
    b.geometry = makeSphere(oc, 0.05, [0, 0, 0]);
    comp.addBody(b);
    mech.addChild(comp);
    return b.geometry;
  });
  try {
    const constraints = lowerJoints([
      {
        joint: makeJoint("revolute", 0, 1, { origin: [0, 10, 0], axis: [0, 0, 1] }),
        bodyA: "ground",
        bodyB: "crank",
      },
      {
        joint: makeJoint("revolute", 1, 2, { origin: [0, 11, 0], axis: [0, 0, 1] }),
        bodyA: "crank",
        bodyB: "coupler",
      },
      {
        joint: makeJoint("revolute", 2, 3, { origin: [2.5, 10, 0], axis: [0, 0, 1] }),
        bodyA: "coupler",
        bodyB: "rocker",
      },
      {
        joint: makeJoint("revolute", 3, 0, { origin: [2.5, 10, 0], axis: [0, 0, 1] }),
        bodyA: "rocker",
        bodyB: "ground",
      },
    ]);
    return canonicalize(
      exportForSim(oc, mech, defaultLibrary(), "repro:four-bar", { constraints }),
    );
  } finally {
    for (const s of spheres) s.delete();
  }
}

describe("M4 assembly + mechanism reproducibility (NFR-2)", () => {
  let oc: Occt;
  beforeAll(async () => {
    oc = await initOcct();
  }, INIT_TIMEOUT_MS);

  it("the mate-solver result is byte-identical across two runs", () => {
    expect(mateArtifact()).toBe(mateArtifact());
  });

  it("the lowered four-bar manifest is byte-identical across two runs", () => {
    expect(fourBarArtifact(oc)).toBe(fourBarArtifact(oc));
  });
});
