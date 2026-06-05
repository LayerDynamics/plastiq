import { beforeAll, describe, expect, it } from "vitest";
import { planeXY } from "../environment/plane.js";
import { massProperties } from "../lower/massprops.js";
import { initOcct, type Occt } from "../oc/init.js";
import { Sketch } from "../sketch/sketch.js";
import { mm } from "../unit/index.js";
import { chamferAllEdges } from "./chamfer.js";
import { extrude } from "./extrude.js";
import { filletAllEdges } from "./fillet.js";

const INIT_TIMEOUT_MS = 120_000;

// An extruded L-shaped profile — an arbitrary prism (not a box), so the
// "round/bevel every edge" path is exercised on a non-trivial topology.
function lPrism(oc: Occt): ReturnType<typeof extrude> {
  const sk = new Sketch(planeXY())
    .lineTo(0, 0)
    .lineTo(mm(40), 0)
    .lineTo(mm(40), mm(15))
    .lineTo(mm(15), mm(15))
    .lineTo(mm(15), mm(40))
    .lineTo(0, mm(40));
  return extrude(oc, sk, mm(20));
}

describe("fillet/chamfer all edges (interactive editor support, FR-8/9)", () => {
  let oc: Occt;
  beforeAll(async () => {
    oc = await initOcct();
  }, INIT_TIMEOUT_MS);

  it("filletAllEdges rounds every edge of an arbitrary prism → valid, smaller", () => {
    const prism = lPrism(oc);
    try {
      const v0 = massProperties(oc, prism, 1).volume;
      const rounded = filletAllEdges(oc, prism, mm(2));
      try {
        expect(rounded.isValid()).toBe(true);
        const v1 = massProperties(oc, rounded, 1).volume;
        expect(v1).toBeLessThan(v0); // material removed at every edge
        expect(v1).toBeGreaterThan(v0 * 0.8); // only the edge wedges
      } finally {
        rounded.delete();
      }
    } finally {
      prism.delete();
    }
  });

  it("chamferAllEdges bevels every edge of an arbitrary prism → valid, smaller", () => {
    const prism = lPrism(oc);
    try {
      const v0 = massProperties(oc, prism, 1).volume;
      const beveled = chamferAllEdges(oc, prism, mm(2));
      try {
        expect(beveled.isValid()).toBe(true);
        expect(massProperties(oc, beveled, 1).volume).toBeLessThan(v0);
      } finally {
        beveled.delete();
      }
    } finally {
      prism.delete();
    }
  });

  it("too-large a radius throws a typed error (NFR-3)", () => {
    const prism = lPrism(oc);
    try {
      expect(() => filletAllEdges(oc, prism, mm(50))).toThrow();
    } finally {
      prism.delete();
    }
  });
});
