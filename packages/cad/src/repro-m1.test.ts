// M1 reproducibility (SPEC-4 Task 1.7 / NFR-2): the M1 feature outputs
// (extrude, revolve, cut) must serialize byte-identically across two builds in
// the same engine — extending the M0 box reproducibility gate to features.

import { beforeAll, describe, expect, it } from "vitest";
import { extrude, cut } from "./action/index.js";
import { planeXY } from "./environment/plane.js";
import { canonicalize } from "./lower/canonical.js";
import { massProperties } from "./lower/massprops.js";
import { tessellate } from "./mesh/tessellate.js";
import { initOcct, type Occt } from "./oc/init.js";
import { makeBox } from "./solid/primitives.js";
import { Sketch } from "./sketch/sketch.js";
import { mm } from "./unit/index.js";

const INIT_TIMEOUT_MS = 120_000;

function m1Artifact(oc: Occt): string {
  const extruded = extrude(oc, Sketch.rectangle(planeXY(), mm(20), mm(30)), mm(10));
  const target = makeBox(oc, mm(20), mm(20), mm(20));
  const tool = makeBox(oc, mm(10), mm(10), mm(40));
  const cutResult = cut(oc, target, tool);
  try {
    return canonicalize({
      extrudedMass: massProperties(oc, extruded, 2700),
      extrudedMesh: tessellate(oc, extruded, { linearDeflection: mm(0.2) }),
      cutMass: massProperties(oc, cutResult, 2700),
      cutMesh: tessellate(oc, cutResult, { linearDeflection: mm(0.2) }),
    });
  } finally {
    extruded.delete();
    target.delete();
    tool.delete();
    cutResult.delete();
  }
}

describe("M1 feature reproducibility (NFR-2)", () => {
  let oc: Occt;
  beforeAll(async () => {
    oc = await initOcct();
  }, INIT_TIMEOUT_MS);

  it("extrude + cut artifacts are byte-identical across two builds", () => {
    expect(m1Artifact(oc)).toBe(m1Artifact(oc));
  });
});
