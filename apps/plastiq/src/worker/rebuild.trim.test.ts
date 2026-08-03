// §14 trim feature — rebuild dispatches to trimSurface (keep-one-side plane cut).

import { beforeAll, describe, expect, it } from "vitest";
import { initOcct, mm, type Occt } from "@plastiq/cad";
import type { CadDocument } from "../store/types.js";
import { rebuildDocument } from "./rebuild.js";

let oc: Occt;
beforeAll(async () => {
  oc = await initOcct();
}, 120_000);

describe("§14 trim feature", () => {
  it("keeps half the volume of a box cut by a mid-plane", () => {
    const BOX = 40;
    const full = mm(BOX) ** 3;
    const doc: CadDocument = {
      features: [
        { id: "f1", type: "box", params: { dx: mm(BOX), dy: mm(BOX), dz: mm(BOX) } },
        {
          id: "f2",
          type: "trim",
          data: {
            plane: {
              origin: [mm(BOX / 2), 0, 0],
              normal: [1, 0, 0],
              xAxis: [0, 1, 0],
            },
            keep: "positive",
          },
        },
      ],
      params: {},
    };
    const s = rebuildDocument(oc, doc)!;
    try {
      expect(s.volume()).toBeCloseTo(full / 2, 7);
      expect(s.centreOfMass()[0]).toBeGreaterThan(mm(BOX / 2));
    } finally {
      s.delete();
    }
  });
});
