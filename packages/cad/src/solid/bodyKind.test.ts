// bodyKindOf — UNIT against real OCCT wasm (§11 / §17 body-kind discriminator).

import { beforeAll, describe, expect, it } from "vitest";

import { surfaceLoft } from "../action/surface.js";
import { offsetPlane, planeXY } from "../env/plane.js";
import { initOcct, type Occt } from "../oc/init.js";
import { shapeEnums } from "../mesh/normals.js";
import { Sketch } from "../sketch/sketch.js";
import { Solid } from "./solid.js";
import { makeBox } from "./primitives.js";
import { mm } from "../unit/index.js";
import { bodyKindOf, shapeMayHaveFreeEdges } from "./bodyKind.js";
import type { TopoDS_Face } from "opencascade.js";

let oc: Occt;
beforeAll(async () => {
  oc = await initOcct();
}, 120_000);

function square(half: number, z: number): Sketch {
  const sk = new Sketch(offsetPlane(planeXY(), z));
  sk.lineTo(-half, -half).lineTo(half, -half).lineTo(half, half).lineTo(-half, half);
  return sk;
}

describe("bodyKindOf", () => {
  it("classifies a box as solid", () => {
    const box = makeBox(oc, mm(20), mm(10), mm(5));
    try {
      expect(bodyKindOf(oc, box)).toBe("solid");
      expect(shapeMayHaveFreeEdges(oc, box)).toBe(false);
    } finally {
      box.delete();
    }
  });

  it("classifies a surface loft as shell", () => {
    const shell = surfaceLoft(oc, [square(mm(20), 0), square(mm(10), mm(50))], {
      ruled: true,
    });
    try {
      expect(bodyKindOf(oc, shell)).toBe("shell");
      expect(shapeMayHaveFreeEdges(oc, shell)).toBe(true);
    } finally {
      shell.delete();
    }
  });

  it("classifies a lone face as face", () => {
    const box = makeBox(oc, mm(20), mm(10), mm(5));
    const S = shapeEnums(oc);
    const exp = new oc.TopExp_Explorer_2(box.shape, S.TopAbs_FACE, S.TopAbs_SHAPE);
    const faceShape = oc.TopoDS.Face_1(exp.Current()) as TopoDS_Face;
    exp.delete();
    const face = new Solid(oc, faceShape);
    try {
      expect(bodyKindOf(oc, face)).toBe("face");
      expect(shapeMayHaveFreeEdges(oc, face)).toBe(true);
    } finally {
      face.delete();
      box.delete();
    }
  });
});
