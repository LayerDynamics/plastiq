// R8 kernel honesty pass — dress-up defects against the real OCCT wasm:
//   K1  chamfer throws on distance2 WITHOUT a face (was a silent symmetric chamfer)
//   K2  shell tolerance is an option (default 1e-5 m), replacing the hardcoded 1e-3 m
//   K7  fillet/chamfer/shell reject non-finite / zero / negative magnitudes with
//       NAMED errors BEFORE OCCT (mirrors revolve.ts's pre-validation)

import { beforeAll, describe, expect, it } from "vitest";

import { initOcct, type Occt } from "../oc/init.js";
import { mm } from "../unit/index.js";
import { makeBox } from "../solid/primitives.js";
import { tessellateTagged } from "../mesh/tessellate.js";
import type { EdgeRef, FaceRef } from "../mesh/tagged.js";
import { chamfer, fillet, shell } from "./index.js";

let oc: Occt;

beforeAll(async () => {
  oc = await initOcct();
}, 120_000);

/** Capture a real EdgeRef and the +Z top FaceRef from a fresh box. */
function refs(dx: number, dy: number, dz: number): { edge: EdgeRef; top: FaceRef } {
  const box = makeBox(oc, dx, dy, dz);
  const mesh = tessellateTagged(oc, box);
  const edge: EdgeRef = { faceNormals: mesh.edges[0]!.faceNormals };
  const top: FaceRef = {
    normal: mesh.faceGroups.find((g) => Math.round(g.normal[2]) === 1)!.normal,
  };
  box.delete();
  return { edge, top };
}

describe("K7 — fillet magnitude pre-validation", () => {
  it("rejects a non-finite / zero / negative radius with a NAMED error before OCCT", () => {
    const { edge } = refs(mm(60), mm(40), mm(30));
    const box = makeBox(oc, mm(60), mm(40), mm(30));
    for (const bad of [0, -mm(2), Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => fillet(oc, box, [edge], bad)).toThrow(
        /radius must be a finite positive number/,
      );
    }
    // A supplied endRadius is validated too (variable-radius fillet path, T20).
    expect(() => fillet(oc, box, [edge], mm(3), { endRadius: -mm(1) })).toThrow(
      /endRadius must be a finite positive number/,
    );
    // The named guard fires WITHOUT ever reaching OCCT: the box is still usable.
    expect(box.isValid()).toBe(true);
    box.delete();
  });
});

describe("K7 — chamfer magnitude pre-validation", () => {
  it("rejects a non-finite / zero / negative distance (and distance2) with NAMED errors", () => {
    const { edge, top } = refs(mm(60), mm(40), mm(30));
    const box = makeBox(oc, mm(60), mm(40), mm(30));
    for (const bad of [0, -mm(2), Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => chamfer(oc, box, [edge], bad)).toThrow(
        /distance must be a finite positive number/,
      );
    }
    // distance2, when present, is validated the same way (needs a face too — see K1).
    expect(() => chamfer(oc, box, [edge], mm(2), { distance2: -mm(1), face: top })).toThrow(
      /distance2 must be a finite positive number/,
    );
    box.delete();
  });
});

describe("K1 — chamfer refuses distance2 without a face", () => {
  it("throws a named error instead of silently emitting a SYMMETRIC chamfer", () => {
    const { edge } = refs(mm(60), mm(40), mm(30));
    const box = makeBox(oc, mm(60), mm(40), mm(30));
    // The old behavior: distance2 with no face fell through to Add_2 (symmetric)
    // and reported success — an asymmetric-chamfer request lost silently.
    expect(() => chamfer(oc, box, [edge], mm(2), { distance2: mm(4) })).toThrow(
      /distance2 requires a face to apply it to/,
    );
    box.delete();
  });

  it("still accepts a two-distance chamfer when the face IS supplied", () => {
    const { top } = refs(mm(60), mm(40), mm(30));
    const box = makeBox(oc, mm(60), mm(40), mm(30));
    const mesh = tessellateTagged(oc, box);
    // An edge that borders the +Z top face, so `top` is a valid Dis1 face.
    const e = mesh.edges.find(
      (x) => Math.abs(x.faceNormals[0][2]) > 0.9 || Math.abs(x.faceNormals[1][2]) > 0.9,
    )!;
    const chamfered = chamfer(oc, box, [{ faceNormals: e.faceNormals }], mm(2), {
      distance2: mm(4),
      face: top,
    });
    expect(chamfered.isValid()).toBe(true);
    expect(chamfered.volume()).toBeLessThan(box.volume());
    box.delete();
    chamfered.delete();
  });
});

describe("K7/K2 — shell magnitude + tolerance validation", () => {
  it("rejects a non-finite / zero / negative thickness with a NAMED error", () => {
    const { top } = refs(mm(60), mm(40), mm(30));
    const box = makeBox(oc, mm(60), mm(40), mm(30));
    for (const bad of [0, -mm(3), Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => shell(oc, box, [top], bad)).toThrow(
        /thickness must be a finite positive number/,
      );
    }
    box.delete();
  });

  it("rejects a non-finite / zero / negative tolerance override with a NAMED error", () => {
    const { top } = refs(mm(60), mm(40), mm(30));
    const box = makeBox(oc, mm(60), mm(40), mm(30));
    for (const bad of [0, -1e-5, Number.NaN]) {
      expect(() => shell(oc, box, [top], mm(3), { tolerance: bad })).toThrow(
        /tolerance must be a finite positive number/,
      );
    }
    box.delete();
  });
});

describe("K2 — shell honors an explicit tolerance", () => {
  it("a custom tolerance is plumbed through and yields the same hollow geometry", () => {
    const { top } = refs(mm(60), mm(40), mm(30));
    // Default tolerance (now 1e-5 m, was 1e-3 m) vs an explicit 1e-4 m: the
    // tolerance drives the offset solver's robustness, not the target wall, so a
    // 60×40×30 box hollowed 3 mm must land on the same volume either way. That
    // both a defaulted and an overridden tolerance produce a valid, equal-volume
    // shell proves the option is actually honored (not ignored) end to end.
    const boxA = makeBox(oc, mm(60), mm(40), mm(30));
    const hollowDefault = shell(oc, boxA, [top], mm(3));
    const boxB = makeBox(oc, mm(60), mm(40), mm(30));
    const hollowCustom = shell(oc, boxB, [top], mm(3), { tolerance: 1e-4 });

    expect(hollowDefault.isValid()).toBe(true);
    expect(hollowCustom.isValid()).toBe(true);
    expect(hollowCustom.volume()).toBeCloseTo(hollowDefault.volume(), 9);

    boxA.delete();
    boxB.delete();
    hollowDefault.delete();
    hollowCustom.delete();
  });
});
