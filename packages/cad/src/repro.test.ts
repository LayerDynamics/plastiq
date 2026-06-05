// Same-engine reproducibility gate (SPEC-4 NFR-2). Building the same model twice
// — in the same engine, and in a freshly re-initialized engine of the same build
// — must produce byte-identical canonical output. This is the CAD analogue of
// SPEC-3's same-binary reproducibility test.

import { beforeAll, describe, expect, it } from "vitest";
import { canonicalize } from "./lower/canonical.js";
import { massProperties } from "./lower/massprops.js";
import { tessellate } from "./mesh/tessellate.js";
import { initOcct, resetOcctForTesting, type Occt } from "./oc/init.js";
import { makeBox } from "./solid/primitives.js";
import { mm } from "./unit/index.js";

const INIT_TIMEOUT_MS = 120_000;

/** A representative model output: mass properties + tessellation of a box. */
function buildBoxArtifact(oc: Occt): string {
  const solid = makeBox(oc, mm(10), mm(20), mm(30));
  try {
    return canonicalize({
      mass: massProperties(oc, solid, 2700),
      mesh: tessellate(oc, solid, { linearDeflection: mm(0.1) }),
    });
  } finally {
    solid.delete();
  }
}

describe("same-engine reproducibility (NFR-2)", () => {
  let oc: Occt;
  beforeAll(async () => {
    oc = await initOcct();
  }, INIT_TIMEOUT_MS);

  it("two builds in the same engine are byte-identical", () => {
    expect(buildBoxArtifact(oc)).toBe(buildBoxArtifact(oc));
  });

  it("canonicalize sorts keys deterministically regardless of insertion order", () => {
    expect(canonicalize({ b: 1, a: { d: 4, c: 3 } })).toBe(
      canonicalize({ a: { c: 3, d: 4 }, b: 1 }),
    );
  });

  it(
    "a freshly re-initialized engine of the same build reproduces byte-identically",
    async () => {
      const first = buildBoxArtifact(oc);
      resetOcctForTesting();
      const fresh = await initOcct();
      expect(buildBoxArtifact(fresh)).toBe(first);
    },
    INIT_TIMEOUT_MS,
  );
});
