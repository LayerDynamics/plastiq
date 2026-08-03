// §15 freeform feature — generator → tessellate (pure TS) and rebuild path
// (NurbsSurface JSON → pure-TS sample grid → surfaceFromPoints face Solid).

import { beforeAll, describe, expect, it } from "vitest";
import {
  initOcct,
  mm,
  planeSurface,
  cylinderSurface,
  sphereSurface,
  tessellateFreeform,
  evaluate,
  domain,
  type Occt,
  type NurbsSurface,
} from "@plastiq/cad";
import type { CadDocument } from "../store/types.js";
import { rebuildDocument } from "./rebuild.js";

let oc: Occt;
beforeAll(async () => {
  oc = await initOcct();
}, 120_000);

/** Plain-JSON clone of a NurbsSurface for feature.data.surface. */
function surfaceJson(s: NurbsSurface): Record<string, unknown> {
  return {
    degU: s.degU,
    degV: s.degV,
    knotsU: s.knotsU.slice(),
    knotsV: s.knotsV.slice(),
    controlNet: s.controlNet.map((row) => row.map((p) => [p[0], p[1], p[2]])),
    ...(s.weights ? { weights: s.weights.map((r) => r.slice()) } : {}),
  };
}

/** Surface area of a sheet body via OCCT (m²). */
function faceArea(solid: { shape: unknown }): number {
  const props = new oc.GProp_GProps_1();
  try {
    oc.BRepGProp.SurfaceProperties_1(solid.shape as never, props, false, false);
    return props.Mass();
  } finally {
    props.delete();
  }
}

describe("§15 freeform — generator → pure-TS tessellate", () => {
  it("planeSurface tessellates to a watertight (resU+1)×(resV+1) grid", () => {
    const surf = planeSurface([0, 0, 0], [1, 0, 0], [0, 1, 0], mm(40), mm(30));
    const mesh = tessellateFreeform(surf, { resU: 4, resV: 3 });
    // (4+1)×(3+1) = 20 vertices; 4×3×2 = 24 triangles.
    expect(mesh.positions.length).toBe(20 * 3);
    expect(mesh.normals.length).toBe(20 * 3);
    expect(mesh.indices.length).toBe(24 * 3);
    // Corners of the plane land exactly on the bilinear patch.
    const { u0, u1, v0, v1 } = domain(surf);
    expect(evaluate(surf, u0, v0)).toEqual([0, 0, 0]);
    expect(evaluate(surf, u1, v1)[0]).toBeCloseTo(mm(40), 12);
    expect(evaluate(surf, u1, v1)[1]).toBeCloseTo(mm(30), 12);
  });

  it("cylinderSurface and sphereSurface produce non-empty meshes", () => {
    const cyl = cylinderSurface([0, 0, 0], [0, 0, 1], mm(10), mm(20));
    const sph = sphereSurface([0, 0, 0], mm(15));
    const cMesh = tessellateFreeform(cyl, { resU: 16, resV: 4 });
    const sMesh = tessellateFreeform(sph, { resU: 16, resV: 8 });
    expect(cMesh.positions.length).toBeGreaterThan(0);
    expect(sMesh.indices.length).toBeGreaterThan(0);
  });
});

describe("§15 freeform feature — rebuild via surfaceFromPoints face Solid", () => {
  it("rebuilds a freeform plane with surface JSON into a face of the expected area", () => {
    const surf = planeSurface([0, 0, 0], [1, 0, 0], [0, 1, 0], mm(40), mm(30));
    const doc: CadDocument = {
      features: [
        {
          id: "f1",
          type: "freeform",
          params: { resU: 4, resV: 4 },
          data: { kind: "plane", surface: surfaceJson(surf) },
        },
      ],
      params: {},
    };
    const face = rebuildDocument(oc, doc)!;
    try {
      expect(face.isValid()).toBe(true);
      // Planar 40×30 mm patch → 0.0012 m².
      expect(faceArea(face)).toBeCloseTo(mm(40) * mm(30), 5);
    } finally {
      face.delete();
    }
  });

  it("rebuilds from data.kind + params when surface JSON is omitted", () => {
    const doc: CadDocument = {
      features: [
        {
          id: "f1",
          type: "freeform",
          params: { uSize: mm(20), vSize: mm(10), ox: 0, oy: 0, oz: 0, resU: 3, resV: 3 },
          data: { kind: "plane" },
        },
      ],
      params: {},
    };
    const face = rebuildDocument(oc, doc)!;
    try {
      expect(face.isValid()).toBe(true);
      expect(faceArea(face)).toBeCloseTo(mm(20) * mm(10), 5);
    } finally {
      face.delete();
    }
  });

  it("rebuilds a freeform cylinder wall into a valid sheet body", () => {
    const surf = cylinderSurface([0, 0, 0], [0, 0, 1], mm(10), mm(25));
    const doc: CadDocument = {
      features: [
        {
          id: "f1",
          type: "freeform",
          params: { resU: 16, resV: 6 },
          data: { kind: "cylinder", surface: surfaceJson(surf) },
        },
      ],
      params: {},
    };
    const face = rebuildDocument(oc, doc)!;
    try {
      expect(face.isValid()).toBe(true);
      // Lateral area ≈ 2π·r·h; fit is approximate so tolerate ~5%.
      const expected = 2 * Math.PI * mm(10) * mm(25);
      expect(faceArea(face)).toBeGreaterThan(expected * 0.9);
      expect(faceArea(face)).toBeLessThan(expected * 1.1);
    } finally {
      face.delete();
    }
  });

  it("rebuilds a freeform sphere into a valid sheet body", () => {
    const surf = sphereSurface([0, 0, 0], mm(12));
    const doc: CadDocument = {
      features: [
        {
          id: "f1",
          type: "freeform",
          params: { resU: 16, resV: 12 },
          data: { kind: "sphere", surface: surfaceJson(surf) },
        },
      ],
      params: {},
    };
    const face = rebuildDocument(oc, doc)!;
    try {
      expect(face.isValid()).toBe(true);
      // Sphere surface area 4πr² — approximate via fit.
      const expected = 4 * Math.PI * mm(12) ** 2;
      expect(faceArea(face)).toBeGreaterThan(expected * 0.85);
      expect(faceArea(face)).toBeLessThan(expected * 1.15);
    } finally {
      face.delete();
    }
  });

  it("fails loudly without surface JSON or kind", () => {
    const doc: CadDocument = {
      features: [{ id: "f1", type: "freeform", params: {}, data: {} }],
      params: {},
    };
    expect(() => rebuildDocument(oc, doc)).toThrow(/freeform/);
  });
});
