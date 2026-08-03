// Real-OCCT tests for §14 surface modeling kernel ops: surface loft/sweep/
// revolve produce SHELL (not SOLID) bodies with positive area; thicken closes
// them into solids; surfaceFromPoints / offsetSurface / patch exercise the
// remaining bindings. sew/solidify live in heal.ts — sew free-edge report is
// checked here; solidify is blocked in this wasm by unbound TopoDS_Shell (see
// note on the sew integration test).

import { beforeAll, describe, expect, it } from "vitest";

import { initOcct, type Occt } from "../oc/init.js";
import { mm } from "../unit/index.js";
import { offsetPlane, planeXY } from "../env/plane.js";
import { Sketch } from "../sketch/sketch.js";
import { makeBox } from "../solid/primitives.js";
import { shapeEnums } from "../mesh/normals.js";
import { Solid } from "../solid/solid.js";
import { thicken } from "./thicken.js";
import { loft } from "./loft.js";
import { sew } from "./heal.js";
import {
  offsetSurface,
  patch,
  surfaceArea,
  surfaceFromPoints,
  surfaceLoft,
  surfaceRevolve,
  surfaceSweep,
} from "./surface.js";
import type { TopoDS_Edge, TopoDS_Face } from "opencascade.js";

let oc: Occt;
beforeAll(async () => {
  oc = await initOcct();
}, 120_000);

function square(half: number, z: number): Sketch {
  const sk = new Sketch(offsetPlane(planeXY(), z));
  sk.lineTo(-half, -half).lineTo(half, -half).lineTo(half, half).lineTo(-half, half);
  return sk;
}

/** TopAbs shape-kind name for a Solid's underlying shape. */
function shapeKind(body: Solid): string {
  const S = shapeEnums(oc);
  const t = body.shape.ShapeType();
  for (const [k, v] of Object.entries(S)) {
    if (v === t) return k;
  }
  return String(t);
}

/** True when the body is a sheet (face or shell), not a closed solid. */
function isSheet(body: Solid): boolean {
  const kind = shapeKind(body);
  return kind === "TopAbs_SHELL" || kind === "TopAbs_FACE";
}

/** First face of a solid, owned by the caller as a Solid sheet body. */
function firstFaceSolid(box: Solid): { face: Solid; area: number } {
  const S = shapeEnums(oc);
  const exp = new oc.TopExp_Explorer_2(box.shape, S.TopAbs_FACE, S.TopAbs_SHAPE);
  const face = oc.TopoDS.Face_1(exp.Current()) as TopoDS_Face;
  exp.delete();
  const props = new oc.GProp_GProps_1();
  try {
    oc.BRepGProp.SurfaceProperties_1(face, props, false, false);
    return { face: new Solid(oc, face), area: props.Mass() };
  } finally {
    props.delete();
  }
}

describe("surfaceLoft", () => {
  it("lofts two stacked rectangles into a shell with positive area (not a solid)", () => {
    const sections = [square(mm(20), 0), square(mm(10), mm(50))];
    const shell = surfaceLoft(oc, sections, { ruled: true });
    const solid = loft(oc, sections, { ruled: true });
    try {
      // isSolid=false → SHELL; the solid loft of the same sections is SOLID.
      expect(shapeKind(shell)).toBe("TopAbs_SHELL");
      expect(isSheet(shell)).toBe(true);
      expect(shapeKind(solid)).toBe("TopAbs_SOLID");
      const area = surfaceArea(oc, shell);
      expect(area).toBeGreaterThan(0);
      // Lateral area only (no end caps) is still larger than one end square.
      expect(area).toBeGreaterThan(mm(20) ** 2);
      // Solid frustum volume is the analytic reference; the shell must not match it
      // as a solid body (different shape kind already proves that). VolumeProperties
      // on open shells is NOT reliable zero in OCCT, so we do not assert ~0 volume.
      expect(solid.volume()).toBeGreaterThan(0);
      expect(shell.isValid()).toBe(true);
    } finally {
      shell.delete();
      solid.delete();
    }
  });

  it("thickens a lofted shell into a solid plate of positive volume", () => {
    const shell = surfaceLoft(oc, [square(mm(20), 0), square(mm(20), mm(40))], { ruled: true });
    const plate = thicken(oc, shell, mm(2));
    try {
      expect(shapeKind(plate)).toBe("TopAbs_SOLID");
      expect(plate.volume()).toBeGreaterThan(0);
      expect(plate.isValid()).toBe(true);
    } finally {
      plate.delete();
      shell.delete();
    }
  });

  it("rejects fewer than two sections", () => {
    expect(() => surfaceLoft(oc, [square(mm(10), 0)], { ruled: true })).toThrow(
      /surfaceLoft: needs at least 2/,
    );
  });
});

describe("surfaceSweep", () => {
  it("sweeps a circle along a straight spine into a cylindrical shell (not solid)", () => {
    const profile = Sketch.circle(planeXY(), 0, 0, mm(10));
    const shell = surfaceSweep(oc, profile, {
      kind: "polyline",
      points: [
        [0, 0, 0],
        [0, 0, mm(100)],
      ],
    });
    try {
      expect(shapeKind(shell)).toBe("TopAbs_SHELL");
      // Lateral area of a cylinder ≈ 2π r h (no caps — open pipe shell).
      const area = surfaceArea(oc, shell);
      expect(area).toBeCloseTo(2 * Math.PI * mm(10) * mm(100), 4);
      expect(shell.isValid()).toBe(true);
    } finally {
      shell.delete();
    }
  });
});

describe("surfaceRevolve", () => {
  it("revolves a rectangular profile wire into a surface of revolution (shell)", () => {
    // Rectangle in the XZ plane of XY sketch space: u=x, v=y; put profile at y>0
    // so revolving about X does not self-intersect.
    const sk = new Sketch(planeXY());
    sk.lineTo(mm(10), mm(20)).lineTo(mm(30), mm(20)).lineTo(mm(30), mm(40)).lineTo(mm(10), mm(40));
    const shell = surfaceRevolve(oc, sk, [0, 0, 0], [1, 0, 0], Math.PI * 2);
    try {
      expect(shapeKind(shell)).toBe("TopAbs_SHELL");
      expect(surfaceArea(oc, shell)).toBeGreaterThan(0);
      expect(shell.isValid()).toBe(true);
    } finally {
      shell.delete();
    }
  });

  it("rejects a zero axis", () => {
    const sk = square(mm(10), 0);
    expect(() => surfaceRevolve(oc, sk, [0, 0, 0], [0, 0, 0], Math.PI)).toThrow(
      /surfaceRevolve: axis must be a non-zero vector/,
    );
  });
});

describe("surfaceFromPoints", () => {
  it("fits a planar rectangular grid into a face of the expected area", () => {
    // 3×3 grid on z=0 covering [0,0.04] × [0,0.03] → area 0.0012 m².
    const xu = [0, 0.02, 0.04];
    const yv = [0, 0.015, 0.03];
    const grid = xu.map((x) => yv.map((y): [number, number, number] => [x, y, 0]));
    const face = surfaceFromPoints(oc, grid, { degU: 1, degV: 1 });
    try {
      expect(shapeKind(face)).toBe("TopAbs_FACE");
      expect(surfaceArea(oc, face)).toBeCloseTo(0.04 * 0.03, 6);
      expect(face.isValid()).toBe(true);
    } finally {
      face.delete();
    }
  });

  it("rejects a non-rectangular grid", () => {
    expect(() =>
      surfaceFromPoints(oc, [
        [
          [0, 0, 0],
          [1, 0, 0],
        ],
        [[0, 1, 0]],
      ]),
    ).toThrow(/rectangular grid/);
  });
});

describe("sew (heal.ts) surface-pillar integration", () => {
  it("sews box faces into a closed shell with zero free edges", () => {
    // solidify is owned by heal.ts and currently blocked by unbound TopoDS_Shell
    // (`TopoDS.Shell_1` throws UnboundTypeError in this wasm) — not reimplemented
    // here. Closure is still verified via sew's free-edge report.
    const box = makeBox(oc, mm(40), mm(30), mm(20));
    const S = shapeEnums(oc);
    const faces: Solid[] = [];
    const exp = new oc.TopExp_Explorer_2(box.shape, S.TopAbs_FACE, S.TopAbs_SHAPE);
    while (exp.More()) {
      faces.push(new Solid(oc, oc.TopoDS.Face_1(exp.Current())));
      exp.Next();
    }
    exp.delete();

    const { shell, freeEdges } = sew(oc, faces, 1e-6);
    try {
      expect(freeEdges.freeEdgeCount).toBe(0);
      expect(freeEdges.sewingFreeEdges).toBe(0);
      // Sewed closed box faces form a SHELL (or compound-of-shell).
      expect(["TopAbs_SHELL", "TopAbs_COMPOUND"]).toContain(shapeKind(shell));
    } finally {
      shell.delete();
      for (const f of faces) f.delete();
      box.delete();
    }
  });
});

describe("offsetSurface", () => {
  it("offsets a planar face and preserves area on a flat sheet", () => {
    const box = makeBox(oc, mm(40), mm(30), mm(20));
    const { face, area } = firstFaceSolid(box);
    const offset = offsetSurface(oc, face, mm(5));
    try {
      expect(isSheet(offset)).toBe(true);
      // Planar offset of a rectangle keeps the same area (no side walls).
      expect(surfaceArea(oc, offset)).toBeCloseTo(area, 6);
      expect(offset.isValid()).toBe(true);
    } finally {
      offset.delete();
      face.delete();
      box.delete();
    }
  });

  it("rejects a zero distance", () => {
    const box = makeBox(oc, mm(10), mm(10), mm(10));
    const { face } = firstFaceSolid(box);
    try {
      expect(() => offsetSurface(oc, face, 0)).toThrow(/offsetSurface: distance must be/);
    } finally {
      face.delete();
      box.delete();
    }
  });
});

describe("patch", () => {
  it("fills a square wire boundary into a face of the square's area", () => {
    // Build four edges of a 20 mm square on z=0.
    const h = mm(10);
    const corners: [number, number, number][] = [
      [-h, -h, 0],
      [h, -h, 0],
      [h, h, 0],
      [-h, h, 0],
    ];
    const edges: TopoDS_Edge[] = [];
    const trash: Array<{ delete(): void }> = [];
    try {
      for (let i = 0; i < 4; i++) {
        const a = corners[i]!;
        const b = corners[(i + 1) % 4]!;
        const p0 = new oc.gp_Pnt_3(a[0], a[1], a[2]);
        const p1 = new oc.gp_Pnt_3(b[0], b[1], b[2]);
        trash.push(p0, p1);
        const em = new oc.BRepBuilderAPI_MakeEdge_3(p0, p1);
        trash.push(em);
        edges.push(em.Edge());
      }
      const face = patch(oc, edges);
      try {
        expect(shapeKind(face)).toBe("TopAbs_FACE");
        expect(surfaceArea(oc, face)).toBeCloseTo((2 * h) ** 2, 4);
        expect(face.isValid()).toBe(true);
      } finally {
        face.delete();
      }
    } finally {
      for (const e of edges) e.delete();
      for (let i = trash.length - 1; i >= 0; i--) trash[i]!.delete();
    }
  });
});
