// mesh/tessellate — SMOKE: tessellateTagged turns a box into vertices + per-face
// groups. The tagging/signature detail is in tessellate.test.ts (unit + integration).

import { beforeAll, describe, expect, it } from "vitest";

import { initOcct, type Occt } from "../oc/init.js";
import { makeBox } from "../solid/primitives.js";
import { mm } from "../unit/index.js";
import { tessellateTagged } from "./tessellate.js";

let oc: Occt;
beforeAll(async () => {
  oc = await initOcct();
}, 120_000);

describe("tessellateTagged — smoke", () => {
  it("tessellates a box into a vertex buffer + six face groups", () => {
    const box = makeBox(oc, mm(60), mm(40), mm(30));
    const mesh = tessellateTagged(oc, box);
    expect(mesh.vertices.length).toBeGreaterThan(0);
    expect(mesh.vertices.length % 3).toBe(0);
    expect(mesh.faceGroups).toHaveLength(6); // a box has six planar faces
    for (const g of mesh.faceGroups) {
      expect(g.normal.every(Number.isFinite)).toBe(true);
    }
    box.delete();
  });
});
