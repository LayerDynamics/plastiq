import { beforeAll, describe, expect, it } from "vitest";
import {
  exportStep,
  exportIges,
  importStep,
  initOcct,
  makeBox,
  mm,
  surfacesMatch,
  type Occt,
  type Solid,
} from "@plastiq/cad";
import type { CadDocument, EditorFeature } from "../store/types.js";
import type { Profile } from "../sketch/profile.js";
import type { TopAbs_ShapeEnum } from "opencascade.js";
import {
  rebuildDocument,
  rebuildDocumentIsolated,
  rebuildTagged,
  rebuildTaggedWithProps,
} from "./rebuild.js";

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

/** How many separate BODIES a solid holds — 1 for a plain solid, N for a
 * multi-body compound (§2.4 `op:"new"`). */
function bodyCount(oc: Occt, solid: Solid): number {
  // The kernel's own cast: embind types the enum object loosely (mesh/normals.ts
  // shapeEnums does the same), so name the members through it.
  const S = oc.TopAbs_ShapeEnum as unknown as {
    TopAbs_SOLID: TopAbs_ShapeEnum;
    TopAbs_SHAPE: TopAbs_ShapeEnum;
  };
  const exp = new oc.TopExp_Explorer_2(solid.shape, S.TopAbs_SOLID, S.TopAbs_SHAPE);
  let n = 0;
  while (exp.More()) {
    n++;
    exp.Next();
  }
  exp.delete();
  return n;
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
    const built = rebuildTaggedWithProps(
      oc,
      { features: [], params: {} },
      { linearDeflection: mm(0.5) },
    );
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

  it("§2.7: a plate with a RECTANGULAR hole extrudes to a solid with the hole", () => {
    const m = (x: number): number => mm(x);
    // 40×30 mm plate, 20×10 mm rectangular hole centred in it, extruded 20 mm.
    // The old extractor returned null for two disjoint loops → "no buildable
    // profile", so drawing a hole broke the WHOLE sketch. Now the inner loop is a
    // hole and the pad is a plate-with-a-slot.
    const doc: CadDocument = {
      features: [
        {
          id: "f1",
          type: "sketch",
          data: {
            profile: {
              kind: "loop",
              start: [0, 0],
              segments: [
                { kind: "line", to: [m(40), 0] },
                { kind: "line", to: [m(40), m(30)] },
                { kind: "line", to: [0, m(30)] },
                { kind: "line", to: [0, 0] },
              ],
              holes: [
                {
                  kind: "loop",
                  start: [m(10), m(10)],
                  segments: [
                    { kind: "line", to: [m(30), m(10)] },
                    { kind: "line", to: [m(30), m(20)] },
                    { kind: "line", to: [m(10), m(20)] },
                    { kind: "line", to: [m(10), m(10)] },
                  ],
                },
              ],
            },
          },
        },
        { id: "f2", type: "extrude", deps: ["f1"], params: { height: m(20) }, data: { op: "new" } },
      ],
      params: {},
    };
    const solid = rebuildDocument(oc, doc);
    expect(solid).not.toBeNull();
    // Volume = (outer 40×30 − hole 20×10) × 20 mm.
    const expected = (m(40) * m(30) - m(20) * m(10)) * m(20);
    expect(solidVolume(oc, solid!)).toBeCloseTo(expected, 12);
    // A through-slot adds an inner wall: the prism has more than a plain box's 6 faces.
    const mesh = rebuildTagged(oc, doc, { linearDeflection: mm(0.5) })!;
    expect(mesh.faceGroups.length).toBeGreaterThan(6);
    solid!.delete();
  });

  describe("§2.10.3: a consumer never silently rebinds to a DIFFERENT sketch", () => {
    const m = (x: number): number => mm(x);
    const small = (): EditorFeature => ({
      id: "sA",
      type: "sketch",
      data: {
        profile: loopProfile([
          [0, 0],
          [m(20), 0],
          [m(20), m(20)],
          [0, m(20)],
        ]),
      },
    });
    const large = (): EditorFeature => ({
      id: "sB",
      type: "sketch",
      data: {
        profile: loopProfile([
          [0, 0],
          [m(40), 0],
          [m(40), m(40)],
          [0, m(40)],
        ]),
      },
    });
    const VOL_A = m(20) * m(20) * m(10);
    const VOL_B = m(40) * m(40) * m(10);

    it("builds from the DEPS-named sketch when it is present", () => {
      const doc: CadDocument = {
        features: [
          small(),
          large(),
          {
            id: "e1",
            type: "extrude",
            deps: ["sA"],
            params: { height: m(10) },
            data: { op: "new" },
          },
        ],
        params: {},
      };
      const solid = rebuildDocument(oc, doc)!;
      expect(solidVolume(oc, solid)).toBeCloseTo(VOL_A, 12); // A, not B
      solid.delete();
    });

    it("FAILS (not rebinds to B) when the DEPS-named sketch is DELETED", () => {
      // Old behaviour rebuilt from B's profile — wrong geometry, zero error.
      const doc: CadDocument = {
        features: [
          large(), // only B remains; the extrude still names sA
          {
            id: "e1",
            type: "extrude",
            deps: ["sA"],
            params: { height: m(10) },
            data: { op: "new" },
          },
        ],
        params: {},
      };
      expect(() => rebuildDocument(oc, doc)).toThrow(/no sketch profile upstream/);
    });

    it("FAILS when the DEPS-named sketch is SUPPRESSED (still a feature, not active)", () => {
      const doc: CadDocument = {
        features: [
          { ...small(), suppressed: true },
          large(),
          {
            id: "e1",
            type: "extrude",
            deps: ["sA"],
            params: { height: m(10) },
            data: { op: "new" },
          },
        ],
        params: {},
      };
      expect(() => rebuildDocument(oc, doc)).toThrow(/no sketch profile upstream/);
    });

    it("FAILS when an explicit data.sketchId points at a missing sketch", () => {
      const doc: CadDocument = {
        features: [
          large(),
          {
            id: "e1",
            type: "extrude",
            data: { sketchId: "sA", op: "new" },
            params: { height: m(10) },
          },
        ],
        params: {},
      };
      expect(() => rebuildDocument(oc, doc)).toThrow(/no sketch profile upstream/);
    });

    it("STILL falls back to the last sketch for a feature that names NO sketch (ribbon path)", () => {
      // The legitimate last-wins fallback must survive: a ribbon extrude carries no
      // deps and no sketchId, so it uses the most recent sketch (B here).
      const doc: CadDocument = {
        features: [
          large(),
          { id: "e1", type: "extrude", params: { height: m(10) }, data: { op: "new" } },
        ],
        params: {},
      };
      const solid = rebuildDocument(oc, doc)!;
      expect(solidVolume(oc, solid)).toBeCloseTo(VOL_B, 12); // last sketch = B
      solid.delete();
    });
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
    // (which would put the pad inside the box, leaving the top at 30 mm).
    //
    // Measured via the built solid's TOP (max Z) rather than its centroid: since
    // §2.4 `op:"new"` correctly KEEPS the box as a separate body, a centroid now
    // averages both bodies. The top is a sharper probe of the same thing anyway
    // — it moves exactly with the sketch plane.
    const topZ = (faceOffset: number): number => {
      const doc: CadDocument = {
        features: [
          { id: "f1", type: "box", params: { dx: m(60), dy: m(40), dz: m(30) } },
          {
            id: "f2",
            type: "sketch",
            deps: ["f1"],
            data: {
              profile: rect,
              plane: { kind: "face", face: { normal: [0, 0, 1] }, offset: faceOffset },
            },
          },
          // op:"new" keeps the pad a SEPARATE body (§2.4) so join-by-default can't
          // merge it into the box and blur where the sketch plane actually landed.
          {
            id: "f3",
            type: "extrude",
            deps: ["f2"],
            params: { height: m(20) },
            data: { op: "new" },
          },
        ],
        params: {},
      };
      const solid = rebuildDocument(oc, doc)!;
      try {
        return solid.boundingBox().max[2];
      } finally {
        solid.delete();
      }
    };
    // Built on the 30 mm top face, a 20 mm pad reaches 50 mm. Built on the XY
    // plane it would sit INSIDE the box and the top would still read 30 mm.
    const onFace = topZ(0);
    expect(onFace).toBeCloseTo(m(50), 6);
    // A 10 mm face offset lifts the pad a further 10 mm along the face normal.
    expect(topZ(m(10)) - onFace).toBeCloseTo(m(10), 6);
  });

  it("a zero-offset on-face join uses the native local prism result", () => {
    const r = mm(5);
    const h = mm(10);
    const baseVolume = mm(40) * mm(40) * mm(20);
    const doc: CadDocument = {
      features: [
        { id: "base", type: "box", params: { dx: mm(40), dy: mm(40), dz: mm(20) } },
        {
          id: "profile",
          type: "sketch",
          data: {
            profile: { kind: "circle", center: [mm(20), mm(20)], radius: r },
            plane: { kind: "face", face: { normal: [0, 0, 1] }, offset: 0 },
          },
        },
        {
          id: "boss",
          type: "extrude",
          deps: ["profile"],
          params: { height: h },
          data: { op: "join" },
        },
      ],
      params: {},
    };
    const solid = rebuildDocument(oc, doc)!;
    try {
      expect(solid.isValid()).toBe(true);
      expect(solidVolume(oc, solid)).toBeCloseTo(baseVolume + Math.PI * r * r * h, 10);
    } finally {
      solid.delete();
    }
  });

  it("a rib feature rebuilds a native LocOpe linear form from its bound sketch", () => {
    const r = mm(4);
    const length = mm(12);
    const doc: CadDocument = {
      features: [
        {
          id: "profile",
          type: "sketch",
          data: { profile: { kind: "circle", center: [0, 0], radius: r } },
        },
        {
          id: "rib",
          type: "rib",
          deps: ["profile"],
          params: { length },
          data: { sketchId: "profile", op: "new" },
        },
      ],
      params: {},
    };
    const solid = rebuildDocument(oc, doc)!;
    try {
      expect(solidVolume(oc, solid)).toBeCloseTo(Math.PI * r * r * length, 10);
    } finally {
      solid.delete();
    }
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

  it("revolve without data.op joins by default when a solid already exists (C2)", () => {
    const m = (x: number): number => mm(x);
    // Box + a rectangular profile offset on XY, full revolve about Y through origin.
    // Join keeps the box; volume > revolve-only volume.
    const revolveOnly: CadDocument = {
      features: [
        {
          id: "f1",
          type: "sketch",
          data: {
            profile: loopProfile([
              [m(15), m(0)],
              [m(25), m(0)],
              [m(25), m(10)],
              [m(15), m(10)],
            ]),
          },
        },
        { id: "f2", type: "revolve", deps: ["f1"], params: { angle: Math.PI * 2, ay: 1 } },
      ],
      params: {},
    };
    const joined: CadDocument = {
      features: [
        { id: "f0", type: "box", params: { dx: m(10), dy: m(10), dz: m(10) } },
        {
          id: "f1",
          type: "sketch",
          data: {
            profile: loopProfile([
              [m(15), m(0)],
              [m(25), m(0)],
              [m(25), m(10)],
              [m(15), m(10)],
            ]),
          },
        },
        { id: "f2", type: "revolve", deps: ["f1"], params: { angle: Math.PI * 2, ay: 1 } },
      ],
      params: {},
    };
    const vOnly = rebuildTaggedWithProps(oc, revolveOnly, { linearDeflection: mm(0.5) })!.volume;
    const vJoined = rebuildTaggedWithProps(oc, joined, { linearDeflection: mm(0.5) })!.volume;
    const boxVol = m(10) * m(10) * m(10);
    expect(vJoined).toBeGreaterThan(vOnly);
    expect(vJoined).toBeGreaterThanOrEqual(vOnly + boxVol * 0.99);
  });

  it("revolve with data.axisEdge uses the picked edge as the axis (C2)", () => {
    const m = (x: number): number => mm(x);
    // Box 40×40×20. Sketch a 5×10 rect at x∈[5,10] on the top face plane z=20, revolve
    // about a top +Y-running edge (faceNormals top+side) — different from world Y at origin.
    // With op:new, the solid is only the revolve (axis on the edge).
    const doc: CadDocument = {
      features: [
        { id: "f1", type: "box", params: { dx: m(40), dy: m(40), dz: m(20) } },
        {
          id: "f2",
          type: "sketch",
          data: {
            profile: loopProfile([
              [m(5), m(10)],
              [m(10), m(10)],
              [m(10), m(20)],
              [m(5), m(20)],
            ]),
            plane: { base: "XY", offset: m(20) },
          },
        },
        {
          id: "f3",
          type: "revolve",
          deps: ["f2"],
          params: { angle: Math.PI * 2 },
          data: {
            op: "new",
            // +Z top and +X side → edge along +Y at x=40, z=20 (typical box edge).
            axisEdge: {
              faceNormals: [
                [0, 0, 1],
                [1, 0, 0],
              ] as [[number, number, number], [number, number, number]],
            },
          },
        },
      ],
      params: {},
    };
    const solid = rebuildDocument(oc, doc);
    try {
      expect(solid!.isValid()).toBe(true);
      expect(solidVolume(oc, solid!)).toBeGreaterThan(0);
    } finally {
      solid!.delete();
    }
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

  it("§13.1 fillet history rewrites the right face when two bodies share one plane", () => {
    const probe: CadDocument = {
      features: [
        { id: "a", type: "box", params: { dx: mm(40), dy: mm(30), dz: mm(20) } },
        {
          id: "b",
          type: "box",
          params: { dx: mm(40), dy: mm(30), dz: mm(20), ox: mm(60), oy: 0, oz: 0 },
          data: { op: "new" },
        },
      ],
      params: {},
    };
    const tagged = rebuildTagged(oc, probe, { linearDeflection: mm(0.5) })!;
    const topFaces = tagged.faceGroups.filter((face) => Math.round(face.normal[2]) === 1);
    expect(topFaces).toHaveLength(2);
    expect(surfacesMatch(topFaces[0]!.surface!, topFaces[1]!.surface!)).toBe(true);
    const topA = topFaces.find((face) => face.centroid[0] < mm(40))!;
    const edgeA = tagged.edges.find(
      (edge) =>
        edge.midpoint[0] < mm(40) && edge.faceNormals.some((normal) => Math.round(normal[2]) === 1),
    )!;
    const downstreamFace = {
      normal: topA.normal,
      centroid: topA.centroid,
      surface: topA.surface,
    };
    const before = [...topA.centroid];
    const doc: CadDocument = {
      features: [
        ...probe.features,
        {
          id: "fillet",
          type: "fillet",
          params: { radius: mm(3) },
          data: {
            edges: [
              {
                faceNormals: edgeA.faceNormals,
                midpoint: edgeA.midpoint,
                faceSurfaces: edgeA.faceSurfaces,
              },
            ],
          },
        },
        {
          id: "later-shell",
          type: "shell",
          suppressed: true,
          params: { thickness: mm(2) },
          data: { faces: [downstreamFace] },
        },
      ],
      params: {},
    };

    const built = rebuildDocument(oc, doc)!;
    built.delete();
    const rewritten = (doc.features[3]!.data!.faces as (typeof downstreamFace)[])[0]!;
    expect(rewritten.centroid).not.toEqual(before); // successor, not stale pre-fillet centroid
    expect(rewritten.centroid![0]).toBeLessThan(mm(40)); // stayed on body A, not coplanar body B
    expect(rewritten.surface).toEqual(topA.surface);
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

  it("linearPattern with toolFeatures unions N tool copies onto the base (T21)", () => {
    const m = (x: number): number => mm(x);
    // Base box; pattern a small boss (sketch+extrude tool) 3 times along X.
    const doc: CadDocument = {
      features: [
        { id: "f1", type: "box", params: { dx: m(40), dy: m(40), dz: m(10) } },
        {
          id: "f2",
          type: "linearPattern",
          params: { dx: 1, spacing: m(15), count: 3 },
          data: {
            toolFeatures: [
              {
                id: "t0",
                type: "sketch",
                data: {
                  profile: loopProfile([
                    [m(0), m(15)],
                    [m(8), m(15)],
                    [m(8), m(23)],
                    [m(0), m(23)],
                  ]),
                  plane: { base: "XY", offset: m(10) },
                },
              },
              {
                id: "t1",
                type: "extrude",
                deps: ["t0"],
                params: { height: m(5) },
                data: { op: "new" },
              },
            ],
          },
        },
      ],
      params: {},
    };
    const built = rebuildTaggedWithProps(oc, doc, { linearDeflection: mm(0.5) });
    expect(built).not.toBeNull();
    const baseVol = m(40) * m(40) * m(10);
    const bossVol = m(8) * m(8) * m(5);
    // Base + 3 bosses (non-overlapping along X).
    expect(built!.volume).toBeCloseTo(baseVol + 3 * bossVol, 6);
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

  it("transform rotates about COM then translates (C7) — not world origin then translate", () => {
    // Box [0..20]³ mm → COM at 10mm. 180° about Z through COM swaps the box onto itself
    // then +50mm X → min x ≈ 50mm. If rotation were about world origin first, the
    // box would flip to negative X before translate and min x would differ.
    const s = mm(20);
    const doc: CadDocument = {
      features: [
        { id: "f1", type: "box", params: { dx: s, dy: s, dz: s } },
        {
          id: "f2",
          type: "transform",
          deps: ["f1"],
          params: { angle: Math.PI, az: 1, tx: mm(50) },
        },
      ],
      params: {},
    };
    const mesh = rebuildTagged(oc, doc, { linearDeflection: mm(0.5) })!;
    const xs = mesh.vertices.filter((_, i) => i % 3 === 0);
    expect(Math.min(...xs)).toBeGreaterThan(mm(45));
    expect(Math.max(...xs)).toBeLessThan(mm(75));
  });

  it("circularPattern with toolFeatures unions N tool copies onto the base (C6 parity)", () => {
    const m = (x: number): number => mm(x);
    // Base plate; circular-pattern a small boss about Z through the plate centre.
    const doc: CadDocument = {
      features: [
        { id: "f1", type: "box", params: { dx: m(40), dy: m(40), dz: m(10) } },
        {
          id: "f2",
          type: "circularPattern",
          params: {
            count: 4,
            angle: Math.PI * 2,
            ox: m(20),
            oy: m(20),
            oz: 0,
            az: 1,
          },
          data: {
            toolFeatures: [
              {
                id: "t0",
                type: "sketch",
                data: {
                  profile: loopProfile([
                    [m(28), m(18)],
                    [m(34), m(18)],
                    [m(34), m(24)],
                    [m(28), m(24)],
                  ]),
                  plane: { base: "XY", offset: m(10) },
                },
              },
              {
                id: "t1",
                type: "extrude",
                deps: ["t0"],
                params: { height: m(4) },
                data: { op: "new" },
              },
            ],
          },
        },
      ],
      params: {},
    };
    const built = rebuildTaggedWithProps(oc, doc, { linearDeflection: mm(0.5) });
    expect(built).not.toBeNull();
    const baseVol = m(40) * m(40) * m(10);
    const bossVol = m(6) * m(6) * m(4);
    // Base + 4 non-overlapping bosses.
    expect(built!.volume).toBeCloseTo(baseVol + 4 * bossVol, 5);
  });

  it("sweep joins onto an existing body by default (C4)", () => {
    const m = (x: number): number => mm(x);
    const boxVol = m(40) * m(40) * m(10);
    const doc: CadDocument = {
      features: [
        { id: "f0", type: "box", params: { dx: m(40), dy: m(40), dz: m(10) } },
        {
          id: "f1",
          type: "sweep",
          data: {
            profile: { kind: "circle", center: [m(5), m(5)], radius: m(3) },
            plane: { base: "XY", offset: m(10) },
            path: {
              kind: "polyline",
              points: [
                [0, 0, 0],
                [0, 0, m(20)],
              ],
            },
          },
        },
      ],
      params: {},
    };
    const built = rebuildTaggedWithProps(oc, doc, { linearDeflection: mm(0.5) });
    expect(built).not.toBeNull();
    expect(built!.volume).toBeGreaterThan(boxVol * 1.01);
  });

  it("variable-radius fillet (radius2) builds without error (C8)", () => {
    const m = (x: number): number => mm(x);
    const doc: CadDocument = {
      features: [
        { id: "f1", type: "box", params: { dx: m(30), dy: m(20), dz: m(15) } },
        {
          id: "f2",
          type: "fillet",
          params: { radius: m(1), radius2: m(3) },
          data: {
            selector: { kind: "convexEdges" },
          },
        },
      ],
      params: {},
    };
    // Kernel accepts variable fillet; volume should drop vs sharp box.
    const sharp = rebuildTaggedWithProps(
      oc,
      { features: [doc.features[0]!], params: {} },
      { linearDeflection: mm(0.5) },
    )!;
    const filleted = rebuildTaggedWithProps(oc, doc, { linearDeflection: mm(0.5) });
    expect(filleted).not.toBeNull();
    expect(filleted!.volume).toBeLessThan(sharp.volume);
  });

  it("loft joins onto an existing body by default (C4)", () => {
    const m = (x: number): number => mm(x);
    const boxVol = m(40) * m(40) * m(10);
    const doc: CadDocument = {
      features: [
        { id: "f0", type: "box", params: { dx: m(40), dy: m(40), dz: m(10) } },
        {
          id: "f1",
          type: "loft",
          data: {
            sections: [
              {
                profile: loopProfile([
                  [m(5), m(5)],
                  [m(15), m(5)],
                  [m(15), m(15)],
                  [m(5), m(15)],
                ]),
                plane: { base: "XY", offset: m(10) },
              },
              {
                profile: loopProfile([
                  [m(6), m(6)],
                  [m(14), m(6)],
                  [m(14), m(14)],
                  [m(6), m(14)],
                ]),
                plane: { base: "XY", offset: m(25) },
              },
            ],
          },
        },
      ],
      params: {},
    };
    const built = rebuildTaggedWithProps(oc, doc, { linearDeflection: mm(0.5) });
    expect(built).not.toBeNull();
    // Join: volume strictly larger than the base box alone (loft adds material).
    expect(built!.volume).toBeGreaterThan(boxVol * 1.01);
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

  it("an importIges feature rebuilds an imported IGES solid", () => {
    const box = makeBox(oc, mm(25), mm(20), mm(15));
    const iges = exportIges(oc, box);
    box.delete();
    const built = rebuildDocument(oc, {
      features: [{ id: "f1", type: "importIges", name: "part.igs", data: { iges } }],
      params: {},
    });
    expect(built).not.toBeNull();
    expect(solidVolume(oc, built!)).toBeCloseTo(mm(25) * mm(20) * mm(15), 12);
    built!.delete();
  });

  it("importIges with no IGES text throws", () => {
    const doc: CadDocument = { features: [{ id: "f1", type: "importIges", data: {} }], params: {} };
    expect(() => rebuildDocument(oc, doc)).toThrow(/missing IGES text/);
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

  it("extrude without data.op joins by default when a solid already exists (C1)", () => {
    const m = (x: number): number => mm(x);
    // Same geometry as the explicit-join test, but op is unset — product default
    // must fuse the boss onto the box, not replace the body with the pad alone.
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
        },
      ],
      params: {},
    };
    const built = rebuildTaggedWithProps(oc, doc, { linearDeflection: mm(0.5) });
    expect(built).not.toBeNull();
    const baseVol = m(40) * m(40) * m(10);
    const bossVol = m(20) * m(20) * m(15);
    expect(built!.volume).toBeCloseTo(baseVol + bossVol, 7);
    expect(built!.volume).toBeGreaterThan(baseVol);
  });

  it("§2.4: extrude with data.op new KEEPS the prior body and adds a separate one", () => {
    const m = (x: number): number => mm(x);
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
          data: { op: "new" },
        },
      ],
      params: {},
    };
    const built = rebuildTaggedWithProps(oc, doc, { linearDeflection: mm(0.5) });
    expect(built).not.toBeNull();
    const bossVol = m(20) * m(20) * m(15);
    const boxVol = m(40) * m(40) * m(10);
    // "New body" used to DELETE the part (§2.4). Both bodies survive: the volume
    // is the sum, and nothing was welded — the boss did not fuse into the box.
    expect(built!.volume).toBeCloseTo(boxVol + bossVol, 7);
    const solid = rebuildDocument(oc, doc)!;
    expect(bodyCount(oc, solid), "box + boss as two separate bodies").toBe(2);
    solid.delete();
  });

  describe('§2.4 multi-body documents: "new body" no longer destroys the part', () => {
    const m = (x: number): number => mm(x);

    /** Box, then a second box as a NEW body offset clear of the first. */
    const twoBoxes = (): CadDocument => ({
      features: [
        { id: "f1", type: "box", params: { dx: m(40), dy: m(40), dz: m(10) } },
        {
          id: "f2",
          type: "cylinder",
          params: { radius: m(5), height: m(20), ox: m(100), oy: 0, oz: 0 },
          data: { op: "new" },
        },
      ],
      params: {},
    });

    it("a primitive with op:new is added as a separate body, not a replacement", () => {
      const solid = rebuildDocument(oc, twoBoxes())!;
      try {
        expect(bodyCount(oc, solid)).toBe(2);
        const boxVol = m(40) * m(40) * m(10);
        const cylVol = Math.PI * m(5) ** 2 * m(20);
        expect(solidVolume(oc, solid)).toBeCloseTo(boxVol + cylVol, 9);
        // Separate bodies, not a weld: a fuse of disjoint solids would give the
        // same volume, so also assert they stayed individually addressable.
        expect(solid.isValid()).toBe(true);
      } finally {
        solid.delete();
      }
    });

    it("both bodies reach the viewport tessellation (nothing is silently dropped)", () => {
      const mesh = rebuildTagged(oc, twoBoxes(), { linearDeflection: mm(0.5) })!;
      // 6 box faces + the cylinder's (wall + 2 caps) — every face of BOTH bodies.
      expect(mesh.faceGroups.length).toBeGreaterThanOrEqual(9);
      // The far body's geometry is really in the buffer: some vertex is out at x≈100 mm.
      let maxX = -Infinity;
      for (let i = 0; i < mesh.vertices.length; i += 3) maxX = Math.max(maxX, mesh.vertices[i]!);
      expect(maxX).toBeGreaterThan(m(90));
    });

    it("both bodies survive a STEP export", () => {
      const solid = rebuildDocument(oc, twoBoxes())!;
      try {
        const step = exportStep(oc, solid);
        expect(step).toContain("ISO-10303");
        // Re-import and confirm the file carries BOTH bodies at full volume.
        const back = importStep(oc, step);
        try {
          expect(bodyCount(oc, back)).toBe(2);
          expect(solidVolume(oc, back)).toBeCloseTo(solidVolume(oc, solid), 9);
        } finally {
          back.delete();
        }
      } finally {
        solid.delete();
      }
    });

    it("OVERLAPPING bodies: a new body INSIDE another stays separate and stays usable", () => {
      // The common real case (and §13.8's P0 shape): the new body sits inside the
      // existing one rather than clear of it. A compound does not boolean, so the
      // two overlap rather than merge — volume DOUBLE-COUNTS the shared region,
      // which is the correct arithmetic for separate bodies and is asserted here
      // so the behaviour is pinned rather than discovered later.
      const doc: CadDocument = {
        features: [
          { id: "f1", type: "box", params: { dx: m(40), dy: m(40), dz: m(40) } },
          {
            id: "f2",
            type: "cylinder",
            // Fully inside the box: radius 5 at the box centre, height 20.
            params: { radius: m(5), height: m(20), ox: m(20), oy: m(20), oz: m(10) },
            data: { op: "new" },
          },
        ],
        params: {},
      };
      const solid = rebuildDocument(oc, doc)!;
      try {
        expect(bodyCount(oc, solid), "overlapping bodies stay separate").toBe(2);
        const boxVol = m(40) ** 3;
        const cylVol = Math.PI * m(5) ** 2 * m(20);
        expect(solidVolume(oc, solid)).toBeCloseTo(boxVol + cylVol, 9);
        expect(solid.isValid()).toBe(true);
        // The interior body's faces still tessellate (they are inside the box, so
        // this is also the case that would silently drop if faces were culled).
        const mesh = rebuildTagged(oc, doc, { linearDeflection: mm(0.5) })!;
        expect(mesh.faceGroups.length).toBeGreaterThanOrEqual(9);
      } finally {
        solid.delete();
      }

      // …and a later boolean over the self-overlapping compound still runs.
      const cutDoc: CadDocument = {
        features: [
          ...doc.features,
          {
            id: "f3",
            type: "cylinder",
            params: { radius: m(2), height: m(60), ox: m(20), oy: m(20), oz: m(-10) },
            data: { op: "cut" },
          },
        ],
        params: {},
      };
      const built = rebuildDocumentIsolated(oc, cutDoc);
      const failed = built.statuses.filter((st) => st.status === "error");
      expect(failed, JSON.stringify(failed)).toHaveLength(0);
      expect(built.solid).not.toBeNull();
      try {
        // The bore removed material from BOTH overlapping bodies it passed through.
        const boxVol = m(40) ** 3;
        const cylVol = Math.PI * m(5) ** 2 * m(20);
        expect(solidVolume(oc, built.solid!)).toBeLessThan(boxVol + cylVol);
      } finally {
        built.solid!.delete();
      }
    });

    it("MIGRATION: a doc saved under the old replace-semantics still resolves its downstream fillet", () => {
      // The real migration question, MEASURED rather than reasoned about.
      //
      // Under the old semantics `op:"new"` DISCARDED the box, so a fillet after it
      // was authored against the PAD ALONE and its EdgeRef was captured from that
      // geometry. Under multi-body the same saved document rebuilds as
      // compound(box, pad), so the fillet now resolves against BOTH bodies' edges.
      // Does the stored ref still find the pad's edge?
      const padOnly: CadDocument = {
        features: [
          {
            id: "s1",
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
          { id: "e1", type: "extrude", deps: ["s1"], params: { height: m(15) } },
        ],
        params: {},
      };
      // The ref exactly as the app captures one: Viewport publishes selection refs
      // as { faceNormals, midpoint } (three/Viewport.tsx), and the AI path does the
      // same (ai/tools/inspectGeometry.ts) — so a stored ref carries a midpoint.
      const padMesh = rebuildTagged(oc, padOnly, { linearDeflection: mm(0.5) })!;
      const padEdge = padMesh.edges[0]!;
      const storedRef = { faceNormals: padEdge.faceNormals, midpoint: padEdge.midpoint };

      // The saved document, now rebuilt under multi-body semantics.
      const migrated: CadDocument = {
        features: [
          { id: "f1", type: "box", params: { dx: m(40), dy: m(40), dz: m(10) } },
          ...padOnly.features.map((f) =>
            f.id === "e1" ? { ...f, data: { ...f.data, op: "new" } } : f,
          ),
          { id: "f3", type: "fillet", params: { radius: m(1) }, data: { edges: [storedRef] } },
        ],
        params: {},
      };
      const built = rebuildDocumentIsolated(oc, migrated);
      const failed = built.statuses.filter((st) => st.status === "error");
      // MEASURED: the midpoint disambiguates, so the stored ref still finds ITS
      // edge even though the compound now offers the box's edges as candidates.
      expect(failed, JSON.stringify(failed)).toHaveLength(0);
      expect(built.solid).not.toBeNull();
      try {
        expect(bodyCount(oc, built.solid!)).toBe(2);
        // The fillet ran on the pad: total is below the un-filleted sum, and the
        // box's own volume is untouched.
        const boxVol = m(40) * m(40) * m(10);
        const padVol = m(20) * m(20) * m(15);
        const total = solidVolume(oc, built.solid!);
        expect(total).toBeLessThan(boxVol + padVol);
        expect(total).toBeGreaterThan(boxVol + padVol * 0.9);
      } finally {
        built.solid!.delete();
      }
    });

    it("MIGRATION: a midpoint-LESS ref is the residual risk — measured, not assumed", () => {
      // The EdgeRef schema makes `midpoint` optional (ai/tools/schema.ts), and
      // resolveEdgeRef falls back to pure normal-agreement scoring without it
      // (mesh/resolve.ts). A second body contributes edges with IDENTICAL adjacent
      // normals (both are axis-aligned boxes), so the match is genuinely ambiguous
      // and "first best score wins" decides it. This measures what actually
      // happens rather than asserting a guess either way.
      // Deliberately ADVERSARIAL: a second BOX, axis-aligned exactly like the
      // first, so it offers edges whose adjacent-face normals are IDENTICAL to the
      // target's. A curved second body would dodge the ambiguity entirely.
      const twoBoxDoc: CadDocument = {
        features: [
          { id: "f1", type: "box", params: { dx: m(40), dy: m(40), dz: m(10) } },
          {
            id: "f2",
            type: "box",
            params: { dx: m(40), dy: m(40), dz: m(10), ox: m(100), oy: 0, oz: 0 },
            data: { op: "new" },
          },
        ],
        params: {},
      };
      const single = rebuildTagged(
        oc,
        { features: [twoBoxDoc.features[0]!], params: {} },
        { linearDeflection: mm(0.5) },
      )!;
      // A ref with NO midpoint, captured against the box alone.
      const bare = { faceNormals: single.edges[0]!.faceNormals };

      const built = rebuildDocumentIsolated(oc, {
        features: [
          ...twoBoxDoc.features,
          { id: "f3", type: "fillet", params: { radius: m(1) }, data: { edges: [bare] } },
        ],
        params: {},
      });
      const failed = built.statuses.filter((st) => st.status === "error");
      expect(failed, JSON.stringify(failed)).toHaveLength(0);
      expect(built.solid).not.toBeNull();
      try {
        expect(bodyCount(oc, built.solid!)).toBe(2);
        // MEASURED OUTCOME: the fillet resolves and rounds exactly ONE edge — it
        // does not error and does not round both bodies. Which of the two
        // identically-oriented edges wins is decided by explorer order, so a
        // midpoint-less ref is genuinely ambiguous across a multi-body document:
        // the material removed is one edge's worth, but WHICH body loses it is
        // not pinned by the ref. Real picks always carry a midpoint (Viewport /
        // inspectGeometry), which is what makes them safe.
        const twoBoxVol = 2 * m(40) * m(40) * m(10);
        const removed = twoBoxVol - solidVolume(oc, built.solid!);
        expect(removed).toBeGreaterThan(0);
        // A 1 mm fillet along ONE edge removes ~(1 - π/4)·r²·L. Length comes from
        // the picked edge's own polyline, so the assertion holds whichever edge
        // the tessellation happens to list first.
        const pts = single.edges[0]!.positions;
        let len = 0;
        for (let i = 3; i < pts.length; i += 3) {
          len += Math.hypot(
            pts[i]! - pts[i - 3]!,
            pts[i + 1]! - pts[i - 2]!,
            pts[i + 2]! - pts[i - 1]!,
          );
        }
        expect(removed).toBeCloseTo((1 - Math.PI / 4) * m(1) ** 2 * len, 9);
      } finally {
        built.solid!.delete();
      }
    });

    it("§13.8 P0: a pad that lands INSIDE the starter box is reported, not silent", () => {
      // The exact first-run scenario: the seeded 60x40x30 box, a rectangle
      // sketched on XY (z=0), extruded UP 10mm. The pad is entirely inside the
      // box, so join-by-default adds nothing and the viewport is unchanged.
      const doc: CadDocument = {
        features: [
          { id: "f1", type: "box", name: "Box 1", params: { dx: m(60), dy: m(40), dz: m(30) } },
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
              plane: { base: "XY" },
            },
          },
          { id: "f3", type: "extrude", deps: ["f2"], params: { height: m(10) } },
        ],
        params: {},
      };
      const built = rebuildDocumentIsolated(oc, doc);
      try {
        // The geometry really is unchanged — that part is correct behaviour.
        expect(solidVolume(oc, built.solid!)).toBeCloseTo(m(60) * m(40) * m(30), 9);
        // …but the extrude no longer reports a clean "ok".
        const f3 = built.statuses.find((st) => st.featureId === "f3")!;
        expect(f3.status).toBe("warning");
        expect(f3.message).toMatch(/added no material/);
        expect(f3.message).toMatch(/"new"/); // tells the user the remedy
        // Nothing errored: the timeline continues normally.
        expect(built.statuses.filter((st) => st.status === "error")).toHaveLength(0);
      } finally {
        built.solid!.delete();
      }
    });

    it("§13.8 P0 SOLVED: the default sketch lands on the box's TOP face, so the first extrude is VISIBLE", () => {
      // The real first-run flow, end to end. The sketch feature now carries the
      // face-plane spec that `startingSketchModel` produces for a document with
      // geometry (sketch/defaultPlane.ts) instead of a blind XY/0 that sits on
      // the box's buried bottom face.
      const doc: CadDocument = {
        features: [
          { id: "f1", type: "box", name: "Box 1", params: { dx: m(60), dy: m(40), dz: m(30) } },
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
              // What the default path now produces: the box's +Z face.
              plane: { kind: "face", face: { normal: [0, 0, 1] }, offset: 0 },
            },
          },
          { id: "f3", type: "extrude", deps: ["f2"], params: { height: m(10) } },
        ],
        params: {},
      };
      const built = rebuildDocumentIsolated(oc, doc);
      try {
        // The pad ADDS material now — the whole point of the P0.
        const boxVol = m(60) * m(40) * m(30);
        const padVol = m(20) * m(20) * m(10);
        expect(solidVolume(oc, built.solid!)).toBeCloseTo(boxVol + padVol, 9);
        // It stands proud of the box: the model is taller than the box alone.
        expect(built.solid!.boundingBox().max[2]).toBeCloseTo(m(40), 6);
        // And it is a clean success — no warning, because something happened.
        expect(built.statuses.find((st) => st.featureId === "f3")!.status).toBe("ok");
      } finally {
        built.solid!.delete();
      }
    });

    it("§13.8 P0: the face-based default is PARAMETRIC — raising the box carries the pad", () => {
      // A baked `offset: 0.03` would detach the moment the box changed height.
      // The face spec re-resolves against the rebuilt solid every pass.
      const doc = (dz: number): CadDocument => ({
        features: [
          { id: "f1", type: "box", params: { dx: m(60), dy: m(40), dz } },
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
              plane: { kind: "face", face: { normal: [0, 0, 1] }, offset: 0 },
            },
          },
          { id: "f3", type: "extrude", deps: ["f2"], params: { height: m(10) } },
        ],
        params: {},
      });
      for (const dz of [m(30), m(50)]) {
        const solid = rebuildDocument(oc, doc(dz))!;
        try {
          // The pad still sits ON the (moved) top face: total height = box + pad.
          expect(solid.boundingBox().max[2]).toBeCloseTo(dz + m(10), 6);
          expect(solid.volume()).toBeCloseTo(m(60) * m(40) * dz + m(20) * m(20) * m(10), 9);
        } finally {
          solid.delete();
        }
      }
    });

    it("§13.8 P0: a cut sketched ON a face removes material (it aims INTO the body)", () => {
      // The mirror of the extrude case. A face plane's normal points OUTWARD, so
      // sweeping the cut tool along it would pass through empty space and remove
      // nothing — "the operation did nothing" again, from the other side.
      const doc: CadDocument = {
        features: [
          { id: "f1", type: "box", params: { dx: m(60), dy: m(40), dz: m(30) } },
          {
            id: "f2",
            type: "sketch",
            data: {
              // A face plane's u/v origin is the FACE CENTROID, so this 20×20
              // square is centred on the top face and lies fully within it.
              profile: loopProfile([
                [m(-10), m(-10)],
                [m(10), m(-10)],
                [m(10), m(10)],
                [m(-10), m(10)],
              ]),
              plane: { kind: "face", face: { normal: [0, 0, 1] }, offset: 0 },
            },
          },
          { id: "f3", type: "cut", deps: ["f2"], params: { depth: m(10) } },
        ],
        params: {},
      };
      const built = rebuildDocumentIsolated(oc, doc);
      try {
        expect(built.statuses.filter((st) => st.status === "error")).toHaveLength(0);
        // A 20×20×10 pocket was removed from the top — not nothing, and not a
        // through-cut of the whole box.
        const boxVol = m(60) * m(40) * m(30);
        expect(solidVolume(oc, built.solid!)).toBeCloseTo(boxVol - m(20) * m(20) * m(10), 9);
        // The box's outer height is unchanged: the tool went DOWN into it.
        expect(built.solid!.boundingBox().max[2]).toBeCloseTo(m(30), 6);
      } finally {
        built.solid!.delete();
      }
    });

    it("§13.8 P0: a DATUM-plane cut still sweeps +normal (unchanged)", () => {
      // A sketch on XY under the box cuts UPWARD into it — the pre-existing
      // contract the feature-edit gizmo's arrow direction asserts.
      const doc: CadDocument = {
        features: [
          { id: "f1", type: "box", params: { dx: m(60), dy: m(40), dz: m(30) } },
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
              plane: { base: "XY", offset: 0 },
            },
          },
          { id: "f3", type: "cut", deps: ["f2"], params: { depth: m(10) } },
        ],
        params: {},
      };
      const solid = rebuildDocument(oc, doc)!;
      try {
        expect(solid.volume()).toBeCloseTo(m(60) * m(40) * m(30) - m(20) * m(20) * m(10), 9);
      } finally {
        solid.delete();
      }
    });

    it("§13.8 P0: a pad that DOES protrude reports ok (no false warning)", () => {
      const doc: CadDocument = {
        features: [
          { id: "f1", type: "box", name: "Box 1", params: { dx: m(60), dy: m(40), dz: m(30) } },
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
          { id: "f3", type: "extrude", deps: ["f2"], params: { height: m(10) } },
        ],
        params: {},
      };
      const built = rebuildDocumentIsolated(oc, doc);
      try {
        expect(built.statuses.find((st) => st.featureId === "f3")!.status).toBe("ok");
        expect(solidVolume(oc, built.solid!)).toBeGreaterThan(m(60) * m(40) * m(30));
      } finally {
        built.solid!.delete();
      }
    });

    it("a later feature dresses an edge of the SECOND body (per-body edges stay addressable)", () => {
      // Pick a real edge belonging to the far cylinder (x ≈ 100 mm), then fillet
      // it: dress-up must resolve and operate through the compound, and the
      // untouched first body must come through unchanged.
      const mesh = rebuildTagged(oc, twoBoxes(), { linearDeflection: mm(0.5) })!;
      const farEdge = mesh.edges.find((e) => e.midpoint[0] > m(90));
      expect(farEdge, "an edge on the second body").toBeDefined();

      const doc: CadDocument = {
        features: [
          ...twoBoxes().features,
          {
            id: "f3",
            type: "fillet",
            params: { radius: m(1) },
            data: { edges: [{ faceNormals: farEdge!.faceNormals, midpoint: farEdge!.midpoint }] },
          },
        ],
        params: {},
      };
      const built = rebuildDocumentIsolated(oc, doc);
      const failed = built.statuses.filter((st) => st.status === "error");
      expect(failed, JSON.stringify(failed)).toHaveLength(0);
      expect(built.solid).not.toBeNull();
      try {
        expect(bodyCount(oc, built.solid!), "still two bodies after the fillet").toBe(2);
        // The fillet removed material from the cylinder only, so the total drops
        // slightly below the un-filleted sum — proof it actually ran on that body.
        const boxVol = m(40) * m(40) * m(10);
        const cylVol = Math.PI * m(5) ** 2 * m(20);
        const total = solidVolume(oc, built.solid!);
        expect(total).toBeLessThan(boxVol + cylVol);
        expect(total).toBeGreaterThan(boxVol + cylVol * 0.95);
      } finally {
        built.solid!.delete();
      }
    });
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

  it("an isolating rebuild keeps the prior body when a feature fails (FR-24)", () => {
    const m = (x: number): number => mm(x);
    // A fillet whose radius the local geometry cannot absorb: r = 40 mm on a
    // 20 mm-thick box. Fail-fast blanks the WHOLE model; isolating must keep the
    // box and report only the fillet.
    const doc: CadDocument = {
      features: [
        { id: "f1", type: "box", params: { dx: m(40), dy: m(30), dz: m(20) } },
        {
          id: "f2",
          type: "fillet",
          deps: ["f1"],
          params: { radius: m(40) },
          data: { selector: { kind: "allEdges" } },
        },
      ],
      params: {},
    };

    // Fail-fast contract (internal sub-builds / headless) is unchanged: it throws.
    expect(() => rebuildDocument(oc, doc)).toThrow();

    // Isolating contract (the interactive editor): the box survives, and the
    // fillet is reported as errored rather than taking the model down with it.
    const { solid, statuses } = rebuildDocumentIsolated(oc, doc);
    try {
      expect(solid).not.toBeNull();
      // The box passed through untouched — its volume is unchanged.
      expect(solidVolume(oc, solid!)).toBeCloseTo(m(40) * m(30) * m(20), 9);
      expect(statuses.find((s) => s.featureId === "f1")?.status).toBe("ok");
      const bad = statuses.find((s) => s.featureId === "f2");
      expect(bad?.status).toBe("error");
      // The message ALWAYS names the feature, even for a raw OCCT throw, so the
      // UI never has to regex it out (and never renders "undefined").
      expect(bad?.message).toContain("feature 'f2'");
      expect(bad?.message).not.toContain("undefined");
    } finally {
      solid?.delete();
    }
  });

  it("an isolating rebuild reports suppressed features and cascades a failed sketch (FR-24)", () => {
    const doc: CadDocument = {
      features: [
        { id: "f1", type: "box", params: { dx: mm(20), dy: mm(20), dz: mm(20) }, suppressed: true },
        // A sketch with no buildable profile: it fails, and the extrude that
        // needs it must fail too rather than silently building something else.
        { id: "f2", type: "sketch", data: {} },
        { id: "f3", type: "extrude", deps: ["f2"], params: { height: mm(5) } },
      ],
      params: {},
    };
    const { solid, statuses } = rebuildDocumentIsolated(oc, doc);
    try {
      expect(statuses.find((s) => s.featureId === "f1")?.status).toBe("suppressed");
      expect(statuses.find((s) => s.featureId === "f2")?.status).toBe("error");
      expect(statuses.find((s) => s.featureId === "f3")?.status).toBe("error");
      // Every error names its own feature — the cascade is attributable.
      expect(statuses.find((s) => s.featureId === "f3")?.message).toContain("feature 'f3'");
    } finally {
      solid?.delete();
    }
  });

  it("a sweep along picked model edges re-resolves its spine each rebuild (FR-32)", () => {
    const m = (x: number): number => mm(x);
    const box = (dz: number): CadDocument => ({
      features: [{ id: "f1", type: "box", params: { dx: m(40), dy: m(30), dz } }],
      params: {},
    });
    // Capture a real VERTICAL (Z-aligned) box edge: both its adjacent faces are
    // side walls, so both their normals lie in the XY plane. Sweeping an XY
    // profile along it is the clean, non-degenerate case.
    const tagged = rebuildTagged(oc, box(m(20)), { linearDeflection: m(0.5) })!;
    const vertical = tagged.edges.find(
      (e) => Math.abs(e.faceNormals[0]![2]) < 1e-6 && Math.abs(e.faceNormals[1]![2]) < 1e-6,
    );
    expect(vertical).toBeDefined();
    const edgeRef = { faceNormals: vertical!.faceNormals };

    // 4 mm square profile swept along the picked edge. `op: "new"` keeps the pipe
    // a SEPARATE body from the box (§2.4), so the built volume is box + pipe and
    // the pipe's own volume is that total minus the (known) box — which also
    // proves the box survived "new body" instead of being deleted.
    const doc = (dz: number): CadDocument => ({
      features: [
        { id: "f1", type: "box", params: { dx: m(40), dy: m(30), dz } },
        {
          id: "f2",
          type: "sweep",
          deps: ["f1"],
          data: {
            profile: loopProfile([
              [m(-2), m(-2)],
              [m(2), m(-2)],
              [m(2), m(2)],
              [m(-2), m(2)],
            ]),
            pathEdges: [edgeRef],
            op: "new",
          },
        },
      ],
      params: {},
    });

    /** The box body's own volume at a given height. */
    const boxVol = (dz: number): number => m(40) * m(30) * dz;

    // The spine is the picked edge itself: a 4x4 mm profile over a 20 mm edge.
    const a = rebuildDocument(oc, doc(m(20)));
    let pipeA: number;
    try {
      expect(a!.isValid()).toBe(true);
      expect(bodyCount(oc, a!), "box + pipe as two separate bodies").toBe(2);
      pipeA = solidVolume(oc, a!) - boxVol(m(20));
      expect(pipeA).toBeCloseTo(m(4) * m(4) * m(20), 9);
    } finally {
      a!.delete();
    }

    // Grow the box: the EdgeRef must RE-RESOLVE against the rebuilt body and the
    // spine must follow it — a spine baked to points at creation would not move,
    // leaving the volume unchanged.
    const b = rebuildDocument(oc, doc(m(40)));
    try {
      expect(b!.isValid()).toBe(true);
      const pipeB = solidVolume(oc, b!) - boxVol(m(40));
      expect(pipeB).toBeCloseTo(m(4) * m(4) * m(40), 9);
      expect(pipeB).toBeGreaterThan(pipeA * 1.9);
    } finally {
      b!.delete();
    }
  });

  it("a sweep whose picked path edge no longer resolves fails loudly (FR-32)", () => {
    const m = (x: number): number => mm(x);
    // A signature that matches no edge on the body: the sweep must throw rather
    // than silently sweeping along nothing or a wrong edge.
    const doc: CadDocument = {
      features: [
        { id: "f1", type: "box", params: { dx: m(40), dy: m(30), dz: m(20) } },
        {
          id: "f2",
          type: "sweep",
          deps: ["f1"],
          data: {
            profile: loopProfile([
              [m(-2), m(-2)],
              [m(2), m(-2)],
              [m(2), m(2)],
              [m(-2), m(2)],
            ]),
            pathEdges: [
              {
                faceNormals: [
                  [0.577, 0.577, 0.577],
                  [-0.577, -0.577, -0.577],
                ],
              },
            ],
          },
        },
      ],
      params: {},
    };
    expect(() => rebuildDocument(oc, doc)).toThrow(/path edge\(s\) did not resolve/);
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

  it("extrude profile with a hole has less volume than the solid outer (C5 / T11)", () => {
    const m = (x: number): number => mm(x);
    const outer = loopProfile([
      [0, 0],
      [m(40), 0],
      [m(40), m(30)],
      [0, m(30)],
    ]);
    const withHole = {
      ...outer,
      holes: [
        { kind: "circle" as const, center: [m(20), m(15)] as [number, number], radius: m(5) },
      ],
    };
    const solidDoc = (profile: typeof outer | typeof withHole): CadDocument => ({
      features: [
        { id: "s1", type: "sketch", data: { profile } },
        { id: "e1", type: "extrude", deps: ["s1"], params: { height: m(10) }, data: { op: "new" } },
      ],
      params: {},
    });
    const vOuter = rebuildTaggedWithProps(oc, solidDoc(outer), {
      linearDeflection: mm(0.5),
    })!.volume;
    const vHole = rebuildTaggedWithProps(oc, solidDoc(withHole), {
      linearDeflection: mm(0.5),
    })!.volume;
    expect(vOuter).toBeCloseTo(m(40) * m(30) * m(10), 7);
    expect(vHole).toBeLessThan(vOuter);
    // Cylinder hole ≈ π r² h
    const holeVol = Math.PI * m(5) * m(5) * m(10);
    expect(vOuter - vHole).toBeCloseTo(holeVol, 5);
  });

  it("extrude deps bind to a specific sketch, not only the last one (C3)", () => {
    const m = (x: number): number => mm(x);
    // Sketch A: 40×30 rect → height 20. Sketch B: 10×10 rect (later). Extrude deps→A
    // must produce the large prism volume, not the small one from B.
    const large: CadDocument = {
      features: [
        {
          id: "sA",
          type: "sketch",
          data: {
            profile: loopProfile([
              [0, 0],
              [m(40), 0],
              [m(40), m(30)],
              [0, m(30)],
            ]),
          },
        },
        {
          id: "sB",
          type: "sketch",
          data: {
            profile: loopProfile([
              [0, 0],
              [m(10), 0],
              [m(10), m(10)],
              [0, m(10)],
            ]),
          },
        },
        {
          id: "e1",
          type: "extrude",
          deps: ["sA"],
          params: { height: m(20) },
          data: { op: "new" },
        },
      ],
      params: {},
    };
    const lastWins: CadDocument = {
      features: [
        ...large.features.slice(0, 2),
        {
          id: "e1",
          type: "extrude",
          deps: ["sB"],
          params: { height: m(20) },
          data: { op: "new" },
        },
      ],
      params: {},
    };
    const vA = rebuildTaggedWithProps(oc, large, { linearDeflection: mm(0.5) })!.volume;
    const vB = rebuildTaggedWithProps(oc, lastWins, { linearDeflection: mm(0.5) })!.volume;
    expect(vA).toBeCloseTo(m(40) * m(30) * m(20), 7);
    expect(vB).toBeCloseTo(m(10) * m(10) * m(20), 7);
    expect(vA).toBeGreaterThan(vB);
  });

  it("extrude with no upstream sketch throws", () => {
    const doc: CadDocument = {
      features: [{ id: "f1", type: "extrude", params: { height: mm(10) } }],
      params: {},
    };
    expect(() => rebuildDocument(oc, doc)).toThrow(/no sketch profile/);
  });
});

// --- Round primitives as FEATURES (§4.11) ------------------------------------
//
// The kernel gained cylinder/sphere/cone/torus; these pin the evaluator wiring
// that makes them reachable from a document — the step §4.11 would otherwise be
// missing in exactly the way §2.9's addMatePick was (implemented, unreachable).

describe("round primitive features", () => {
  // `oc` is scoped to the suite above, so this block initialises its own (the
  // engine is memoized, so this resolves to the same instance, not a second load).
  let oc: Occt;
  beforeAll(async () => {
    oc = await initOcct();
  }, INIT_TIMEOUT_MS);

  it("builds a cylinder with the exact analytic volume", () => {
    const doc: CadDocument = {
      features: [
        {
          id: "f1",
          type: "cylinder",
          params: { radius: mm(10), height: mm(20) },
          data: { op: "join" },
        },
      ],
      params: {},
    };
    const solid = rebuildDocument(oc, doc);
    expect(solid).not.toBeNull();
    expect(solidVolume(oc, solid!)).toBeCloseTo(Math.PI * mm(10) ** 2 * mm(20), 12);
    solid!.delete();
  });

  it("bores a block with a cutting cylinder — round geometry with NO sketch feature", () => {
    // The §4.11 payoff: this document contains no sketch at all, so it is immune
    // to every defect in the severed sketcher (§2.6/§2.7).
    const doc: CadDocument = {
      features: [
        { id: "f1", type: "box", params: { dx: mm(40), dy: mm(40), dz: mm(20) } },
        {
          id: "f2",
          type: "cylinder",
          params: {
            radius: mm(8),
            height: mm(60),
            ox: mm(20),
            oy: mm(20),
            oz: mm(-20),
            ax: 0,
            ay: 0,
            az: 1,
          },
          data: { op: "cut" },
        },
      ],
      params: {},
    };
    const solid = rebuildDocument(oc, doc);
    expect(solid).not.toBeNull();
    expect(solidVolume(oc, solid!)).toBeCloseTo(
      mm(40) * mm(40) * mm(20) - Math.PI * mm(8) ** 2 * mm(20),
      10,
    );
    solid!.delete();
  });

  it("joins a cylindrical boss onto a block by default", () => {
    const doc: CadDocument = {
      features: [
        { id: "f1", type: "box", params: { dx: mm(40), dy: mm(40), dz: mm(10) } },
        {
          id: "f2",
          type: "cylinder",
          params: { radius: mm(5), height: mm(10), ox: mm(20), oy: mm(20), oz: mm(10) },
          data: { op: "join" },
        },
      ],
      params: {},
    };
    const solid = rebuildDocument(oc, doc);
    expect(solid).not.toBeNull();
    expect(solidVolume(oc, solid!)).toBeCloseTo(
      mm(40) * mm(40) * mm(10) + Math.PI * mm(5) ** 2 * mm(10),
      10,
    );
    solid!.delete();
  });

  it("honours a non-default axis (a cylinder lying along +X)", () => {
    const doc: CadDocument = {
      features: [
        {
          id: "f1",
          type: "cylinder",
          params: { radius: mm(5), height: mm(30), ax: 1, ay: 0, az: 0 },
          data: { op: "new" },
        },
      ],
      params: {},
    };
    const solid = rebuildDocument(oc, doc);
    expect(solid).not.toBeNull();
    const bb = solid!.boundingBox();
    expect(bb.max[0]).toBeCloseTo(mm(30), 6); // extends along X, not Z
    expect(bb.max[2]).toBeCloseTo(mm(5), 6);
    solid!.delete();
  });

  it("angle >= 2π means a FULL solid, not a degenerate wedge (the ribbon default)", () => {
    // The ribbon bakes angle: 2π so the panel can edit it; that must build the
    // complete cylinder, not select OCCT's partial-sweep ctor.
    const doc: CadDocument = {
      features: [
        {
          id: "f1",
          type: "cylinder",
          params: { radius: mm(10), height: mm(20), angle: 2 * Math.PI },
          data: { op: "new" },
        },
      ],
      params: {},
    };
    const solid = rebuildDocument(oc, doc);
    expect(solid).not.toBeNull();
    expect(solidVolume(oc, solid!)).toBeCloseTo(Math.PI * mm(10) ** 2 * mm(20), 12);
    solid!.delete();
  });

  it("builds sphere, cone and torus with exact volumes", () => {
    const cases: [string, Record<string, number>, number][] = [
      ["sphere", { radius: mm(10) }, (4 / 3) * Math.PI * mm(10) ** 3],
      [
        "cone",
        { radius1: mm(10), radius2: mm(5), height: mm(20) },
        ((Math.PI * mm(20)) / 3) * (mm(10) ** 2 + mm(10) * mm(5) + mm(5) ** 2),
      ],
      [
        "torus",
        { majorRadius: mm(20), minorRadius: mm(5) },
        2 * Math.PI ** 2 * mm(20) * mm(5) ** 2,
      ],
    ];
    for (const [type, params, expected] of cases) {
      const doc: CadDocument = {
        features: [{ id: "f1", type, params, data: { op: "new" } }],
        params: {},
      };
      const solid = rebuildDocument(oc, doc);
      expect(solid).not.toBeNull();
      expect(solidVolume(oc, solid!), `${type} volume`).toBeCloseTo(expected, 12);
      solid!.delete();
    }
  });

  // The Bore action exists because of this asymmetry, found by asking whether the
  // RIBBON's placement (not a hand-written one) actually cuts. It does not.
  it("a cut tool grown along the OUTWARD face normal removes nothing — why Bore exists", () => {
    // Exactly what the additive ribbon actions bake: origin = face centroid,
    // axis = outward normal. Correct for a boss; for a cut the tool sits
    // entirely OUTSIDE the material, so it silently removes nothing. An earlier
    // status text told users to flip Op to "cut" to bore — promising an
    // operation this placement cannot perform (the §2.3 honesty defect).
    const doc: CadDocument = {
      features: [
        { id: "f1", type: "box", params: { dx: mm(40), dy: mm(40), dz: mm(20) } },
        {
          id: "f2",
          type: "cylinder",
          params: {
            radius: mm(10),
            height: mm(30),
            ox: mm(20),
            oy: mm(20),
            oz: mm(20), // top-face centroid
            ax: 0,
            ay: 0,
            az: 1, // OUTWARD normal
            angle: 2 * Math.PI,
          },
          data: { op: "cut" },
        },
      ],
      params: {},
    };
    const solid = rebuildDocument(oc, doc);
    expect(solid).not.toBeNull();
    // Unchanged: the cut was a no-op.
    expect(solidVolume(oc, solid!)).toBeCloseTo(mm(40) * mm(40) * mm(20), 12);
    solid!.delete();
  });

  it("Bore's placement (INWARD normal, proud of the face) really removes material", () => {
    // What boreAction() bakes: start OVERSHOOT proud of the face and aim along
    // the inward normal, so the requested depth is measured from the face.
    const OVERSHOOT = 1e-4;
    const depth = mm(20); // straight through the 20 mm plate
    const doc: CadDocument = {
      features: [
        { id: "f1", type: "box", params: { dx: mm(40), dy: mm(40), dz: mm(20) } },
        {
          id: "f2",
          type: "cylinder",
          params: {
            radius: mm(5),
            height: depth + OVERSHOOT,
            ox: mm(20),
            oy: mm(20),
            oz: mm(20) + OVERSHOOT, // proud of the face
            ax: 0,
            ay: 0,
            az: -1, // INWARD normal
            angle: 2 * Math.PI,
          },
          data: { op: "cut" },
        },
      ],
      params: {},
    };
    const solid = rebuildDocument(oc, doc);
    expect(solid).not.toBeNull();
    // A clean through-hole: exactly the cylinder's volume is gone.
    expect(solidVolume(oc, solid!)).toBeCloseTo(
      mm(40) * mm(40) * mm(20) - Math.PI * mm(5) ** 2 * mm(20),
      10,
    );
    solid!.delete();
  });

  it("a degenerate primitive fails LOUDLY, naming its feature", () => {
    const doc: CadDocument = {
      features: [
        { id: "f1", type: "torus", params: { majorRadius: mm(5), minorRadius: mm(10) }, data: {} },
      ],
      params: {},
    };
    expect(() => rebuildDocument(oc, doc)).toThrow(/self-intersect/);
  });
});
