// SPEC-6 R0 (T0.2–T0.4): the AI authoring schema (mm/deg), the SI cadDocument
// gate, and the mm↔SI converters — the single conversion choke-point. Pure; no
// OCCT/network. The feature set + per-key unit classification mirror
// apps/plastiq/src/worker/rebuild.ts exactly.

import { describe, it, expect } from "vitest";
import { mm, deg, toMm } from "@plastiq/cad";
import {
  authoringDocumentSchema,
  cadDocumentSchema,
  toCadDocument,
  toAuthoringDoc,
  type AuthoringDocument,
} from "./schema.js";

// One authoring document (mm/deg) exercising every feature type rebuild.ts knows.
// It is NOT required to build — these tests cover validation + unit conversion only.
function sampleAuthoring(): AuthoringDocument {
  return {
    features: [
      { id: "f1", type: "box", name: "Base", params: { dx: 40, dy: 20, dz: 10 } },
      {
        id: "f2",
        type: "sketch",
        data: {
          profile: { kind: "circle", center: [12, 8], radius: 5 },
          plane: { base: "XY", offset: 2 },
        },
      },
      { id: "f3", type: "extrude", params: { height: 8, back: 1 }, data: { direction: [0, 0, 1] } },
      {
        id: "f4",
        type: "sketch",
        data: {
          profile: {
            kind: "loop",
            start: [0, 0],
            segments: [
              { kind: "line", to: [10, 0] },
              { kind: "arc", through: [12, 5], to: [10, 10] },
              { kind: "spline", through: [[6, 12], [3, 11]], to: [0, 10] },
              { kind: "line", to: [0, 0] },
            ],
          },
          plane: { kind: "face", face: { normal: [0, 0, 1], centroid: [5, 5, 10] }, offset: 0 },
        },
      },
      { id: "f5", type: "revolve", params: { angle: 90, ax: 0, ay: 1, az: 0 } },
      { id: "f6", type: "cut", params: { depth: 4 } },
      {
        id: "f7",
        type: "fillet",
        params: { radius: 1.5 },
        data: { edges: [{ faceNormals: [[0, 0, 1], [1, 0, 0]], midpoint: [5, 0, 10] }] },
      },
      {
        id: "f8",
        type: "chamfer",
        params: { distance: 0.8 },
        data: { edges: [{ faceNormals: [[0, 0, 1], [0, 1, 0]] }] },
      },
      {
        id: "f9",
        type: "shell",
        params: { thickness: 2 },
        data: { faces: [{ normal: [0, 0, 1] }] },
      },
      {
        id: "f10",
        type: "draft",
        params: { angle: 5 },
        data: {
          face: { normal: [1, 0, 0] },
          pull: [0, 0, 1],
          neutralOrigin: [0, 0, 30],
          neutralNormal: [0, 0, 1],
        },
      },
      { id: "f11", type: "transform", params: { tx: 5, ty: 0, tz: 0, angle: 45, ax: 0, ay: 0, az: 1 } },
      { id: "f12", type: "mirror", params: { ox: 0, oy: 0, oz: 0, nx: 1, ny: 0, nz: 0, merge: 1 } },
      { id: "f13", type: "linearPattern", params: { spacing: 15, count: 3, dx: 1, dy: 0, dz: 0 } },
      { id: "f14", type: "circularPattern", params: { count: 6, angle: 360, ox: 0, oy: 0, oz: 0, ax: 0, ay: 0, az: 1 } },
      {
        id: "f15",
        type: "loft",
        data: {
          ruled: true,
          sections: [
            { z: 0, profile: { kind: "circle", center: [0, 0], radius: 10 } },
            { z: 50, profile: { kind: "circle", center: [0, 0], radius: 4 } },
          ],
        },
      },
      {
        id: "f16",
        type: "sweep",
        data: {
          profile: { kind: "circle", center: [0, 0], radius: 2 },
          path: { kind: "polyline", points: [[0, 0, 0], [0, 0, 20], [10, 0, 30]] },
        },
      },
      {
        id: "f17",
        type: "boolean",
        data: {
          op: "subtract",
          toolFeatures: [{ id: "t1", type: "box", params: { dx: 5, dy: 5, dz: 50 } }],
        },
      },
      { id: "f18", type: "importStep", data: { step: "ISO-10303-21;\nHEADER;\nENDSEC;\n" } },
      { id: "f19", type: "placement", params: { tx: 1, ty: 2, tz: 3, rx: 0, ry: 0, rz: 90 } },
    ],
    params: { wall: 2 },
  };
}

describe("R0 authoring schema — validation", () => {
  it("accepts a document covering every feature type", () => {
    expect(authoringDocumentSchema.safeParse(sampleAuthoring()).success).toBe(true);
  });

  it("validates a real SI CadDocument via cadDocumentSchema", () => {
    expect(cadDocumentSchema.safeParse(toCadDocument(sampleAuthoring())).success).toBe(true);
  });

  it.each([
    ["box missing dz", { id: "x", type: "box", params: { dx: 1, dy: 1 } }],
    ["extrude missing height", { id: "x", type: "extrude", params: { back: 0 } }],
    ["fillet missing radius", { id: "x", type: "fillet", params: {}, data: { edges: [] } }],
    ["unknown feature type", { id: "x", type: "frobnicate", params: {} }],
    ["loft with one section", { id: "x", type: "loft", data: { sections: [{ z: 0, profile: { kind: "circle", center: [0, 0], radius: 1 } }] } }],
  ])("rejects %s", (_label, feature) => {
    const res = authoringDocumentSchema.safeParse({ features: [feature], params: {} });
    expect(res.success).toBe(false);
  });

  it("rejects a non-array features field", () => {
    expect(cadDocumentSchema.safeParse({ features: "nope", params: {} }).success).toBe(false);
  });
});

describe("R0 unit conversion — mm/deg → SI", () => {
  it("scales lengths mm→m (40mm box → 0.04m)", () => {
    const si = toCadDocument(sampleAuthoring());
    const box = si.features.find((f) => f.id === "f1")!;
    expect(box.params!.dx).toBeCloseTo(0.04, 12);
    expect(box.params!.dy).toBeCloseTo(0.02, 12);
    expect(box.params!.dz).toBeCloseTo(0.01, 12);
  });

  it("scales angles deg→rad and leaves axis vectors untouched", () => {
    const si = toCadDocument(sampleAuthoring());
    const rev = si.features.find((f) => f.id === "f5")!;
    expect(rev.params!.angle).toBeCloseTo(deg(90), 12);
    expect(rev.params!.ay).toBe(1); // axis component is unitless
  });

  it("converts length-bearing sketch profile + plane offset", () => {
    const si = toCadDocument(sampleAuthoring());
    const sk = si.features.find((f) => f.id === "f2")!;
    const prof = sk.data!.profile as { center: [number, number]; radius: number };
    expect(prof.center[0]).toBeCloseTo(mm(12), 12);
    expect(prof.radius).toBeCloseTo(mm(5), 12);
    expect((sk.data!.plane as { offset: number }).offset).toBeCloseTo(mm(2), 12);
  });

  it("converts loft section z + profile, and sweep path points", () => {
    const si = toCadDocument(sampleAuthoring());
    const loft = si.features.find((f) => f.id === "f15")!;
    const secs = loft.data!.sections as { z: number; profile: { radius: number } }[];
    expect(secs[1]!.z).toBeCloseTo(mm(50), 12);
    expect(secs[0]!.profile.radius).toBeCloseTo(mm(10), 12);
    const sweep = si.features.find((f) => f.id === "f16")!;
    const pts = (sweep.data!.path as { points: [number, number, number][] }).points;
    expect(pts[1]![2]).toBeCloseTo(mm(20), 12);
  });

  it("converts revolve origin lengths (ox/oy/oz) and leaves axis unitless (G2)", () => {
    const doc: AuthoringDocument = {
      features: [
        {
          id: "r1",
          type: "revolve",
          params: { angle: 180, ay: 1, ox: 5, oy: 0, oz: 2 },
        },
      ],
      params: {},
    };
    expect(authoringDocumentSchema.safeParse(doc).success).toBe(true);
    const si = toCadDocument(doc);
    expect(si.features[0]!.params!.angle).toBeCloseTo(deg(180), 12);
    expect(si.features[0]!.params!.ox).toBeCloseTo(mm(5), 12);
    expect(si.features[0]!.params!.oz).toBeCloseTo(mm(2), 12);
    expect(si.features[0]!.params!.ay).toBe(1);
  });

  it("converts cut back depth and accepts direction data (G5)", () => {
    const doc: AuthoringDocument = {
      features: [
        {
          id: "c1",
          type: "cut",
          params: { depth: 10, back: 5 },
          data: { direction: [0, 0, -1] },
        },
      ],
      params: {},
    };
    expect(authoringDocumentSchema.safeParse(doc).success).toBe(true);
    const si = toCadDocument(doc);
    expect(si.features[0]!.params!.depth).toBeCloseTo(mm(10), 12);
    expect(si.features[0]!.params!.back).toBeCloseTo(mm(5), 12);
    expect(si.features[0]!.data!.direction).toEqual([0, 0, -1]);
  });

  it("converts mixed line/arc sweep spine path + plane offset (G3/G4)", () => {
    const doc: AuthoringDocument = {
      features: [
        {
          id: "s1",
          type: "sweep",
          data: {
            profile: { kind: "circle", center: [0, 0], radius: 2 },
            plane: { base: "XZ", offset: 3 },
            mode: "frenet",
            transition: "round",
            path: {
              kind: "path",
              start: [0, 0, 0],
              segments: [
                { kind: "line", to: [0, 0, 20] },
                { kind: "arc", through: [5, 0, 30], to: [10, 0, 20] },
              ],
            },
          },
        },
      ],
      params: {},
    };
    expect(authoringDocumentSchema.safeParse(doc).success).toBe(true);
    const si = toCadDocument(doc);
    const d = si.features[0]!.data!;
    expect((d.plane as { offset: number }).offset).toBeCloseTo(mm(3), 12);
    expect(d.mode).toBe("frenet");
    expect(d.transition).toBe("round");
    const path = d.path as {
      kind: string;
      start: number[];
      segments: { kind: string; to: number[]; through?: number[] }[];
    };
    expect(path.kind).toBe("path");
    expect(path.start[2]).toBeCloseTo(0, 12);
    expect(path.segments[0]!.to[2]).toBeCloseTo(mm(20), 12);
    expect(path.segments[1]!.through![0]).toBeCloseTo(mm(5), 12);
  });

  it("accepts loft sections with plane specs and converts their offsets (G6)", () => {
    const doc: AuthoringDocument = {
      features: [
        {
          id: "l1",
          type: "loft",
          data: {
            ruled: true,
            sections: [
              {
                profile: { kind: "circle", center: [0, 0], radius: 10 },
                plane: { base: "XY", offset: 0 },
              },
              {
                profile: { kind: "circle", center: [0, 0], radius: 4 },
                plane: { base: "XY", offset: 50 },
              },
            ],
          },
        },
      ],
      params: {},
    };
    expect(authoringDocumentSchema.safeParse(doc).success).toBe(true);
    const si = toCadDocument(doc);
    const secs = si.features[0]!.data!.sections as { plane: { offset: number }; profile: { radius: number } }[];
    expect(secs[1]!.plane.offset).toBeCloseTo(mm(50), 12);
    expect(secs[0]!.profile.radius).toBeCloseTo(mm(10), 12);
  });

  it("accepts extrude join op and shell outward direction (G7/G13)", () => {
    const doc: AuthoringDocument = {
      features: [
        {
          id: "e1",
          type: "extrude",
          params: { height: 10 },
          data: { op: "join" },
        },
        {
          id: "sh1",
          type: "shell",
          params: { thickness: 2 },
          data: { faces: [{ normal: [0, 0, 1] }], direction: "outward" },
        },
      ],
      params: {},
    };
    expect(authoringDocumentSchema.safeParse(doc).success).toBe(true);
    const si = toCadDocument(doc);
    expect(si.features[0]!.data!.op).toBe("join");
    expect(si.features[1]!.data!.direction).toBe("outward");
    expect(si.features[1]!.params!.thickness).toBeCloseTo(mm(2), 12);
  });

  it("converts draft angle + neutralOrigin (length) but not normals", () => {
    const si = toCadDocument(sampleAuthoring());
    const d = si.features.find((f) => f.id === "f10")!;
    expect(d.params!.angle).toBeCloseTo(deg(5), 12);
    expect((d.data!.neutralOrigin as number[])[2]).toBeCloseTo(mm(30), 12);
    expect((d.data!.neutralNormal as number[])[2]).toBe(1); // unitless
  });

  it("recurses into boolean toolFeatures", () => {
    const si = toCadDocument(sampleAuthoring());
    const bool = si.features.find((f) => f.id === "f17")!;
    const tool = (bool.data!.toolFeatures as { params: { dz: number } }[])[0]!;
    expect(tool.params.dz).toBeCloseTo(mm(50), 12);
  });

  it("passes refs, step text and document params through unchanged", () => {
    const si = toCadDocument(sampleAuthoring());
    const fillet = si.features.find((f) => f.id === "f7")!;
    // FaceNormals are unitless; the ref is written by the selection layer in SI,
    // so the converter must NOT scale it.
    expect((fillet.data!.edges as { faceNormals: number[][] }[])[0]!.faceNormals[0]).toEqual([0, 0, 1]);
    expect(si.features.find((f) => f.id === "f18")!.data!.step).toContain("ISO-10303-21");
    expect(si.params.wall).toBe(2); // document params: unknown units → passthrough
  });

  it("scales placement pose (tx length, rz angle)", () => {
    const si = toCadDocument(sampleAuthoring());
    const p = si.features.find((f) => f.id === "f19")!;
    expect(p.params!.tx).toBeCloseTo(mm(1), 12);
    expect(p.params!.rz).toBeCloseTo(deg(90), 12);
  });
});

describe("R0 round-trip — loss-free both ways", () => {
  it("toAuthoringDoc(toCadDocument(x)) === x for every feature type", () => {
    const x = sampleAuthoring();
    const back = toAuthoringDoc(toCadDocument(x));
    // Deep value equality within float tolerance: JSON compare after rounding.
    const round = (o: unknown): unknown =>
      JSON.parse(JSON.stringify(o), (_k, v) => (typeof v === "number" ? Number(v.toFixed(9)) : v));
    expect(round(back)).toEqual(round(x));
  });

  it("toMm of the SI box dx returns the original mm value", () => {
    const si = toCadDocument(sampleAuthoring());
    expect(toMm(si.features.find((f) => f.id === "f1")!.params!.dx!)).toBeCloseTo(40, 9);
  });
});
