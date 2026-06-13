// R4 (chunk 2) — dress-up ops against the real OCCT wasm, driven by persistent
// EdgeRef/FaceRef captured from the tagged tessellation.

import { beforeAll, describe, expect, it } from "vitest";

import { initOcct, type Occt } from "../oc/init.js";
import { mm } from "../unit/index.js";
import { makeBox } from "../solid/primitives.js";
import { tessellateTagged } from "../mesh/tessellate.js";
import type { EdgeRef, FaceRef } from "../mesh/tagged.js";
import { chamfer, draft, fillet, shell } from "./index.js";

let oc: Occt;

beforeAll(async () => {
  oc = await initOcct();
}, 120_000);

/** Capture one edge's EdgeRef and the +Z top face's FaceRef from a box. */
function refs(dx: number, dy: number, dz: number): { edge: EdgeRef; top: FaceRef; side: FaceRef } {
  const box = makeBox(oc, dx, dy, dz);
  const mesh = tessellateTagged(oc, box);
  const edge: EdgeRef = { faceNormals: mesh.edges[0]!.faceNormals };
  const top: FaceRef = { normal: mesh.faceGroups.find((g) => Math.round(g.normal[2]) === 1)!.normal };
  const side: FaceRef = { normal: mesh.faceGroups.find((g) => Math.round(g.normal[0]) === 1)!.normal };
  box.delete();
  return { edge, top, side };
}

/** Number of distinct topological faces of a solid (one tagged face group each). */
function faceCount(solid: ReturnType<typeof makeBox>): number {
  return tessellateTagged(oc, solid).faceGroups.length;
}

describe("fillet", () => {
  it("rounds a picked edge: a new rounded face appears and the volume drops slightly", () => {
    const { edge } = refs(mm(60), mm(40), mm(30));
    const box = makeBox(oc, mm(60), mm(40), mm(30));
    const before = faceCount(box); // a box has 6 planar faces
    const filleted = fillet(oc, box, [edge], mm(3));
    // The sharp edge is replaced by a NEW rounded (cylindrical) face. A no-op that
    // merely preserved volume — the failure the old volume-only check couldn't
    // see — would leave the topology, and so the face count, unchanged.
    expect(faceCount(filleted)).toBeGreaterThan(before);
    expect(filleted.volume()).toBeLessThan(box.volume());
    expect(filleted.volume()).toBeGreaterThan(box.volume() * 0.95);
    box.delete();
    filleted.delete();
  });
});

describe("chamfer", () => {
  it("bevels a picked edge: a new flat face appears and the volume drops slightly", () => {
    const { edge } = refs(mm(60), mm(40), mm(30));
    const box = makeBox(oc, mm(60), mm(40), mm(30));
    const before = faceCount(box);
    const chamfered = chamfer(oc, box, [edge], mm(3));
    // The edge is replaced by a NEW planar bevel face — topology must change, not
    // just volume.
    expect(faceCount(chamfered)).toBeGreaterThan(before);
    expect(chamfered.volume()).toBeLessThan(box.volume());
    expect(chamfered.volume()).toBeGreaterThan(box.volume() * 0.95);
    box.delete();
    chamfered.delete();
  });
});

describe("shell", () => {
  it("hollows a box, opening the top face: inner walls appear with a real thickness", () => {
    const { top } = refs(mm(60), mm(40), mm(30));
    const box = makeBox(oc, mm(60), mm(40), mm(30));
    const before = faceCount(box);
    const hollow = shell(oc, box, [top], mm(3));
    // Carving the cavity adds inner-wall faces — the solid is genuinely hollow,
    // not merely smaller.
    expect(faceCount(hollow)).toBeGreaterThan(before);
    // The wall is a real 3 mm shell: an open-top 60×40×30 box keeps ≈0.31 of its
    // material (outer minus a 54×34×27 cavity). Bracketing the ratio fails both a
    // collapsed wall (≈0) and a barely-hollowed result (≈full) that >0 would miss.
    const ratio = hollow.volume() / box.volume();
    expect(ratio).toBeGreaterThan(0.2);
    expect(ratio).toBeLessThan(0.45);
    box.delete();
    hollow.delete();
  });
});

describe("partial-resolution safety (no silent partial dress-up)", () => {
  // A signature pointing along the cube diagonal matches no axis-aligned box
  // face/edge (dot ≈ 0.577 < the 0.999 face tolerance), so it never resolves.
  const bogusEdge: EdgeRef = {
    faceNormals: [
      [0.577, 0.577, 0.577],
      [0.577, 0.577, 0.577],
    ],
  };
  const bogusFace: FaceRef = { normal: [0.577, 0.577, 0.577] };

  it("fillet throws when ANY selected edge fails to resolve", () => {
    const { edge } = refs(mm(60), mm(40), mm(30));
    const box = makeBox(oc, mm(60), mm(40), mm(30));
    expect(() => fillet(oc, box, [edge, bogusEdge], mm(3))).toThrow(/did not resolve/);
    box.delete();
  });

  it("chamfer throws when ANY selected edge fails to resolve", () => {
    const { edge } = refs(mm(60), mm(40), mm(30));
    const box = makeBox(oc, mm(60), mm(40), mm(30));
    expect(() => chamfer(oc, box, [edge, bogusEdge], mm(3))).toThrow(/did not resolve/);
    box.delete();
  });

  it("shell throws when ANY selected open-face fails to resolve", () => {
    const { top } = refs(mm(60), mm(40), mm(30));
    const box = makeBox(oc, mm(60), mm(40), mm(30));
    expect(() => shell(oc, box, [top, bogusFace], mm(3))).toThrow(/did not resolve/);
    box.delete();
  });
});

describe("draft", () => {
  it("tapers a vertical side face, reducing the volume while preserving the face count", () => {
    const { side } = refs(mm(60), mm(40), mm(30));
    const box = makeBox(oc, mm(60), mm(40), mm(30));
    const before = faceCount(box);
    const drafted = draft(oc, box, {
      face: side,
      pullDirection: [0, 0, 1],
      neutralOrigin: [0, 0, 0],
      neutralNormal: [0, 0, 1],
      angle: (5 * Math.PI) / 180,
    });
    // Draft only TILTS the picked face about the neutral plane — it must not add
    // or drop faces (which would signal a botched operation), and it removes
    // material above the neutral plane.
    expect(faceCount(drafted)).toBe(before);
    expect(drafted.volume()).toBeLessThan(box.volume());
    expect(drafted.volume()).toBeGreaterThan(box.volume() * 0.9);
    box.delete();
    drafted.delete();
  });
});
