// Heap-leak gate for the M3/M4 geometry ops (SPEC-4 R5 / DoD item 6 / NFR-2).
// Every ocjs handle a feature allocates must be freed; repeated build/delete
// cycles of the new ops (loft, sweep, shape-lowering, hierarchy export) must not
// grow the WASM heap. Mirrors the M0 arena leak test.

import { beforeAll, describe, expect, it } from "vitest";
import { loft } from "./action/loft.js";
import { sweep } from "./action/sweep.js";
import { offsetPlane, planeXY, planeYZ } from "./environment/plane.js";
import { makeBody } from "./hierarchy/body.js";
import { Component } from "./hierarchy/component.js";
import { exportForSim } from "./lower/export.js";
import { lowerShape } from "./lower/shape.js";
import { defaultLibrary } from "./material/library.js";
import { initOcct, type Occt } from "./oc/init.js";
import { makeBox } from "./solid/primitives.js";
import { Sketch } from "./sketch/sketch.js";
import { mm } from "./unit/index.js";

const INIT_TIMEOUT_MS = 120_000;

describe("M3/M4 heap-leak gate (R5)", () => {
  let oc: Occt;
  beforeAll(async () => {
    oc = await initOcct();
  }, INIT_TIMEOUT_MS);

  const heap = (): number => (oc as unknown as { HEAP8: { byteLength: number } }).HEAP8.byteLength;

  function cycle(): void {
    // loft
    const lofted = loft(
      oc,
      [
        Sketch.rectangle(planeXY(), mm(20), mm(20)),
        Sketch.rectangle(offsetPlane(planeXY(), mm(30)), mm(10), mm(10)),
      ],
      { ruled: true },
    );
    lofted.delete();
    // sweep
    const swept = sweep(oc, Sketch.rectangle(planeYZ(), mm(10), mm(10)), {
      kind: "polyline",
      points: [
        [0, 0, 0],
        [0.05, 0, 0],
      ],
    });
    swept.delete();
    // shape lowering (tessellation + convex hull) + export
    const box = makeBox(oc, mm(15), mm(15), mm(15));
    try {
      lowerShape(oc, box); // box → box (primitive fit)
      const root = new Component("c");
      const b = makeBody("b", "aluminum-6061");
      b.geometry = box;
      root.addBody(b);
      exportForSim(oc, root, defaultLibrary(), "leak");
    } finally {
      box.delete();
    }
  }

  it("repeated loft/sweep/lower/export cycles do not grow the WASM heap", () => {
    cycle(); // warm up (first allocation may grow the heap once)
    const before = heap();
    for (let i = 0; i < 40; i++) cycle();
    expect(heap()).toBe(before);
  });
});
