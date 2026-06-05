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

describe("fillet", () => {
  it("rounds a picked edge, slightly reducing the box volume", () => {
    const { edge } = refs(mm(60), mm(40), mm(30));
    const box = makeBox(oc, mm(60), mm(40), mm(30));
    const filleted = fillet(oc, box, [edge], mm(3));
    expect(filleted.volume()).toBeLessThan(box.volume());
    expect(filleted.volume()).toBeGreaterThan(box.volume() * 0.95);
    box.delete();
    filleted.delete();
  });
});

describe("chamfer", () => {
  it("bevels a picked edge, slightly reducing the box volume", () => {
    const { edge } = refs(mm(60), mm(40), mm(30));
    const box = makeBox(oc, mm(60), mm(40), mm(30));
    const chamfered = chamfer(oc, box, [edge], mm(3));
    expect(chamfered.volume()).toBeLessThan(box.volume());
    expect(chamfered.volume()).toBeGreaterThan(box.volume() * 0.95);
    box.delete();
    chamfered.delete();
  });
});

describe("shell", () => {
  it("hollows a box, opening the top face (wall thickness preserved)", () => {
    const { top } = refs(mm(60), mm(40), mm(30));
    const box = makeBox(oc, mm(60), mm(40), mm(30));
    const hollow = shell(oc, box, [top], mm(3));
    // A hollow box is much lighter than the solid one.
    expect(hollow.volume()).toBeLessThan(box.volume() * 0.6);
    expect(hollow.volume()).toBeGreaterThan(0);
    box.delete();
    hollow.delete();
  });
});

describe("draft", () => {
  it("tapers a vertical side face, reducing the box volume", () => {
    const { side } = refs(mm(60), mm(40), mm(30));
    const box = makeBox(oc, mm(60), mm(40), mm(30));
    const drafted = draft(oc, box, {
      face: side,
      pullDirection: [0, 0, 1],
      neutralOrigin: [0, 0, 0],
      neutralNormal: [0, 0, 1],
      angle: (5 * Math.PI) / 180,
    });
    expect(drafted.volume()).toBeLessThan(box.volume());
    expect(drafted.volume()).toBeGreaterThan(box.volume() * 0.9);
    box.delete();
    drafted.delete();
  });
});
