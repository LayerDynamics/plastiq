// §14 surface feature types — rebuild evaluator wiring through real OCCT.
// Kernel sheet geometry is proven in packages/cad action/surface.test.ts;
// here we prove FEATURE dispatch: surfaceLoft / offsetSurface+thicken / etc.

import { beforeAll, describe, expect, it } from "vitest";
import {
  exportStep,
  initOcct,
  makeBox,
  mm,
  Solid,
  type Occt,
} from "@plastiq/cad";
import type { CadDocument } from "../store/types.js";
import { rebuildDocument } from "./rebuild.js";

let oc: Occt;
beforeAll(async () => {
  oc = await initOcct();
}, 120_000);

/** First face of a box, as a STEP payload of a single-face "sheet" body. */
function faceStep(dx: number, dy: number, dz: number): string {
  const box = makeBox(oc, dx, dy, dz);
  try {
    // embind types the enum object loosely — cast like rebuild.test.ts bodyCount.
    const S = oc.TopAbs_ShapeEnum as unknown as {
      TopAbs_FACE: import("opencascade.js").TopAbs_ShapeEnum;
      TopAbs_SHAPE: import("opencascade.js").TopAbs_ShapeEnum;
    };
    const exp = new oc.TopExp_Explorer_2(box.shape, S.TopAbs_FACE, S.TopAbs_SHAPE);
    const face = oc.TopoDS.Face_1(exp.Current());
    exp.delete();
    const sheet = new Solid(oc, face);
    try {
      return exportStep(oc, sheet);
    } finally {
      sheet.delete();
    }
  } finally {
    box.delete();
  }
}

/** Surface area of a body (SI m²). */
function surfaceArea(body: Solid): number {
  const props = new oc.GProp_GProps_1();
  try {
    oc.BRepGProp.SurfaceProperties_1(body.shape, props, false, false);
    return props.Mass();
  } finally {
    props.delete();
  }
}

function squareLoop(halfMm: number) {
  const h = halfMm;
  return {
    kind: "loop" as const,
    start: [-h, -h] as [number, number],
    segments: [
      { kind: "line" as const, to: [h, -h] as [number, number] },
      { kind: "line" as const, to: [h, h] as [number, number] },
      { kind: "line" as const, to: [-h, h] as [number, number] },
      { kind: "line" as const, to: [-h, -h] as [number, number] },
    ],
  };
}

describe("§14 surfaceLoft feature — dispatches through rebuild to the kernel op", () => {
  it("lofts two stacked rectangles into a shell that thickens to a solid plate", () => {
    // SI metres in the document (rebuild is SI). Two 40×40 mm squares, 50 mm apart.
    const doc: CadDocument = {
      features: [
        {
          id: "f1",
          type: "surfaceLoft",
          data: {
            ruled: true,
            sections: [
              { z: 0, profile: squareLoop(mm(20)) },
              { z: mm(50), profile: squareLoop(mm(10)) },
            ],
          },
        },
        {
          id: "f2",
          type: "thicken",
          params: { thickness: mm(2) },
          data: { bothSides: false },
        },
      ],
      params: {},
    };
    const plate = rebuildDocument(oc, doc)!;
    try {
      expect(plate).toBeTruthy();
      expect(plate.volume()).toBeGreaterThan(0);
      expect(plate.isValid()).toBe(true);
    } finally {
      plate.delete();
    }
  });

  it("surfaceLoft alone yields a positive-area sheet (rebuild holds shell bodies)", () => {
    const doc: CadDocument = {
      features: [
        {
          id: "f1",
          type: "surfaceLoft",
          data: {
            ruled: true,
            sections: [
              { z: 0, profile: squareLoop(mm(20)) },
              { z: mm(40), profile: squareLoop(mm(20)) },
            ],
          },
        },
      ],
      params: {},
    };
    const shell = rebuildDocument(oc, doc)!;
    try {
      expect(surfaceArea(shell)).toBeGreaterThan(mm(20) ** 2);
      expect(shell.isValid()).toBe(true);
    } finally {
      shell.delete();
    }
  });

  it("rejects fewer than two sections", () => {
    const doc: CadDocument = {
      features: [
        {
          id: "f1",
          type: "surfaceLoft",
          data: { sections: [{ z: 0, profile: squareLoop(mm(10)) }] },
        },
      ],
      params: {},
    };
    expect(() => rebuildDocument(oc, doc)).toThrow(/surfaceLoft.*≥2|needs ≥2/i);
  });
});

describe("§14 offsetSurface + thicken feature chain", () => {
  it("offsets an imported planar face then thickens into a plate", () => {
    const step = faceStep(mm(40), mm(30), mm(20));
    const t = mm(3);
    // Measure sheet area first (offset of a plane keeps area).
    const sheetOnly: CadDocument = {
      features: [{ id: "f1", type: "importStep", data: { step } }],
      params: {},
    };
    const sheet = rebuildDocument(oc, sheetOnly)!;
    let faceArea: number;
    try {
      faceArea = surfaceArea(sheet);
      expect(faceArea).toBeGreaterThan(0);
    } finally {
      sheet.delete();
    }

    const doc: CadDocument = {
      features: [
        { id: "f1", type: "importStep", data: { step } },
        { id: "f2", type: "offsetSurface", params: { distance: mm(5) } },
        {
          id: "f3",
          type: "thicken",
          params: { thickness: t },
          data: { bothSides: false },
        },
      ],
      params: {},
    };
    const plate = rebuildDocument(oc, doc)!;
    try {
      // Planar offset preserves area; thicken → volume ≈ area × thickness.
      expect(plate.volume()).toBeCloseTo(faceArea * t, 8);
      expect(plate.isValid()).toBe(true);
    } finally {
      plate.delete();
    }
  });

  it("zero offset distance fails loudly at rebuild", () => {
    const step = faceStep(mm(20), mm(20), mm(10));
    const doc: CadDocument = {
      features: [
        { id: "f1", type: "importStep", data: { step } },
        { id: "f2", type: "offsetSurface", params: { distance: 0 } },
      ],
      params: {},
    };
    expect(() => rebuildDocument(oc, doc)).toThrow(/offsetSurface|distance/i);
  });
});

describe("§14 surfaceSweep / surfaceRevolve features", () => {
  it("surfaceSweep builds an open cylindrical shell of expected lateral area", () => {
    const r = mm(10);
    const h = mm(100);
    const doc: CadDocument = {
      features: [
        {
          id: "f1",
          type: "surfaceSweep",
          data: {
            profile: { kind: "circle", center: [0, 0], radius: r },
            path: {
              kind: "polyline",
              points: [
                [0, 0, 0],
                [0, 0, h],
              ],
            },
          },
        },
      ],
      params: {},
    };
    const shell = rebuildDocument(oc, doc)!;
    try {
      // Lateral area of open cylinder ≈ 2π r h (no caps).
      expect(surfaceArea(shell)).toBeCloseTo(2 * Math.PI * r * h, 4);
      expect(shell.isValid()).toBe(true);
    } finally {
      shell.delete();
    }
  });

  it("surfaceRevolve builds a surface of revolution with positive area", () => {
    // Rectangle offset from Y axis so revolving about Y does not self-intersect.
    const doc: CadDocument = {
      features: [
        {
          id: "f1",
          type: "surfaceRevolve",
          params: { angle: Math.PI * 2, ox: 0, oy: 0, oz: 0, ax: 0, ay: 1, az: 0 },
          data: {
            profile: {
              kind: "loop",
              start: [mm(10), 0],
              segments: [
                { kind: "line", to: [mm(20), 0] },
                { kind: "line", to: [mm(20), mm(30)] },
                { kind: "line", to: [mm(10), mm(30)] },
                { kind: "line", to: [mm(10), 0] },
              ],
            },
            plane: { base: "XY", offset: 0 },
          },
        },
      ],
      params: {},
    };
    const shell = rebuildDocument(oc, doc)!;
    try {
      expect(surfaceArea(shell)).toBeGreaterThan(0);
      expect(shell.isValid()).toBe(true);
    } finally {
      shell.delete();
    }
  });
});

describe("§14 sew feature", () => {
  it("sews an imported multi-face body without throwing (holds shell result)", () => {
    // Full box STEP → sew its faces. Result is a shell (or compound-of-shell).
    const box = makeBox(oc, mm(40), mm(30), mm(20));
    let step: string;
    try {
      step = exportStep(oc, box);
    } finally {
      box.delete();
    }
    const doc: CadDocument = {
      features: [
        { id: "f1", type: "importStep", data: { step } },
        { id: "f2", type: "sew", params: { tolerance: 1e-6 } },
      ],
      params: {},
    };
    const shell = rebuildDocument(oc, doc)!;
    try {
      expect(shell.isValid()).toBe(true);
      expect(surfaceArea(shell)).toBeGreaterThan(0);
    } finally {
      shell.delete();
    }
  });
});
