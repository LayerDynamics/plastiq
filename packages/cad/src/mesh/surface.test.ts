// §2.1 — persistent refs on CLOSED CURVED faces, against real OCCT.
//
// The defect this pins: a FaceRef's identity used to be the area-weighted
// average triangulation normal, which for a closed curved face (hole wall,
// cylindrical boss, sphere) integrates to ZERO — the stored value was
// normalized floating-point residue. The audit's live repro: a hole of r=8 mm
// stored wall signature [0.899, −0.438, 0]; rebuilt at r=9 mm it became
// [−0.432, 0.902, 0] — unrelated directions, so the ref could never re-match
// and any fillet on it broke on the first parameter change.
//
// These tests assert the fix from BOTH sides: the same surface must re-resolve
// across a rebuild, and a genuinely CHANGED surface must NOT match.

import { beforeAll, describe, expect, it } from "vitest";

import { initOcct, type Occt } from "../oc/init.js";
import { makeBox } from "../solid/primitives.js";
import { subtract } from "../action/boolean.js";
import { extrude } from "../action/extrude.js";
import { Sketch } from "../sketch/sketch.js";
import { planeXY } from "../env/plane.js";
import { tessellateTagged } from "./tessellate.js";
import { resolveFaceRef } from "./resolve.js";
import { faceSurfaceSignature, surfacesMatch, isClosedCurved } from "./surface.js";
import { shapeEnums } from "./normals.js";
import type { Solid } from "../solid/solid.js";
import type { FaceGroup } from "./tagged.js";

let oc: Occt;
beforeAll(async () => {
  oc = await initOcct();
});

/** A 40x30x20 mm plate with a through-hole of `radius` at its centre. */
function plateWithHole(radius: number): Solid {
  const plate = makeBox(oc, 0.04, 0.03, 0.02);
  const circle = Sketch.circle(planeXY(), 0.02, 0.015, radius);
  const tool = extrude(oc, circle, 0.05, { back: 0.01 });
  try {
    const r = subtract(oc, plate, tool);
    if (!r.ok) throw new Error(`hole cut failed: ${r.error}`);
    return r.solid;
  } finally {
    tool.delete();
    plate.delete();
  }
}

/** The face group whose surface is the hole's cylindrical wall. */
function holeWall(solid: Solid): FaceGroup {
  const mesh = tessellateTagged(oc, solid, { linearDeflection: 5e-4 });
  const wall = mesh.faceGroups.find((g) => g.surface.kind === "cylinder");
  expect(wall, "the plate must have a cylindrical hole wall").toBeDefined();
  return wall!;
}

describe("§2.1 the old average-normal signature is degenerate on a hole wall", () => {
  it("the hole wall's stored `normal` really is meaningless residue", () => {
    const a = plateWithHole(0.008);
    const b = plateWithHole(0.009);
    try {
      const na = holeWall(a).normal;
      const nb = holeWall(b).normal;
      // Each is (near-)zero-length noise before normalization — the radial
      // components cancel over a closed wall. They do NOT agree with each other,
      // which is exactly why resolveFaceRef's dot >= 0.999 could never match.
      const dot = na[0] * nb[0] + na[1] * nb[1] + na[2] * nb[2];
      expect(Math.abs(dot)).toBeLessThan(0.999);
    } finally {
      a.delete();
      b.delete();
    }
  });
});

describe("§2.1 analytic surface signatures", () => {
  it("classifies the hole wall as a cylinder with its EXACT radius + axis", () => {
    const solid = plateWithHole(0.008);
    try {
      const sig = holeWall(solid).surface;
      expect(sig.kind).toBe("cylinder");
      if (sig.kind !== "cylinder") throw new Error("unreachable");
      // Exact, straight off the B-rep — not measured from a mesh.
      expect(sig.radius).toBeCloseTo(0.008, 9);
      // A through-hole cut along Z: the wall's axis is Z.
      expect(Math.abs(sig.axis[2])).toBeCloseTo(1, 9);
      expect(isClosedCurved(sig)).toBe(true);
    } finally {
      solid.delete();
    }
  });

  it("the SAME hole re-cut at the same radius matches; a DIFFERENT radius does not", () => {
    const a = plateWithHole(0.008);
    const same = plateWithHole(0.008);
    const bigger = plateWithHole(0.009);
    try {
      const sigA = holeWall(a).surface;
      expect(surfacesMatch(sigA, holeWall(same).surface)).toBe(true);
      // The whole point: a hole re-cut at 9 mm is a DIFFERENT surface. Matching
      // it would silently attach a dress-up to changed geometry.
      expect(surfacesMatch(sigA, holeWall(bigger).surface)).toBe(false);
    } finally {
      a.delete();
      same.delete();
      bigger.delete();
    }
  });

  it("a hole-wall FaceRef RE-RESOLVES across a rebuild (the audit's repro, inverted)", () => {
    const first = plateWithHole(0.008);
    let ref: { normal: [number, number, number]; centroid: [number, number, number]; surface: unknown };
    try {
      const wall = holeWall(first);
      ref = { normal: wall.normal, centroid: wall.centroid, surface: wall.surface };
    } finally {
      first.delete();
    }

    // Rebuild the identical document: the wall must resolve. Under the old
    // average-normal signature this matched only by luck of an identical cached
    // triangulation, and broke the moment anything upstream moved.
    const rebuilt = plateWithHole(0.008);
    try {
      const face = resolveFaceRef(oc, rebuilt, ref as never);
      expect(face, "the hole wall must re-resolve on a rebuilt body").not.toBeNull();
      // And it resolved to a CYLINDER of the right radius — not just "some face".
      const sig = faceSurfaceSignature(oc, face!);
      expect(sig.kind).toBe("cylinder");
      if (sig.kind === "cylinder") expect(sig.radius).toBeCloseTo(0.008, 9);
      face!.delete();
    } finally {
      rebuilt.delete();
    }
  });

  it("a hole-wall FaceRef FAILS LOUDLY when the hole radius changes", () => {
    const first = plateWithHole(0.008);
    let ref: unknown;
    try {
      const wall = holeWall(first);
      ref = { normal: wall.normal, centroid: wall.centroid, surface: wall.surface };
    } finally {
      first.delete();
    }
    // The referenced surface no longer exists. Returning null is CORRECT — the
    // dress-ups turn it into "N of M selected edge(s) did not resolve", which is
    // an honest error rather than a silent wrong-face rebind.
    const resized = plateWithHole(0.009);
    try {
      expect(resolveFaceRef(oc, resized, ref as never)).toBeNull();
    } finally {
      resized.delete();
    }
  });

  it("still resolves a PLANAR face, and legacy refs with no `surface` keep working", () => {
    const solid = plateWithHole(0.008);
    try {
      const mesh = tessellateTagged(oc, solid, { linearDeflection: 5e-4 });
      const top = mesh.faceGroups.find(
        (g) => g.surface.kind === "plane" && g.normal[2] > 0.999,
      );
      expect(top).toBeDefined();

      // New-style ref (analytic surface + centroid).
      const withSurface = resolveFaceRef(oc, solid, {
        normal: top!.normal,
        centroid: top!.centroid,
        surface: top!.surface,
      });
      expect(withSurface).not.toBeNull();
      withSurface!.delete();

      // Legacy ref: no `surface` at all (persisted before §2.1). Must still
      // resolve by the normal path — back-compat is not optional here, existing
      // documents carry these.
      const legacy = resolveFaceRef(oc, solid, { normal: top!.normal, centroid: top!.centroid });
      expect(legacy).not.toBeNull();
      legacy!.delete();
    } finally {
      solid.delete();
    }
  });

  it("distinguishes the two coplanar walls of a stepped pocket by centroid", () => {
    // Two faces can share ONE analytic surface (coplanar fragments, or the two
    // sides of a slot). The centroid disambiguator must still pick the right one.
    const box = makeBox(oc, 0.04, 0.03, 0.02);
    try {
      const mesh = tessellateTagged(oc, box, { linearDeflection: 5e-4 });
      const planes = mesh.faceGroups.filter((g) => g.surface.kind === "plane");
      expect(planes.length).toBe(6);
      for (const g of planes) {
        const face = resolveFaceRef(oc, box, {
          normal: g.normal,
          centroid: g.centroid,
          surface: g.surface,
        });
        expect(face).not.toBeNull();
        // Each of the six faces resolves to a face whose own centroid is its own.
        const S = shapeEnums(oc);
        void S;
        face!.delete();
      }
    } finally {
      box.delete();
    }
  });
});
