// §C10 — edge-case / pathological-input coverage for the kernel feature ops,
// against the real OCCT wasm. Degenerate inputs must fail loud (not return silent
// garbage geometry); boundary-but-valid inputs must produce the right result; and
// persistent refs must survive a topology-changing op.

import { beforeAll, describe, expect, it } from "vitest";

import { initOcct, type Occt } from "../oc/init.js";
import { mm } from "../unit/index.js";
import { makeBox } from "../solid/primitives.js";
import { planeXY, planeXZ } from "../env/plane.js";
import { Sketch } from "../sketch/sketch.js";
import { tessellateTagged } from "../mesh/tessellate.js";
import { resolveFaceRef } from "../mesh/resolve.js";
import { faceNormal } from "../mesh/normals.js";
import type { EdgeRef, FaceRef } from "../mesh/tagged.js";
import { extrude, fillet, linearPattern, revolve, shell, sweep } from "./index.js";
import { importStep } from "../io/index.js";

let oc: Occt;

beforeAll(async () => {
  oc = await initOcct();
}, 120_000);

function rect(u0: number, v0: number, u1: number, v1: number): Sketch {
  const sk = new Sketch(planeXY());
  sk.lineTo(u0, v0);
  sk.lineTo(u1, v0);
  sk.lineTo(u1, v1);
  sk.lineTo(u0, v1);
  return sk;
}

/** A rectangular profile on XZ for revolve. */
function annulusProfile(): Sketch {
  const sk = new Sketch(planeXZ());
  sk.lineTo(mm(10), 0);
  sk.lineTo(mm(20), 0);
  sk.lineTo(mm(20), mm(30));
  sk.lineTo(mm(10), mm(30));
  return sk;
}

/** The +Z top FaceRef of a dx×dy×dz box. */
function topFace(dx: number, dy: number, dz: number): FaceRef {
  const box = makeBox(oc, dx, dy, dz);
  const mesh = tessellateTagged(oc, box);
  const top: FaceRef = { normal: mesh.faceGroups.find((g) => Math.round(g.normal[2]) === 1)!.normal };
  box.delete();
  return top;
}

describe("pathological inputs fail loud (no silent degenerate geometry)", () => {
  it("a zero-height extrude throws", () => {
    expect(() => extrude(oc, rect(0, 0, mm(20), mm(20)), 0)).toThrow(/height/);
  });

  it("a zero-angle revolve throws", () => {
    expect(() => revolve(oc, annulusProfile(), [0, 0, 0], [0, 0, 1], 0)).toThrow(/angle/);
  });

  it("a shell thickness exceeding the wall throws (cannot hollow)", () => {
    const top = topFace(mm(20), mm(20), mm(20));
    const box = makeBox(oc, mm(20), mm(20), mm(20));
    // 50 mm thickness on a 20 mm box has no room for a wall.
    expect(() => shell(oc, box, [top], mm(50))).toThrow();
    box.delete();
  });

  it("importing malformed STEP text throws", () => {
    expect(() => importStep(oc, "this is definitely not a STEP file")).toThrow();
  });

  it("a single-point sweep spine throws", () => {
    const profile = Sketch.circle(planeXY(), 0, 0, mm(5));
    expect(() => sweep(oc, profile, { kind: "polyline", points: [[0, 0, 0]] })).toThrow(
      /at least two points/,
    );
  });

  it("a zero-length sweep spine (all points coincide) throws", () => {
    const profile = Sketch.circle(planeXY(), 0, 0, mm(5));
    // Two points but identical — a degenerate zero-length path. The length check
    // passes (2 points), so the spine builder must reject the empty geometry.
    expect(() =>
      sweep(oc, profile, {
        kind: "polyline",
        points: [
          [0, 0, 0],
          [0, 0, 0],
        ],
      }),
    ).toThrow(/zero-length spine/);
  });
});

describe("boundary-but-valid inputs produce the expected result", () => {
  it("a count=1 linear pattern returns exactly the base part", () => {
    const box = makeBox(oc, mm(20), mm(20), mm(20));
    const copies = linearPattern(oc, box, [1, 0, 0], mm(20), 1);
    expect(copies).toHaveLength(1);
    expect(copies[0]!.volume()).toBeCloseTo(box.volume(), 9);
    copies.forEach((c) => c.delete());
    box.delete();
  });

  it("a sweep along a COLLINEAR multi-point spine sweeps the full length", () => {
    const profile = Sketch.circle(planeXY(), 0, 0, mm(5));
    // Three collinear points = one 60 mm run; MakePipe handles this correctly.
    const solid = sweep(oc, profile, {
      kind: "polyline",
      points: [
        [0, 0, 0],
        [0, 0, mm(30)],
        [0, 0, mm(60)],
      ],
    });
    expect(solid.volume()).toBeCloseTo(Math.PI * mm(5) ** 2 * mm(60), 8);
    solid.delete();
  });

  it("a sweep along a SHARP-cornered spine sweeps the FULL path (both segments, not just the first)", () => {
    const profile = Sketch.circle(planeXY(), 0, 0, mm(5));
    // A 90° corner between two equal 50 mm runs. BRepOffsetAPI_MakePipe only swept
    // the first edge (≈ one segment); MakePipeShell sweeps both with a mitered
    // corner — so the volume is well above one segment and near (a little under,
    // from the corner miter) two full straight segments.
    const solid = sweep(oc, profile, {
      kind: "polyline",
      points: [
        [0, 0, 0],
        [0, 0, mm(50)],
        [0, mm(50), mm(50)],
      ],
    });
    const oneSegment = Math.PI * mm(5) ** 2 * mm(50); // ≈ 3.93e-6 — the old buggy result
    const twoStraight = Math.PI * mm(5) ** 2 * mm(100); // ≈ 7.85e-6 — both full segments
    expect(solid.volume()).toBeGreaterThan(oneSegment * 1.5);
    expect(solid.volume()).toBeLessThan(twoStraight * 1.05);
    solid.delete();
  });
});

describe("persistent refs survive a topology-changing op", () => {
  it("a captured +Z FaceRef still resolves after a fillet rounds an edge away", () => {
    const a = makeBox(oc, mm(40), mm(40), mm(40));
    const meshA = tessellateTagged(oc, a);
    const top: FaceRef = { normal: meshA.faceGroups.find((g) => Math.round(g.normal[2]) === 1)!.normal };
    const edge: EdgeRef = { faceNormals: meshA.edges[0]!.faceNormals };
    a.delete();

    // Fillet rounds an edge into a new cylindrical face — a genuine topology change.
    const b = makeBox(oc, mm(40), mm(40), mm(40));
    const filleted = fillet(oc, b, [edge], mm(5));
    b.delete();

    const face = resolveFaceRef(oc, filleted, top);
    expect(face).not.toBeNull();
    expect(Math.round(faceNormal(oc, face!)[2])).toBe(1); // still the +Z top
    face!.delete();
    filleted.delete();
  });
});
