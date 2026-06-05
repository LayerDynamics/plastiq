import { beforeAll, describe, expect, it } from "vitest";
import { initOcct, type Occt } from "../oc/init.js";
import { Solid } from "./solid.js";

const INIT_TIMEOUT_MS = 120_000;

/** Build a raw OCCT box solid (makeBox wrapper arrives in Task 0.6). */
function rawBox(oc: Occt, dx: number, dy: number, dz: number): Solid {
  const mk = new oc.BRepPrimAPI_MakeBox_2(dx, dy, dz);
  const solid = mk.Solid(); // ref-counted handle survives the builder's deletion
  mk.delete();
  return new Solid(oc, solid);
}

describe("Solid", () => {
  let oc: Occt;
  beforeAll(async () => {
    oc = await initOcct();
  }, INIT_TIMEOUT_MS);

  it("reports a box as valid", () => {
    const s = rawBox(oc, 10, 20, 30);
    try {
      expect(s.isValid()).toBe(true);
    } finally {
      s.delete();
    }
  });

  it("counts a box's unique topology: 6 faces, 12 edges, 8 vertices", () => {
    const s = rawBox(oc, 10, 20, 30);
    try {
      expect(s.countFaces()).toBe(6);
      expect(s.countEdges()).toBe(12);
      expect(s.countVertices()).toBe(8);
    } finally {
      s.delete();
    }
  });
});
