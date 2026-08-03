// §13.2 draftMulti — the `draft` op widened to taper MULTIPLE faces in a single
// BRepOffsetAPI_DraftAngle build (loop `.Add` over each resolved face, one
// Build). Driven against the real OCCT wasm with persistent FaceRefs captured
// from the tagged tessellation, mirroring dressup.test.ts's harness.

import { beforeAll, describe, expect, it } from "vitest";

import { initOcct, type Occt } from "../oc/init.js";
import { mm } from "../unit/index.js";
import { makeBox } from "../solid/primitives.js";
import { tessellateTagged } from "../mesh/tessellate.js";
import type { FaceRef } from "../mesh/tagged.js";
import { draft } from "./index.js";

let oc: Occt;

beforeAll(async () => {
  oc = await initOcct();
}, 120_000);

/** Capture the +X and +Y vertical side faces (two ADJACENT side faces) of a box. */
function sideFaces(dx: number, dy: number, dz: number): { plusX: FaceRef; plusY: FaceRef } {
  const box = makeBox(oc, dx, dy, dz);
  const mesh = tessellateTagged(oc, box);
  const plusX: FaceRef = { normal: mesh.faceGroups.find((g) => Math.round(g.normal[0]) === 1)!.normal };
  const plusY: FaceRef = { normal: mesh.faceGroups.find((g) => Math.round(g.normal[1]) === 1)!.normal };
  box.delete();
  return { plusX, plusY };
}

/** Number of distinct topological faces of a solid (one tagged face group each). */
function faceCount(solid: ReturnType<typeof makeBox>): number {
  return tessellateTagged(oc, solid).faceGroups.length;
}

describe("draft — multi-face (§13.2)", () => {
  it("tapers TWO adjacent side faces in one build: valid solid, volume drops (positive draft removes material above the neutral base plane)", () => {
    const { plusX, plusY } = sideFaces(mm(60), mm(40), mm(30));
    const box = makeBox(oc, mm(60), mm(40), mm(30));
    const before = faceCount(box); // 6 planar faces

    const drafted = draft(oc, box, {
      faces: [plusX, plusY],
      pullDirection: [0, 0, 1],
      neutralOrigin: [0, 0, 0],
      neutralNormal: [0, 0, 1],
      angle: (5 * Math.PI) / 180,
    });

    // A mold draft only TILTS the picked faces about the neutral plane — it must
    // not add or drop faces, and the whole thing is one valid solid.
    expect(drafted.isValid()).toBe(true);
    expect(faceCount(drafted)).toBe(before);
    // Positive draft about a neutral plane at the base (z=0) narrows the section
    // toward the top → material is removed → volume DECREASES. Assert the sign.
    expect(drafted.volume()).toBeLessThan(box.volume());
    expect(drafted.volume()).toBeGreaterThan(box.volume() * 0.8);

    box.delete();
    drafted.delete();
  });

  it("removes MORE material than a single-face draft (the second face genuinely tapered)", () => {
    const { plusX, plusY } = sideFaces(mm(60), mm(40), mm(30));
    const boxOne = makeBox(oc, mm(60), mm(40), mm(30));
    const boxTwo = makeBox(oc, mm(60), mm(40), mm(30));
    const shared = {
      pullDirection: [0, 0, 1] as [number, number, number],
      neutralOrigin: [0, 0, 0] as [number, number, number],
      neutralNormal: [0, 0, 1] as [number, number, number],
      angle: (5 * Math.PI) / 180,
    };

    const one = draft(oc, boxOne, { faces: [plusX], ...shared });
    const two = draft(oc, boxTwo, { faces: [plusX, plusY], ...shared });

    // Drafting the extra +Y face removes an additional wedge, so two-face volume
    // is strictly below the single-face volume.
    expect(two.volume()).toBeLessThan(one.volume());
    expect(two.volume()).toBeGreaterThan(0);

    boxOne.delete();
    boxTwo.delete();
    one.delete();
    two.delete();
  });

  it("back-compat: the single `face` option still tapers one face and drops volume", () => {
    const { plusX } = sideFaces(mm(60), mm(40), mm(30));
    const box = makeBox(oc, mm(60), mm(40), mm(30));
    const before = faceCount(box);

    // The pre-§13.2 call shape (single `face`, no `faces`) — the path the app and
    // rebuild.ts:974 use today — must keep working unchanged.
    const drafted = draft(oc, box, {
      face: plusX,
      pullDirection: [0, 0, 1],
      neutralOrigin: [0, 0, 0],
      neutralNormal: [0, 0, 1],
      angle: (5 * Math.PI) / 180,
    });

    expect(drafted.isValid()).toBe(true);
    expect(faceCount(drafted)).toBe(before);
    expect(drafted.volume()).toBeLessThan(box.volume());
    expect(drafted.volume()).toBeGreaterThan(box.volume() * 0.9);

    box.delete();
    drafted.delete();
  });

  it("throws (all-must-resolve) when ANY face in the list fails to resolve — nothing is built", () => {
    const { plusX } = sideFaces(mm(60), mm(40), mm(30));
    const box = makeBox(oc, mm(60), mm(40), mm(30));
    // A signature along the cube diagonal matches no axis-aligned box face
    // (dot ≈ 0.577 < the 0.999 face tolerance), so it never resolves.
    const bogus: FaceRef = { normal: [0.577, 0.577, 0.577] };

    expect(() =>
      draft(oc, box, {
        faces: [plusX, bogus],
        pullDirection: [0, 0, 1],
        neutralOrigin: [0, 0, 0],
        neutralNormal: [0, 0, 1],
        angle: (5 * Math.PI) / 180,
      }),
    ).toThrow(/did not resolve/);

    box.delete();
  });

  it("throws when the face list is empty (nothing selected)", () => {
    const box = makeBox(oc, mm(60), mm(40), mm(30));
    expect(() =>
      draft(oc, box, {
        faces: [],
        pullDirection: [0, 0, 1],
        neutralOrigin: [0, 0, 0],
        neutralNormal: [0, 0, 1],
        angle: (5 * Math.PI) / 180,
      }),
    ).toThrow(/no face selected/);
    box.delete();
  });
});
