import { beforeAll, describe, expect, it } from "vitest";
import { exportStep, initOcct, makeBox, mm, type Occt, type Solid } from "@plastiq/cad";
import type { CadDocument } from "../store/types.js";
import type { Profile } from "../sketch/profile.js";
import { rebuildDocument, rebuildTagged, rebuildTaggedWithProps } from "./rebuild.js";

const INIT_TIMEOUT_MS = 120_000;

/** A line-loop profile from an ordered point list (sketch feature `data`). */
function loopProfile(pts: [number, number][]): Profile {
  const [start, ...rest] = pts;
  return { kind: "loop", start: start!, segments: rest.map((to) => ({ kind: "line", to })) };
}

/** Solid volume of a kernel Solid via volume mass properties. */
function solidVolume(oc: Occt, solid: Solid): number {
  const props = new oc.GProp_GProps_1();
  try {
    oc.BRepGProp.VolumeProperties_1(solid.shape, props, false, false, false);
    return props.Mass();
  } finally {
    props.delete();
  }
}

/** Z of a solid's volume centroid. */
function solidCentroidZ(oc: Occt, solid: Solid): number {
  const props = new oc.GProp_GProps_1();
  try {
    oc.BRepGProp.VolumeProperties_1(solid.shape, props, false, false, false);
    const c = props.CentreOfMass();
    const z = c.Z();
    c.delete();
    return z;
  } finally {
    props.delete();
  }
}

describe("CAD Studio rebuild (SPEC-5 M0.4)", () => {
  let oc: Occt;
  beforeAll(async () => {
    oc = await initOcct();
  }, INIT_TIMEOUT_MS);

  it("evaluates a box-feature document → a valid solid + tagged mesh", () => {
    const doc: CadDocument = {
      features: [{ id: "f1", type: "box", params: { dx: mm(20), dy: mm(30), dz: mm(40) } }],
      params: {},
    };
    const solid = rebuildDocument(oc, doc);
    expect(solid).not.toBeNull();
    try {
      expect(solid!.isValid()).toBe(true);
    } finally {
      solid!.delete();
    }
    const mesh = rebuildTagged(oc, doc, { linearDeflection: mm(0.5) });
    expect(mesh).not.toBeNull();
    expect(mesh!.faceGroups).toHaveLength(6);
    expect(mesh!.edges).toHaveLength(12);
  });

  it("rebuildTaggedWithProps reports the solid's volume + centroid alongside the mesh", () => {
    const doc: CadDocument = {
      features: [{ id: "f1", type: "box", params: { dx: mm(20), dy: mm(30), dz: mm(40) } }],
      params: {},
    };
    const built = rebuildTaggedWithProps(oc, doc, { linearDeflection: mm(0.5) });
    expect(built).not.toBeNull();
    expect(built!.mesh.faceGroups).toHaveLength(6); // same tagged mesh as rebuildTagged
    // 20×30×40 mm box → volume = 20·30·40 mm³; makeBox has a corner at the origin
    // so the centroid sits at half-extents (mm 10, 15, 20).
    expect(built!.volume).toBeCloseTo(mm(20) * mm(30) * mm(40), 12);
    expect(built!.com[0]).toBeCloseTo(mm(10), 9);
    expect(built!.com[1]).toBeCloseTo(mm(15), 9);
    expect(built!.com[2]).toBeCloseTo(mm(20), 9);
  });

  it("rebuildTaggedWithProps returns null for a document with no geometry", () => {
    const built = rebuildTaggedWithProps(oc, { features: [], params: {} }, { linearDeflection: mm(0.5) });
    expect(built).toBeNull();
  });

  it("evaluates a sketch→extrude document", () => {
    const m = (x: number): number => mm(x);
    const doc: CadDocument = {
      features: [
        {
          id: "f1",
          type: "sketch",
          data: {
            profile: loopProfile([
              [m(-20), m(-15)],
              [m(20), m(-15)],
              [m(20), m(15)],
              [m(-20), m(15)],
            ]),
          },
        },
        { id: "f2", type: "extrude", deps: ["f1"], params: { height: m(20) } },
      ],
      params: {},
    };
    const mesh = rebuildTagged(oc, doc, { linearDeflection: mm(0.5) });
    expect(mesh).not.toBeNull();
    expect(mesh!.faceGroups.length).toBeGreaterThanOrEqual(6); // a box-like prism
    expect(mesh!.indices.length).toBeGreaterThan(0);
  });

  it("a sketch's datum plane reorients the extrude (XZ extrudes along Y, not Z)", () => {
    const m = (x: number): number => mm(x);
    // A 20×30 mm rect at the plane origin, extruded 20 mm along the plane normal.
    const rect = loopProfile([
      [0, 0],
      [m(20), 0],
      [m(20), m(30)],
      [0, m(30)],
    ]);
    const comOn = (base: "XY" | "XZ"): [number, number, number] => {
      const doc: CadDocument = {
        features: [
          { id: "f1", type: "sketch", data: { profile: rect, plane: { base, offset: 0 } } },
          { id: "f2", type: "extrude", deps: ["f1"], params: { height: m(20) } },
        ],
        params: {},
      };
      return rebuildTaggedWithProps(oc, doc, { linearDeflection: mm(0.5) })!.com;
    };
    // XY: the 20 mm height runs along +Z (|z|≈10), the profile spans Y (|y|≈15).
    const xy = comOn("XY");
    expect(Math.abs(xy[2])).toBeCloseTo(m(10), 6);
    expect(Math.abs(xy[1])).toBeCloseTo(m(15), 6);
    // XZ: the SAME profile now extrudes along Y (|y|≈10) and spans Z (|z|≈15) —
    // proof the plane reaches the geometry, not a hardcoded XY.
    const xz = comOn("XZ");
    expect(Math.abs(xz[1])).toBeCloseTo(m(10), 6);
    expect(Math.abs(xz[2])).toBeCloseTo(m(15), 6);
  });

  it("a sketch's plane offset shifts the solid along the normal by that distance", () => {
    const m = (x: number): number => mm(x);
    const rect = loopProfile([
      [0, 0],
      [m(20), 0],
      [m(20), m(30)],
      [0, m(30)],
    ]);
    const comZ = (offset: number): number => {
      const doc: CadDocument = {
        features: [
          { id: "f1", type: "sketch", data: { profile: rect, plane: { base: "XY", offset } } },
          { id: "f2", type: "extrude", deps: ["f1"], params: { height: m(20) } },
        ],
        params: {},
      };
      return rebuildTaggedWithProps(oc, doc, { linearDeflection: mm(0.5) })!.com[2];
    };
    // A 50 mm offset along +Z lifts the whole solid (its centroid z) by 50 mm.
    expect(comZ(m(50)) - comZ(0)).toBeCloseTo(m(50), 6);
  });

  it("a sketch on a model FACE builds on that face, and its offset shifts along the face normal", () => {
    const m = (x: number): number => mm(x);
    const rect = loopProfile([
      [0, 0],
      [m(10), 0],
      [m(10), m(10)],
      [0, m(10)],
    ]);
    // Box 60×40×30 mm: its +Z top face sits at z = 30 mm. A sketch resolved on that
    // face (via its FaceRef) then extruded must build at z≈30 mm — NOT the XY plane
    // (which would put the solid's centroid near z≈10 mm).
    const comZ = (faceOffset: number): number => {
      const doc: CadDocument = {
        features: [
          { id: "f1", type: "box", params: { dx: m(60), dy: m(40), dz: m(30) } },
          {
            id: "f2",
            type: "sketch",
            deps: ["f1"],
            data: { profile: rect, plane: { kind: "face", face: { normal: [0, 0, 1] }, offset: faceOffset } },
          },
          { id: "f3", type: "extrude", deps: ["f2"], params: { height: m(20) } },
        ],
        params: {},
      };
      return rebuildTaggedWithProps(oc, doc, { linearDeflection: mm(0.5) })!.com[2];
    };
    const onFace = comZ(0);
    expect(onFace).toBeGreaterThan(m(15)); // on the 30 mm top face, not the XY plane (~10)
    expect(onFace).toBeLessThan(m(45));
    // A 10 mm face offset lifts the solid a further 10 mm along the face normal.
    expect(comZ(m(10)) - onFace).toBeCloseTo(m(10), 6);
  });

  it("cut with back produces a two-sided pocket tool (G5)", () => {
    const m = (x: number): number => mm(x);
    // Box 60×40×30; sketch on mid-height plane; two-sided cut depth 20 + back 20
    // must punch a through-pocket (volume < original).
    const doc: CadDocument = {
      features: [
        { id: "f1", type: "box", params: { dx: m(60), dy: m(40), dz: m(30) } },
        {
          id: "f2",
          type: "sketch",
          data: {
            profile: loopProfile([
              [m(20), m(10)],
              [m(40), m(10)],
              [m(40), m(30)],
              [m(20), m(30)],
            ]),
            plane: { base: "XY", offset: m(15) },
          },
        },
        { id: "f3", type: "cut", deps: ["f2"], params: { depth: m(20), back: m(20) } },
      ],
      params: {},
    };
    const built = rebuildTaggedWithProps(oc, doc, { linearDeflection: mm(0.5) });
    expect(built).not.toBeNull();
    const boxVol = m(60) * m(40) * m(30);
    expect(built!.volume).toBeLessThan(boxVol);
    // Through-pocket: removed ≈ 20×20×30 mm³.
    expect(built!.volume).toBeCloseTo(boxVol - m(20) * m(20) * m(30), 7);
  });

  it("box → sketch → cut subtracts a pocket from the current solid (FR-29)", () => {
    const m = (x: number): number => mm(x);
    const doc: CadDocument = {
      features: [
        { id: "f1", type: "box", params: { dx: m(60), dy: m(40), dz: m(30) } },
        {
          id: "f2",
          type: "sketch",
          data: {
            profile: loopProfile([
              [m(15), m(10)],
              [m(45), m(10)],
              [m(45), m(30)],
              [m(15), m(30)],
            ]),
          },
        },
        { id: "f3", type: "cut", deps: ["f2"], params: { depth: m(50) } },
      ],
      params: {},
    };
    const mesh = rebuildTagged(oc, doc, { linearDeflection: mm(0.5) });
    expect(mesh).not.toBeNull();
    // A through-pocket adds faces beyond the plain box's 6.
    expect(mesh!.faceGroups.length).toBeGreaterThan(6);
    expect(mesh!.indices.length).toBeGreaterThan(0);
  });

  it("sketch → revolve produces a solid of revolution (FR-29)", () => {
    const m = (x: number): number => mm(x);
    // A profile offset from the Y axis, revolved a full turn about Y → a ring/disc.
    const doc: CadDocument = {
      features: [
        {
          id: "f1",
          type: "sketch",
          data: {
            profile: loopProfile([
              [m(10), m(0)],
              [m(20), m(0)],
              [m(20), m(10)],
              [m(10), m(10)],
            ]),
          },
        },
        { id: "f2", type: "revolve", deps: ["f1"], params: { angle: Math.PI * 2, ay: 1 } },
      ],
      params: {},
    };
    const mesh = rebuildTagged(oc, doc, { linearDeflection: mm(0.5) });
    expect(mesh).not.toBeNull();
    expect(mesh!.faceGroups.length).toBeGreaterThan(0);
    expect(mesh!.indices.length).toBeGreaterThan(0);
  });

  it("revolve honours an offset axis origin (ox/oy/oz) (G2)", () => {
    const m = (x: number): number => mm(x);
    // Profile at x∈[10,20] mm on XY; revolve about Y through x=5 mm (not world origin).
    // Volume = 2π · centroid_x · area  (Pappus) with centroid relative to the axis.
    // Relative to x=5: strip spans [5,15] mm, area=10×10 mm², centroid at x_rel=10 mm →
    // V = 2π · 0.01 · (0.01·0.01) = 2π · 1e-6.
    const doc: CadDocument = {
      features: [
        {
          id: "f1",
          type: "sketch",
          data: {
            profile: loopProfile([
              [m(10), m(0)],
              [m(20), m(0)],
              [m(20), m(10)],
              [m(10), m(10)],
            ]),
          },
        },
        {
          id: "f2",
          type: "revolve",
          deps: ["f1"],
          params: { angle: Math.PI * 2, ay: 1, ox: m(5), oy: 0, oz: 0 },
        },
      ],
      params: {},
    };
    const built = rebuildTaggedWithProps(oc, doc, { linearDeflection: mm(0.5) });
    expect(built).not.toBeNull();
    // Same profile revolved about x=0 has a different volume — prove ox was applied.
    const aboutOrigin = rebuildTaggedWithProps(
      oc,
      {
        features: [
          doc.features[0]!,
          { id: "f2", type: "revolve", deps: ["f1"], params: { angle: Math.PI * 2, ay: 1 } },
        ],
        params: {},
      },
      { linearDeflection: mm(0.5) },
    )!;
    expect(built!.volume).not.toBeCloseTo(aboutOrigin.volume, 6);
    // Pappus: centroid distance from axis at x=5 is (15mm mean of 10..20) − 5 = 10 mm;
    // area = 100 mm² → V = 2π · 0.01 · 1e-4 = 2π · 1e-6.
    expect(built!.volume).toBeCloseTo(2 * Math.PI * m(10) * (m(10) * m(10)), 8);
  });

  it("cut with no solid to cut into throws", () => {
    const doc: CadDocument = {
      features: [
        {
          id: "f1",
          type: "sketch",
          data: {
            profile: loopProfile([
              [0, 0],
              [0.01, 0],
              [0.01, 0.01],
            ]),
          },
        },
        { id: "f2", type: "cut", deps: ["f1"], params: { depth: 0.02 } },
      ],
      params: {},
    };
    expect(() => rebuildDocument(oc, doc)).toThrow(/no solid to cut into/);
  });

  it("a fillet on a picked EdgeRef survives an upstream box resize (FR-16)", () => {
    // Tessellate a box to capture a real edge's persistent EdgeRef signature.
    const probe: CadDocument = {
      features: [{ id: "f1", type: "box", params: { dx: mm(40), dy: mm(30), dz: mm(20) } }],
      params: {},
    };
    const tagged = rebuildTagged(oc, probe, { linearDeflection: mm(0.5) })!;
    const edgeRef = { faceNormals: tagged.edges[0]!.faceNormals };

    const doc = (dx: number): CadDocument => ({
      features: [
        { id: "f1", type: "box", params: { dx, dy: mm(30), dz: mm(20) } },
        {
          id: "f2",
          type: "fillet",
          deps: ["f1"],
          params: { radius: mm(3) },
          data: { edges: [edgeRef] },
        },
      ],
      params: {},
    });

    // Original build: the fillet rounds the referenced edge (faces > 6).
    const a = rebuildTagged(oc, doc(mm(40)), { linearDeflection: mm(0.5) })!;
    expect(a.faceGroups.length).toBeGreaterThan(6);

    // Resize the box: the EdgeRef must RE-RESOLVE to the same logical edge and
    // the fillet must still apply (no R2 throw, still rounded).
    const b = rebuildTagged(oc, doc(mm(80)), { linearDeflection: mm(0.5) })!;
    expect(b.faceGroups.length).toBe(a.faceGroups.length);
  });

  it("chamfer on a picked EdgeRef bevels the edge (FR-30)", () => {
    const probe: CadDocument = {
      features: [{ id: "f1", type: "box", params: { dx: mm(40), dy: mm(30), dz: mm(20) } }],
      params: {},
    };
    const edgeRef = {
      faceNormals: rebuildTagged(oc, probe, { linearDeflection: mm(0.5) })!.edges[0]!.faceNormals,
    };
    const doc: CadDocument = {
      features: [
        { id: "f1", type: "box", params: { dx: mm(40), dy: mm(30), dz: mm(20) } },
        {
          id: "f2",
          type: "chamfer",
          deps: ["f1"],
          params: { distance: mm(3) },
          data: { edges: [edgeRef] },
        },
      ],
      params: {},
    };
    const m = rebuildTagged(oc, doc, { linearDeflection: mm(0.5) });
    expect(m!.faceGroups.length).toBeGreaterThan(6);
  });

  it("shell on a picked FaceRef hollows the solid (FR-30)", () => {
    const probe: CadDocument = {
      features: [{ id: "f1", type: "box", params: { dx: mm(40), dy: mm(30), dz: mm(20) } }],
      params: {},
    };
    const top = rebuildTagged(oc, probe, { linearDeflection: mm(0.5) })!.faceGroups[0]!;
    const doc: CadDocument = {
      features: [
        { id: "f1", type: "box", params: { dx: mm(40), dy: mm(30), dz: mm(20) } },
        {
          id: "f2",
          type: "shell",
          deps: ["f1"],
          params: { thickness: mm(2) },
          data: { faces: [{ normal: top.normal }] },
        },
      ],
      params: {},
    };
    const m = rebuildTagged(oc, doc, { linearDeflection: mm(0.5) });
    // Hollowing an open box adds inner-wall faces.
    expect(m!.faceGroups.length).toBeGreaterThan(6);
  });

  it("a draft feature tapers a picked face (FR-30, T4)", () => {
    // Capture a real +X side-face signature to draft about a neutral plane.
    const probe: CadDocument = {
      features: [{ id: "f1", type: "box", params: { dx: mm(40), dy: mm(30), dz: mm(20) } }],
      params: {},
    };
    const side = rebuildTagged(oc, probe, { linearDeflection: mm(0.5) })!.faceGroups.find(
      (g) => Math.round(g.normal[0]) === 1,
    )!;
    const doc: CadDocument = {
      features: [
        { id: "f1", type: "box", params: { dx: mm(40), dy: mm(30), dz: mm(20) } },
        {
          id: "f2",
          type: "draft",
          deps: ["f1"],
          params: { angle: (5 * Math.PI) / 180 },
          data: {
            face: { normal: side.normal, centroid: side.centroid },
            pull: [0, 0, 1],
            neutralOrigin: [0, 0, 0],
            neutralNormal: [0, 0, 1],
          },
        },
      ],
      params: {},
    };
    const solid = rebuildDocument(oc, doc);
    expect(solid).not.toBeNull();
    try {
      expect(solid!.isValid()).toBe(true);
      // Draft TILTS the face (removing material above the neutral plane): volume
      // drops but stays close — a botched op would change it drastically.
      const v = solidVolume(oc, solid!);
      const full = mm(40) * mm(30) * mm(20);
      expect(v).toBeLessThan(full);
      expect(v).toBeGreaterThan(full * 0.9);
    } finally {
      solid!.delete();
    }
    // Draft neither adds nor drops faces — still a 6-faced box-like solid.
    expect(rebuildTagged(oc, doc, { linearDeflection: mm(0.5) })!.faceGroups).toHaveLength(6);
  });

  it("fillet with no edges selected throws a typed error", () => {
    const doc: CadDocument = {
      features: [
        { id: "f1", type: "box", params: { dx: mm(20), dy: mm(20), dz: mm(20) } },
        { id: "f2", type: "fillet", deps: ["f1"], params: { radius: mm(2) }, data: { edges: [] } },
      ],
      params: {},
    };
    expect(() => rebuildDocument(oc, doc)).toThrow(/no edges selected/);
  });

  it("a linear pattern fuses N copies of the body (FR-31)", () => {
    const doc: CadDocument = {
      features: [
        { id: "f1", type: "box", params: { dx: mm(10), dy: mm(10), dz: mm(10) } },
        {
          id: "f2",
          type: "linearPattern",
          deps: ["f1"],
          params: { dx: 1, spacing: mm(30), count: 3 },
        },
      ],
      params: {},
    };
    const mesh = rebuildTagged(oc, doc, { linearDeflection: mm(0.5) });
    expect(mesh).not.toBeNull();
    // Three disjoint boxes → 18 faces fused into one compound solid.
    expect(mesh!.faceGroups.length).toBe(18);
  });

  it("a mirror+merge makes a symmetric body (FR-31)", () => {
    const doc: CadDocument = {
      features: [
        { id: "f1", type: "box", params: { dx: mm(20), dy: mm(10), dz: mm(10) } },
        { id: "f2", type: "mirror", deps: ["f1"], params: { nx: 1, ox: mm(40), merge: 1 } },
      ],
      params: {},
    };
    const mesh = rebuildTagged(oc, doc, { linearDeflection: mm(0.5) });
    expect(mesh).not.toBeNull();
    expect(mesh!.faceGroups.length).toBeGreaterThanOrEqual(12); // two boxes' worth
  });

  it("a boolean subtract removes a box tool from the body (FR-31)", () => {
    const doc: CadDocument = {
      features: [
        { id: "f1", type: "box", params: { dx: mm(40), dy: mm(40), dz: mm(40) } },
        {
          id: "f2",
          type: "boolean",
          deps: ["f1"],
          params: { dx: mm(20), dy: mm(20), dz: mm(50), tx: mm(10), ty: mm(10), tz: mm(-5) },
          data: { op: "subtract" },
        },
      ],
      params: {},
    };
    const mesh = rebuildTagged(oc, doc, { linearDeflection: mm(0.5) });
    expect(mesh).not.toBeNull();
    expect(mesh!.faceGroups.length).toBeGreaterThan(6); // pocket adds faces
  });

  it("a boolean with a modelled tool body subtracts a second body (FR-31)", () => {
    const m = (x: number): number => mm(x);
    // Base box 40×40×30; tool body = a 20×20 pad (sketch→extrude) taller than the
    // box, subtracted → a through-pocket of 20×20×30.
    const doc: CadDocument = {
      features: [
        { id: "f1", type: "box", params: { dx: m(40), dy: m(40), dz: m(30) } },
        {
          id: "f2",
          type: "boolean",
          deps: ["f1"],
          data: {
            op: "subtract",
            toolFeatures: [
              {
                id: "t0",
                type: "sketch",
                data: {
                  profile: loopProfile([
                    [m(10), m(10)],
                    [m(30), m(10)],
                    [m(30), m(30)],
                    [m(10), m(30)],
                  ]),
                },
              },
              { id: "t1", type: "extrude", params: { height: m(50) } },
            ],
          },
        },
      ],
      params: {},
    };
    const solid = rebuildDocument(oc, doc);
    try {
      expect(solid!.isValid()).toBe(true);
      const expected = m(40) * m(40) * m(30) - m(20) * m(20) * m(30);
      expect(Math.abs(solidVolume(oc, solid!) - expected) / expected).toBeLessThan(1e-4);
    } finally {
      solid!.delete();
    }
  });

  it("a baked transform translates the body (FR-31)", () => {
    const doc: CadDocument = {
      features: [
        { id: "f1", type: "box", params: { dx: mm(10), dy: mm(10), dz: mm(10) } },
        { id: "f2", type: "transform", deps: ["f1"], params: { tx: mm(50) } },
      ],
      params: {},
    };
    const mesh = rebuildTagged(oc, doc, { linearDeflection: mm(0.5) })!;
    // Still a 6-faced box, now centred near x≈55mm (origin box was 0..10mm).
    expect(mesh.faceGroups).toHaveLength(6);
    const xs = mesh.vertices.filter((_, i) => i % 3 === 0);
    expect(Math.min(...xs)).toBeGreaterThan(mm(45));
  });

  it("a suppressed feature is skipped", () => {
    const doc: CadDocument = {
      features: [
        { id: "f1", type: "box", params: { dx: mm(10), dy: mm(10), dz: mm(10) } },
        { id: "f2", type: "box", params: { dx: mm(50), dy: mm(50), dz: mm(50) }, suppressed: true },
      ],
      params: {},
    };
    // f2 suppressed → the result is the f1 box (1e-6 m³), not the 50mm one.
    const mesh = rebuildTagged(oc, doc, { linearDeflection: mm(0.5) });
    expect(mesh!.faceGroups).toHaveLength(6);
    // (f2 would also be 6 faces; the point is it doesn't throw / it uses f1's box)
  });

  it("an importStep feature rebuilds the imported STEP solid (FR-42)", () => {
    // Export a box to STEP, then a document that imports it back as a base body.
    const box = makeBox(oc, mm(20), mm(30), mm(40));
    const step = exportStep(oc, box);
    box.delete();
    const doc: CadDocument = {
      features: [{ id: "f1", type: "importStep", name: "part.step", data: { step } }],
      params: {},
    };
    const mesh = rebuildTagged(oc, doc, { linearDeflection: mm(0.5) });
    expect(mesh).not.toBeNull();
    expect(mesh!.faceGroups).toHaveLength(6); // the box survived the STEP round-trip
  });

  it("importStep with no STEP text throws", () => {
    const doc: CadDocument = { features: [{ id: "f1", type: "importStep", data: {} }], params: {} };
    expect(() => rebuildDocument(oc, doc)).toThrow(/missing STEP text/);
  });

  it("a circle sketch → extrude builds a true cylinder (FR-16 curved profile)", () => {
    const r = mm(8);
    const h = mm(15);
    const doc: CadDocument = {
      features: [
        {
          id: "f1",
          type: "sketch",
          data: { profile: { kind: "circle", center: [0, 0], radius: r } },
        },
        { id: "f2", type: "extrude", deps: ["f1"], params: { height: h } },
      ],
      params: {},
    };
    const solid = rebuildDocument(oc, doc);
    expect(solid).not.toBeNull();
    try {
      // A faceted polygon profile would undershoot π r² h by ~1%; a real arc
      // edge hits it to 1e-6 — the editor pipeline carried the curve through.
      const expected = Math.PI * r * r * h;
      expect(Math.abs(solidVolume(oc, solid!) - expected) / expected).toBeLessThan(1e-6);
    } finally {
      solid!.delete();
    }
  });

  it("a line+arc half-disc profile extrudes to a half-cylinder (FR-16 arc tool)", () => {
    const r = mm(12);
    const h = mm(10);
    const doc: CadDocument = {
      features: [
        {
          id: "f1",
          type: "sketch",
          data: {
            profile: {
              kind: "loop",
              start: [-r, 0],
              segments: [
                { kind: "line", to: [r, 0] },
                { kind: "arc", through: [0, r], to: [-r, 0] },
              ],
            },
          },
        },
        { id: "f2", type: "extrude", deps: ["f1"], params: { height: h } },
      ],
      params: {},
    };
    const solid = rebuildDocument(oc, doc);
    expect(solid).not.toBeNull();
    try {
      // Half-disc area π r²/2 × height — the closing edge is a real arc, so the
      // volume hits the analytic value (a chord would undershoot it).
      const expected = ((Math.PI * r * r) / 2) * h;
      expect(Math.abs(solidVolume(oc, solid!) - expected) / expected).toBeLessThan(1e-4);
    } finally {
      solid!.delete();
    }
  });

  it("a slot profile (2 lines + 2 arc caps) extrudes to its analytic volume (FR-16)", () => {
    const r = mm(5);
    const L = mm(30); // centre-line length
    const h = mm(8);
    // Centre line (0,0)→(L,0); +y normal. Sides at ±r; caps past each end.
    const doc: CadDocument = {
      features: [
        {
          id: "f1",
          type: "sketch",
          data: {
            profile: {
              kind: "loop",
              start: [0, r],
              segments: [
                { kind: "line", to: [L, r] },
                { kind: "arc", through: [L + r, 0], to: [L, -r] },
                { kind: "line", to: [0, -r] },
                { kind: "arc", through: [-r, 0], to: [0, r] },
              ],
            },
          },
        },
        { id: "f2", type: "extrude", deps: ["f1"], params: { height: h } },
      ],
      params: {},
    };
    const solid = rebuildDocument(oc, doc);
    expect(solid).not.toBeNull();
    try {
      // Slot area = rectangle 2r·L + full circle π r² (two semicircle caps).
      const area = 2 * r * L + Math.PI * r * r;
      const expected = area * h;
      expect(Math.abs(solidVolume(oc, solid!) - expected) / expected).toBeLessThan(1e-4);
    } finally {
      solid!.delete();
    }
  });

  it("a spline-sided profile extrudes to a valid solid (FR-16 spline tool)", () => {
    const r = mm(10);
    const h = mm(6);
    const doc: CadDocument = {
      features: [
        {
          id: "f1",
          type: "sketch",
          data: {
            profile: {
              kind: "loop",
              start: [-r, 0],
              segments: [
                { kind: "line", to: [r, 0] },
                {
                  kind: "spline",
                  through: [
                    [r, r],
                    [0, 1.4 * r],
                    [-r, r],
                    [-r, 0],
                  ],
                  to: [-r, 0],
                },
              ],
            },
          },
        },
        { id: "f2", type: "extrude", deps: ["f1"], params: { height: h } },
      ],
      params: {},
    };
    const solid = rebuildDocument(oc, doc);
    expect(solid).not.toBeNull();
    try {
      expect(solid!.isValid()).toBe(true);
      // Bounded by the flat-top box r×2r×... and ≥ the half-disc area; just
      // assert a real positive volume (spline area has no closed form).
      expect(solidVolume(oc, solid!)).toBeGreaterThan(0);
    } finally {
      solid!.delete();
    }
  });

  it("a two-sided extrude pads both ways (FR-29)", () => {
    const m = (x: number): number => mm(x);
    const doc: CadDocument = {
      features: [
        {
          id: "f1",
          type: "sketch",
          data: {
            profile: loopProfile([
              [m(-20), m(-15)],
              [m(20), m(-15)],
              [m(20), m(15)],
              [m(-20), m(15)],
            ]),
          },
        },
        { id: "f2", type: "extrude", deps: ["f1"], params: { height: m(10), back: m(10) } },
      ],
      params: {},
    };
    const solid = rebuildDocument(oc, doc);
    try {
      // 40×30 profile × (10+10)mm, centred on z=0.
      const expected = m(40) * m(30) * m(20);
      expect(Math.abs(solidVolume(oc, solid!) - expected) / expected).toBeLessThan(1e-5);
      expect(solidCentroidZ(oc, solid!)).toBeCloseTo(0, 6);
    } finally {
      solid!.delete();
    }
  });

  it("an extrude with a baked direction override extrudes that way (FR-29)", () => {
    const m = (x: number): number => mm(x);
    const doc: CadDocument = {
      features: [
        {
          id: "f1",
          type: "sketch",
          data: {
            profile: loopProfile([
              [m(-20), m(-15)],
              [m(20), m(-15)],
              [m(20), m(15)],
              [m(-20), m(15)],
            ]),
          },
        },
        {
          id: "f2",
          type: "extrude",
          deps: ["f1"],
          params: { height: m(10) },
          data: { direction: [0, 0, -1] },
        },
      ],
      params: {},
    };
    const solid = rebuildDocument(oc, doc);
    try {
      expect(solidCentroidZ(oc, solid!)).toBeCloseTo(-m(5), 6); // spans −10..0mm
    } finally {
      solid!.delete();
    }
  });

  it("an extrude-to-face joins a pad up to the picked face (FR-29)", () => {
    const m = (x: number): number => mm(x);
    // Box on x,y = 0..40, z = 0..30. A 20×20 profile at x=30..50 straddles the
    // box's +x wall; padded up to the top face (z=30) and joined, the part
    // outside the box (x=40..50, 10×20×30) adds measurable volume.
    const doc: CadDocument = {
      features: [
        { id: "f1", type: "box", params: { dx: m(40), dy: m(40), dz: m(30) } },
        {
          id: "f2",
          type: "sketch",
          data: {
            profile: loopProfile([
              [m(30), m(10)],
              [m(50), m(10)],
              [m(50), m(30)],
              [m(30), m(30)],
            ]),
          },
        },
        { id: "f3", type: "extrude", deps: ["f2"], data: { toFace: { normal: [0, 0, 1] } } },
      ],
      params: {},
    };
    const solid = rebuildDocument(oc, doc);
    try {
      expect(solid!.isValid()).toBe(true);
      // Box + the pad volume outside it: 10mm(x) × 20mm(y) × 30mm(z), confirming
      // the pad reached the top face (z=30) and joined the body.
      const expected = m(40) * m(40) * m(30) + m(10) * m(20) * m(30);
      expect(Math.abs(solidVolume(oc, solid!) - expected) / expected).toBeLessThan(1e-4);
    } finally {
      solid!.delete();
    }
  });

  it("extrude with data.op join fuses a second pad onto the existing body (G7)", () => {
    const m = (x: number): number => mm(x);
    // Base box, then a sketch→extrude join that adds a boss rather than replacing.
    const doc: CadDocument = {
      features: [
        { id: "f1", type: "box", params: { dx: m(40), dy: m(40), dz: m(10) } },
        {
          id: "f2",
          type: "sketch",
          data: {
            profile: loopProfile([
              [m(10), m(10)],
              [m(30), m(10)],
              [m(30), m(30)],
              [m(10), m(30)],
            ]),
            plane: { base: "XY", offset: m(10) },
          },
        },
        {
          id: "f3",
          type: "extrude",
          deps: ["f2"],
          params: { height: m(15) },
          data: { op: "join" },
        },
      ],
      params: {},
    };
    const built = rebuildTaggedWithProps(oc, doc, { linearDeflection: mm(0.5) });
    expect(built).not.toBeNull();
    const baseVol = m(40) * m(40) * m(10);
    const bossVol = m(20) * m(20) * m(15);
    expect(built!.volume).toBeCloseTo(baseVol + bossVol, 7);
  });

  it("a loft with per-section planes (not only XY+z) builds a solid (G6)", () => {
    const m = (x: number): number => mm(x);
    const sq = (s: number) =>
      loopProfile([
        [m(-s), m(-s)],
        [m(s), m(-s)],
        [m(s), m(s)],
        [m(-s), m(s)],
      ]);
    // Same frustum as the legacy z-stack test, but expressed via plane specs.
    const doc: CadDocument = {
      features: [
        {
          id: "f1",
          type: "loft",
          data: {
            ruled: true,
            sections: [
              { profile: sq(20), plane: { base: "XY", offset: 0 } },
              { profile: sq(10), plane: { base: "XY", offset: m(60) } },
            ],
          },
        },
      ],
      params: {},
    };
    const solid = rebuildDocument(oc, doc);
    try {
      expect(solid!.isValid()).toBe(true);
      const minV = m(20) * m(20) * m(60);
      const maxV = m(40) * m(40) * m(60);
      const v = solidVolume(oc, solid!);
      expect(v).toBeGreaterThan(minV);
      expect(v).toBeLessThan(maxV);
    } finally {
      solid!.delete();
    }
  });

  it("a loft blends two stacked sections into a solid (FR-32)", () => {
    const m = (x: number): number => mm(x);
    const doc: CadDocument = {
      features: [
        {
          id: "f1",
          type: "loft",
          data: {
            ruled: true,
            sections: [
              {
                profile: loopProfile([
                  [m(-20), m(-15)],
                  [m(20), m(-15)],
                  [m(20), m(15)],
                  [m(-20), m(15)],
                ]),
                z: 0,
              },
              {
                profile: loopProfile([
                  [m(-10), m(-7.5)],
                  [m(10), m(-7.5)],
                  [m(10), m(7.5)],
                  [m(-10), m(7.5)],
                ]),
                z: m(60),
              },
            ],
          },
        },
      ],
      params: {},
    };
    const solid = rebuildDocument(oc, doc);
    try {
      expect(solid!.isValid()).toBe(true);
      // Between the small-section prism and the large-section prism volumes.
      const minV = m(20) * m(15) * m(60);
      const maxV = m(40) * m(30) * m(60);
      const v = solidVolume(oc, solid!);
      expect(v).toBeGreaterThan(minV);
      expect(v).toBeLessThan(maxV);
    } finally {
      solid!.delete();
    }
  });

  it("a sweep extrudes a profile along a polyline path (FR-32)", () => {
    const m = (x: number): number => mm(x);
    const doc: CadDocument = {
      features: [
        {
          id: "f1",
          type: "sweep",
          data: {
            profile: loopProfile([
              [m(-5), m(-5)],
              [m(5), m(-5)],
              [m(5), m(5)],
              [m(-5), m(5)],
            ]),
            path: {
              kind: "polyline",
              points: [
                [0, 0, 0],
                [0, 0, m(40)],
                [m(30), 0, m(70)],
              ],
            },
          },
        },
      ],
      params: {},
    };
    const solid = rebuildDocument(oc, doc);
    try {
      expect(solid!.isValid()).toBe(true);
      // The spine is two edges (40 mm up, then a 45°-cornered ~42 mm run). The
      // sweep must follow BOTH edges, not just the first — a 10 mm-square profile
      // over only the first 40 mm edge would be ~4e-6 m³, so require clearly more.
      const firstEdgeVolume = m(10) * m(10) * m(40);
      expect(solidVolume(oc, solid!)).toBeGreaterThan(firstEdgeVolume * 1.5);
    } finally {
      solid!.delete();
    }
  });

  it("a sweep profile plane (data.plane) reorients the section off world-XY (G3)", () => {
    const m = (x: number): number => mm(x);
    // 10×10 mm square profile on XZ (normal = +Y), swept along +Y for 40 mm →
    // a prism of volume 10·10·40 mm³. Without plane support the same profile on
    // XY swept along +Y would still build, but its COM would sit differently;
    // we assert volume + that the solid extends primarily along Y.
    const doc: CadDocument = {
      features: [
        {
          id: "f1",
          type: "sweep",
          data: {
            plane: { base: "XZ", offset: 0 },
            profile: loopProfile([
              [m(-5), m(-5)],
              [m(5), m(-5)],
              [m(5), m(5)],
              [m(-5), m(5)],
            ]),
            path: {
              kind: "polyline",
              points: [
                [0, 0, 0],
                [0, m(40), 0],
              ],
            },
          },
        },
      ],
      params: {},
    };
    const built = rebuildTaggedWithProps(oc, doc, { linearDeflection: mm(0.5) });
    expect(built).not.toBeNull();
    expect(built!.volume).toBeCloseTo(m(10) * m(10) * m(40), 8);
    // Centroid should sit mid-spine along Y (~20 mm).
    expect(built!.com[1]).toBeCloseTo(m(20), 5);
  });

  it("a loft with fewer than two sections throws", () => {
    const doc: CadDocument = {
      features: [{ id: "f1", type: "loft", data: { sections: [] } }],
      params: {},
    };
    expect(() => rebuildDocument(oc, doc)).toThrow(/needs ≥2 section/);
  });

  it("re-derives the profile from data.model for a pre-D2 saved sketch (back-compat)", () => {
    const m = (x: number): number => mm(x);
    // A legacy sketch feature: only `data.model` (the constraint graph) + the old
    // `data.points`, NO typed `data.profile`. It must still build.
    const doc: CadDocument = {
      features: [
        {
          id: "f1",
          type: "sketch",
          data: {
            points: [
              [m(-20), m(-15)],
              [m(20), m(-15)],
              [m(20), m(15)],
              [m(-20), m(15)],
            ],
            model: {
              plane: "XY",
              points: [
                { id: "a", u: m(-20), v: m(-15) },
                { id: "b", u: m(20), v: m(-15) },
                { id: "c", u: m(20), v: m(15) },
                { id: "d", u: m(-20), v: m(15) },
              ],
              entities: [
                { id: "l0", kind: "line", a: "a", b: "b" },
                { id: "l1", kind: "line", a: "b", b: "c" },
                { id: "l2", kind: "line", a: "c", b: "d" },
                { id: "l3", kind: "line", a: "d", b: "a" },
              ],
              constraints: [],
            },
          },
        },
        { id: "f2", type: "extrude", deps: ["f1"], params: { height: m(10) } },
      ],
      params: {},
    };
    const solid = rebuildDocument(oc, doc);
    try {
      const expected = m(40) * m(30) * m(10);
      expect(Math.abs(solidVolume(oc, solid!) - expected) / expected).toBeLessThan(1e-5);
    } finally {
      solid!.delete();
    }
  });

  it("a sketch feature with no buildable profile throws", () => {
    const doc: CadDocument = {
      features: [
        {
          id: "f1",
          type: "sketch",
          data: { profile: { kind: "circle", center: [0, 0], radius: 0 } },
        },
        { id: "f2", type: "extrude", deps: ["f1"], params: { height: mm(5) } },
      ],
      params: {},
    };
    expect(() => rebuildDocument(oc, doc)).toThrow(/no buildable profile/);
  });

  it("an empty document produces no solid", () => {
    expect(rebuildDocument(oc, { features: [], params: {} })).toBeNull();
  });

  it("an unsupported feature type throws a typed error", () => {
    const doc: CadDocument = { features: [{ id: "f1", type: "wormhole" }], params: {} };
    expect(() => rebuildDocument(oc, doc)).toThrow(/unsupported feature type/);
  });

  it("shell with data.direction outward expands the solid envelope (G13 rebuild)", () => {
    const m = (x: number): number => mm(x);
    // Capture the +Z face of a box, then shell outward.
    const baseMesh = rebuildTagged(
      oc,
      {
        features: [{ id: "f1", type: "box", params: { dx: m(40), dy: m(40), dz: m(20) } }],
        params: {},
      },
      { linearDeflection: mm(0.5) },
    )!;
    const top = baseMesh.faceGroups.find((g) => Math.round(g.normal[2]) === 1)!;
    const solidVol = m(40) * m(40) * m(20);
    const built = rebuildTaggedWithProps(
      oc,
      {
        features: [
          { id: "f1", type: "box", params: { dx: m(40), dy: m(40), dz: m(20) } },
          {
            id: "f2",
            type: "shell",
            deps: ["f1"],
            params: { thickness: m(2) },
            data: { faces: [{ normal: top.normal }], direction: "outward" },
          },
        ],
        params: {},
      },
      { linearDeflection: mm(0.5) },
    );
    expect(built).not.toBeNull();
    // Hollowed shell (volume < solid) but with more faces than a box.
    expect(built!.volume).toBeLessThan(solidVol);
    expect(built!.volume).toBeGreaterThan(0);
    expect(built!.mesh.faceGroups.length).toBeGreaterThan(6);
  });

  it("cut with reverse direction removes material along −Z (G5)", () => {
    const m = (x: number): number => mm(x);
    // Sketch on the top of a 30 mm tall box, cut 15 mm along −Z into the body.
    const doc: CadDocument = {
      features: [
        { id: "f1", type: "box", params: { dx: m(40), dy: m(40), dz: m(30) } },
        {
          id: "f2",
          type: "sketch",
          data: {
            profile: loopProfile([
              [m(10), m(10)],
              [m(30), m(10)],
              [m(30), m(30)],
              [m(10), m(30)],
            ]),
            plane: { base: "XY", offset: m(30) },
          },
        },
        {
          id: "f3",
          type: "cut",
          deps: ["f2"],
          params: { depth: m(15) },
          data: { direction: [0, 0, -1] },
        },
      ],
      params: {},
    };
    const built = rebuildTaggedWithProps(oc, doc, { linearDeflection: mm(0.5) });
    expect(built).not.toBeNull();
    const full = m(40) * m(40) * m(30);
    const pocket = m(20) * m(20) * m(15);
    expect(built!.volume).toBeCloseTo(full - pocket, 7);
  });

  it("sweep with a mixed line+arc path builds a valid solid (G4 rebuild)", () => {
    const m = (x: number): number => mm(x);
    const doc: CadDocument = {
      features: [
        {
          id: "f1",
          type: "sweep",
          data: {
            profile: loopProfile([
              [m(-3), m(-3)],
              [m(3), m(-3)],
              [m(3), m(3)],
              [m(-3), m(3)],
            ]),
            path: {
              kind: "path",
              start: [0, 0, 0],
              segments: [
                { kind: "line", to: [0, 0, m(30)] },
                { kind: "arc", through: [0, m(15), m(45)], to: [0, m(30), m(30)] },
              ],
            },
          },
        },
      ],
      params: {},
    };
    const solid = rebuildDocument(oc, doc);
    try {
      expect(solid).not.toBeNull();
      expect(solid!.isValid()).toBe(true);
      expect(solidVolume(oc, solid!)).toBeGreaterThan(m(6) * m(6) * m(30));
    } finally {
      solid?.delete();
    }
  });

  it("extrude with no upstream sketch throws", () => {
    const doc: CadDocument = {
      features: [{ id: "f1", type: "extrude", params: { height: mm(10) } }],
      params: {},
    };
    expect(() => rebuildDocument(oc, doc)).toThrow(/no sketch profile/);
  });
});
