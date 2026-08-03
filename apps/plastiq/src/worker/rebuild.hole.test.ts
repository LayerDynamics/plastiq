// §13.2 — the `hole` FEATURE (kernel op wired through the rebuild evaluator).
// The kernel op is proven analytically in packages/cad's hole.test.ts; here we
// prove the FEATURE dispatches correctly: data.origin/axis/kind + params →
// HoleSpec → hole() → the box loses exactly the drilled volume.

import { beforeAll, describe, expect, it } from "vitest";
import { initOcct, mm, type Occt } from "@plastiq/cad";
import type { CadDocument } from "../store/types.js";
import { rebuildDocument } from "./rebuild.js";

let oc: Occt;
beforeAll(async () => {
  oc = await initOcct();
}, 120_000);

const BOX = 40; // mm cube
const boxVol = mm(BOX) ** 3;
const boreVol = (d: number, len: number): number => Math.PI * (mm(d) / 2) ** 2 * mm(len);

/** A box with a hole drilled straight down through the top-face centre. */
function holeDoc(extra: Record<string, unknown>, params: Record<string, number>): CadDocument {
  return {
    features: [
      { id: "f1", type: "box", params: { dx: mm(BOX), dy: mm(BOX), dz: mm(BOX) } },
      {
        id: "f2",
        type: "hole",
        params,
        data: { origin: [mm(BOX / 2), mm(BOX / 2), mm(BOX)], axis: [0, 0, -1], ...extra },
      },
    ],
    params: {},
  };
}

describe("§13.2 hole feature — dispatches through rebuild to the kernel op", () => {
  it("a simple THROUGH hole removes π·r²·thickness", () => {
    const s = rebuildDocument(oc, holeDoc({ kind: "simple", throughAll: true }, { diameter: mm(8) }))!;
    expect(s.volume()).toBeCloseTo(boxVol - boreVol(8, BOX), 7);
    s.delete();
  });

  it("a simple BLIND hole removes π·r²·depth", () => {
    const s = rebuildDocument(oc, holeDoc({ kind: "simple" }, { diameter: mm(8), depth: mm(20) }))!;
    expect(s.volume()).toBeCloseTo(boxVol - boreVol(8, 20), 7);
    s.delete();
  });

  it("a counterbore removes more than the bare bore (mouth widened)", () => {
    const simple = rebuildDocument(oc, holeDoc({ kind: "simple", throughAll: true }, { diameter: mm(8) }))!;
    const cbore = rebuildDocument(
      oc,
      holeDoc(
        { kind: "counterbore", throughAll: true },
        { diameter: mm(8), counterboreDiameter: mm(14), counterboreDepth: mm(6) },
      ),
    )!;
    expect(cbore.volume()).toBeLessThan(simple.volume());
    simple.delete();
    cbore.delete();
  });

  it("through-all needs no depth; a blind hole without depth fails loudly", () => {
    expect(() => rebuildDocument(oc, holeDoc({ kind: "simple" }, { diameter: mm(8) }))).toThrow();
  });
});
