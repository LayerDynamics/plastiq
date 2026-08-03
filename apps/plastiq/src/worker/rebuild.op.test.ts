// R9 / P3 — a profile feature's `data.op` must be honoured FULLY. Before R9 the
// evaluator tested `op !== "new"` and joined, so an extrude/revolve/loft/sweep
// with `op:"cut"` or `op:"intersect"` silently became a pad. These tests build an
// extrude whose pad lies ENTIRELY inside a box and assert the three ops give three
// distinct volumes — the only way to prove cut/intersect are not silent joins.

import { beforeAll, describe, expect, it } from "vitest";
import { initOcct, mm, type Occt } from "@plastiq/cad";
import type { CadDocument } from "../store/types.js";
import type { Profile } from "../sketch/profile.js";
import { rebuildDocument } from "./rebuild.js";

let oc: Occt;
beforeAll(async () => {
  oc = await initOcct();
}, 120_000);

/** A closed line-loop profile from an ordered point list. */
function loopProfile(pts: [number, number][]): Profile {
  const [start, ...rest] = pts;
  return { kind: "loop", start: start!, segments: rest.map((to) => ({ kind: "line", to })) };
}

// A 40×40×40 mm box, and a 20×20 mm profile (fully inside the footprint) extruded
// 40 mm up so the pad is entirely CONTAINED in the box.
const BOX_MM = 40;
const PAD_SIDE_MM = 20;
const boxVol = mm(BOX_MM) ** 3; // 6.4e-5 m³
const padVol = mm(PAD_SIDE_MM) ** 2 * mm(BOX_MM); // 1.6e-5 m³

function docWithOp(op: string | undefined): CadDocument {
  const rect = loopProfile([
    [mm(10), mm(10)],
    [mm(30), mm(10)],
    [mm(30), mm(30)],
    [mm(10), mm(30)],
  ]);
  return {
    features: [
      { id: "f1", type: "box", params: { dx: mm(BOX_MM), dy: mm(BOX_MM), dz: mm(BOX_MM) } },
      { id: "f2", type: "sketch", data: { profile: rect, plane: { base: "XY", offset: 0 } } },
      {
        id: "f3",
        type: "extrude",
        deps: ["f2"],
        params: { height: mm(BOX_MM) },
        ...(op ? { data: { op } } : {}),
      },
    ],
    params: {},
  };
}

function volumeOf(doc: CadDocument): number {
  const solid = rebuildDocument(oc, doc)!;
  try {
    return solid.volume();
  } finally {
    solid.delete();
  }
}

type RemainingProfileKind = "revolve" | "loft" | "sweep";

/**
 * Each tool overlaps the 40 mm base box without consuming it completely. This
 * lets one boolean identity prove all four operation results against the real
 * OCCT evaluator: cut + intersect = base, while join + intersect equals the
 * multi-body `new` result (base + untouched tool).
 */
function remainingProfileDoc(
  kind: RemainingProfileKind,
  op: "new" | "join" | "cut" | "intersect",
): CadDocument {
  const base = {
    id: "base",
    type: "box" as const,
    params: { dx: mm(BOX_MM), dy: mm(BOX_MM), dz: mm(BOX_MM) },
  };
  const square = loopProfile([
    [mm(10), mm(10)],
    [mm(30), mm(10)],
    [mm(30), mm(30)],
    [mm(10), mm(30)],
  ]);

  if (kind === "revolve") {
    return {
      features: [
        base,
        {
          id: "profile",
          type: "sketch",
          data: { profile: square, plane: { base: "XY", offset: mm(20) } },
        },
        {
          id: "tool",
          type: "revolve",
          deps: ["profile"],
          params: {
            angle: Math.PI * 2,
            ox: 0,
            oy: 0,
            oz: mm(20),
            ax: 0,
            ay: 1,
            az: 0,
          },
          data: { op },
        },
      ],
      params: {},
    };
  }

  if (kind === "loft") {
    return {
      features: [
        base,
        {
          id: "tool",
          type: "loft",
          data: {
            op,
            sections: [
              { profile: square, plane: { base: "XY", offset: mm(5) } },
              { profile: square, plane: { base: "XY", offset: mm(35) } },
            ],
          },
        },
      ],
      params: {},
    };
  }

  return {
    features: [
      base,
      {
        id: "tool",
        type: "sweep",
        data: {
          op,
          profile: { kind: "circle", center: [mm(20), mm(20)], radius: mm(5) },
          plane: { base: "XY", offset: mm(5) },
          path: {
            kind: "polyline",
            points: [
              [mm(20), mm(20), mm(5)],
              [mm(20), mm(20), mm(35)],
            ],
          },
        },
      },
    ],
    params: {},
  };
}

describe("R9 — profile feature honours data.op (cut / intersect / join), never silently joins", () => {
  it("op:'cut' SUBTRACTS the pad from the box", () => {
    const s = rebuildDocument(oc, docWithOp("cut"))!;
    expect(s.volume()).toBeCloseTo(boxVol - padVol, 7); // 4.8e-5
    s.delete();
  });

  it("op:'intersect' keeps only the overlap (the pad)", () => {
    const s = rebuildDocument(oc, docWithOp("intersect"))!;
    expect(s.volume()).toBeCloseTo(padVol, 7); // 1.6e-5
    s.delete();
  });

  it("op:'join' (and default) unions — pad is inside, so volume stays the box", () => {
    const joined = rebuildDocument(oc, docWithOp("join"))!;
    expect(joined.volume()).toBeCloseTo(boxVol, 7);
    joined.delete();
    const dflt = rebuildDocument(oc, docWithOp(undefined))!;
    expect(dflt.volume()).toBeCloseTo(boxVol, 7);
    dflt.delete();
  });

  it("op:'new' keeps the pad as a separate body alongside the existing body", () => {
    expect(volumeOf(docWithOp("new"))).toBeCloseTo(boxVol + padVol, 7);
  });

  for (const kind of ["revolve", "loft", "sweep"] as const) {
    it(`${kind} honours new / join / cut / intersect in the real OCCT rebuild`, () => {
      const multiBodyVolume = volumeOf(remainingProfileDoc(kind, "new"));
      const joinedVolume = volumeOf(remainingProfileDoc(kind, "join"));
      const cutVolume = volumeOf(remainingProfileDoc(kind, "cut"));
      const intersectVolume = volumeOf(remainingProfileDoc(kind, "intersect"));

      expect(multiBodyVolume).toBeGreaterThan(boxVol);
      expect(intersectVolume).toBeGreaterThan(0);
      expect(intersectVolume).toBeLessThan(boxVol);
      expect(cutVolume + intersectVolume).toBeCloseTo(boxVol, 7);
      expect(joinedVolume + intersectVolume).toBeCloseTo(multiBodyVolume, 7);
    });
  }
});
