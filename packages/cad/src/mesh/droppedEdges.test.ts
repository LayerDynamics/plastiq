// droppedEdges + compact edgeId — REAL OCCT wasm. A complete (valid) solid
// tessellates with zero dropped edges, and the emitted edges carry compact
// consecutive edgeIds (`edges[e.edgeId] === e`) — the invariant the viewport's
// pick Record and the per-mesh transient ids rely on.

import { beforeAll, describe, expect, it } from "vitest";

import { initOcct, type Occt } from "../oc/init.js";
import { mm } from "../unit/index.js";
import { makeBox } from "../solid/primitives.js";
import { planeXZ } from "../env/plane.js";
import { Sketch } from "../sketch/sketch.js";
import { revolve } from "../action/revolve.js";
import { tessellateTagged } from "./tessellate.js";

let oc: Occt;

beforeAll(async () => {
  oc = await initOcct();
}, 120_000);

describe("droppedEdges on complete solids", () => {
  it("a box reports droppedEdges = 0 with compact consecutive edgeIds", () => {
    const box = makeBox(oc, mm(20), mm(30), mm(40));
    const mesh = tessellateTagged(oc, box);

    expect(mesh.droppedFaces).toBe(0);
    expect(mesh.droppedEdges).toBe(0);
    expect(mesh.edges).toHaveLength(12);
    mesh.edges.forEach((e, i) => expect(e.edgeId).toBe(i));
    box.delete();
  });

  it("a revolved ring (curved faces + seams) also reports droppedEdges = 0, ids compact", () => {
    const sk = new Sketch(planeXZ());
    sk.lineTo(mm(10), 0);
    sk.lineTo(mm(20), 0);
    sk.lineTo(mm(20), mm(30));
    sk.lineTo(mm(10), mm(30));
    const ring = revolve(oc, sk, [0, 0, 0], [0, 0, 1], 2 * Math.PI);
    const mesh = tessellateTagged(oc, ring);

    expect(mesh.droppedFaces).toBe(0);
    expect(mesh.droppedEdges).toBe(0);
    expect(mesh.edges.length).toBeGreaterThan(0);
    mesh.edges.forEach((e, i) => expect(e.edgeId).toBe(i));
    ring.delete();
  });
});
