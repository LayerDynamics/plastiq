// mesh/resolve — SMOKE: all three resolvers run on a box and return sane results.

import { beforeAll, describe, expect, it } from "vitest";

import { initOcct, type Occt } from "../oc/init.js";
import { makeBox } from "../solid/primitives.js";
import { mm } from "../unit/index.js";
import { resolveEdgeDirection, resolveEdgeRef, resolveFaceRef } from "./resolve.js";

let oc: Occt;
beforeAll(async () => {
  oc = await initOcct();
}, 120_000);

describe("resolve — smoke", () => {
  it("resolveFaceRef / resolveEdgeRef / resolveEdgeDirection run on a box", () => {
    const box = makeBox(oc, mm(60), mm(40), mm(30));

    const face = resolveFaceRef(oc, box, { normal: [0, 0, 1] });
    expect(face).not.toBeNull();
    face!.delete();

    const edge = resolveEdgeRef(oc, box, { faceNormals: [[0, 0, 1], [1, 0, 0]] });
    expect(edge).not.toBeNull();
    edge!.delete();

    const dir = resolveEdgeDirection(oc, box, { faceNormals: [[0, 0, 1], [1, 0, 0]] });
    expect(dir.every(Number.isFinite)).toBe(true);

    box.delete();
  });
});
