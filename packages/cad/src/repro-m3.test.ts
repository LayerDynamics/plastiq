// M3 reproducibility (SPEC-4 Task 3.7 / NFR-2): the M3 outputs (loft, sweep, and
// the lowered SimManifest of a real exported part) must serialize byte-identically
// across two builds in the same engine — extending the M0/M1 reproducibility gate
// to the loft/sweep features and the full sim-export pipeline.

import { beforeAll, describe, expect, it } from "vitest";
import { extrude } from "./action/extrude.js";
import { fillet } from "./action/fillet.js";
import { loft } from "./action/loft.js";
import { sweep } from "./action/sweep.js";
import { offsetPlane, planeXY, planeYZ } from "./environment/plane.js";
import { makeBody } from "./hierarchy/body.js";
import { Component } from "./hierarchy/component.js";
import { canonicalize } from "./lower/canonical.js";
import { exportForSim } from "./lower/export.js";
import { massProperties } from "./lower/massprops.js";
import { tessellate } from "./mesh/tessellate.js";
import { defaultLibrary } from "./material/library.js";
import { initOcct, type Occt } from "./oc/init.js";
import { Sketch } from "./sketch/sketch.js";
import { mm } from "./unit/index.js";

const INIT_TIMEOUT_MS = 120_000;

function m3Artifact(oc: Occt): string {
  const lofted = loft(
    oc,
    [
      Sketch.rectangle(planeXY(), mm(40), mm(40)),
      Sketch.rectangle(offsetPlane(planeXY(), mm(40)), mm(20), mm(20)),
    ],
    { ruled: true },
  );
  const swept = sweep(oc, Sketch.rectangle(planeYZ(), mm(10), mm(10)), {
    kind: "polyline",
    points: [
      [0, 0, 0],
      [0.1, 0, 0],
    ],
  });

  // The full export pipeline: model → mass props + hull shape + material.
  const extruded = extrude(oc, Sketch.rectangle(planeXY(), mm(40), mm(30)), mm(20));
  const bracket = fillet(
    oc,
    extruded,
    [
      {
        faceNormals: [
          [0, 0, 1],
          [1, 0, 0],
        ],
      },
    ],
    mm(5),
  );
  const root = new Component("bracket");
  const body = makeBody("bracket", "aluminum-6061");
  body.geometry = bracket;
  root.addBody(body);

  try {
    return canonicalize({
      loftMass: massProperties(oc, lofted, 2700),
      loftMesh: tessellate(oc, lofted, { linearDeflection: mm(0.5) }),
      sweepMass: massProperties(oc, swept, 2700),
      partManifest: exportForSim(oc, root, defaultLibrary(), "repro:bracket"),
    });
  } finally {
    lofted.delete();
    swept.delete();
    extruded.delete();
    bracket.delete();
  }
}

describe("M3 feature + export reproducibility (NFR-2)", () => {
  let oc: Occt;
  beforeAll(async () => {
    oc = await initOcct();
  }, INIT_TIMEOUT_MS);

  it("loft + sweep + exported-part artifacts are byte-identical across two builds", () => {
    expect(m3Artifact(oc)).toBe(m3Artifact(oc));
  });
});
