// mesh/normals — INTEGRATION: faceNormal over a whole solid. A box's six faces must
// have the six axis-aligned OUTWARD unit normals, which therefore sum to ~0 (each
// face cancels its opposite). Exercises ensureMeshed → explore → faceNormal together.

import { beforeAll, describe, expect, it } from "vitest";

import { initOcct, type Occt } from "../oc/init.js";
import { makeBox } from "../solid/primitives.js";
import { mm } from "../unit/index.js";
import type { Vec3 } from "../math/index.js";
import { ensureMeshed, faceNormal, shapeEnums } from "./normals.js";

let oc: Occt;
beforeAll(async () => {
  oc = await initOcct();
}, 120_000);

describe("normals — whole-solid face normals (integration)", () => {
  it("a box's six faces are the six axis-aligned outward unit normals (sum ≈ 0)", () => {
    const box = makeBox(oc, mm(20), mm(20), mm(20));
    ensureMeshed(oc, box.shape);
    const S = shapeEnums(oc);
    const exp = new oc.TopExp_Explorer_2(box.shape, S.TopAbs_FACE, S.TopAbs_SHAPE);
    const normals: Vec3[] = [];
    for (; exp.More(); exp.Next()) {
      const f = oc.TopoDS.Face_1(exp.Current());
      normals.push(faceNormal(oc, f));
      f.delete();
    }
    exp.delete();
    box.delete();

    expect(normals).toHaveLength(6);
    for (const n of normals) {
      expect(Math.hypot(n[0], n[1], n[2])).toBeCloseTo(1, 6); // unit
      const maxComponent = Math.max(Math.abs(n[0]), Math.abs(n[1]), Math.abs(n[2]));
      expect(maxComponent).toBeCloseTo(1, 6); // axis-aligned
    }
    const sum = normals.reduce<Vec3>((s, n) => [s[0] + n[0], s[1] + n[1], s[2] + n[2]], [0, 0, 0]);
    expect(Math.hypot(sum[0], sum[1], sum[2])).toBeCloseTo(0, 6); // opposite faces cancel
  });
});
