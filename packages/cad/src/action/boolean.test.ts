// action/boolean — §2.2 robustness, against real OCCT.
//
// The defect these pin: BRepAlgoAPI returns the RAW boolean result, in which the
// operands' coincident faces survive as separate fragments. The audit's live
// repro — union of two flush 30 mm boxes → 10 faces, two of them coplanar +Z
// "top" halves — meant `resolveSelector(topFace)` picked ONE fragment, so "shell
// the top" / "fillet the top edges" / `largestPlanarFace` silently operated on
// half the face the user sees. Nothing errored; the geometry was just wrong.
//
// These tests assert the user-visible consequence (selection covers the WHOLE
// joined face) rather than only the face count, because the count alone would
// still pass if unification merged the wrong faces.

import { beforeAll, describe, expect, it } from "vitest";

import { initOcct, type Occt } from "../oc/init.js";
import { mm } from "../unit/index.js";
import { makeBox, makeBoxAt } from "../solid/primitives.js";
import { planeXY } from "../env/plane.js";
import { Sketch } from "../sketch/sketch.js";
import { shapeEnums } from "../mesh/normals.js";
import { tessellateTagged } from "../mesh/tessellate.js";
import { resolveSelector } from "../select/predicates.js";
import type { Solid } from "../solid/solid.js";
import { extrude } from "./extrude.js";
import { intersect, subtract, union, unionAll } from "./boolean.js";

let oc: Occt;
beforeAll(async () => {
  oc = await initOcct();
}, 120_000);

/** Count B-rep faces directly (independent of tessellation). */
function faceCount(solid: Solid): number {
  const S = shapeEnums(oc);
  const exp = new oc.TopExp_Explorer_2(solid.shape, S.TopAbs_FACE, S.TopAbs_SHAPE);
  let n = 0;
  while (exp.More()) {
    n++;
    exp.Next();
  }
  exp.delete();
  return n;
}

/**
 * Total triangle area of the face `topFace` resolves to, in m², plus its centroid.
 *
 * A FaceRef carries no faceId — it is a persistent SIGNATURE (normal + centroid +
 * analytic surface), so the resolved face is located by matching that centroid
 * against the mesh. The tessellation must use the same angular deflection
 * `resolveSelector` uses internally, or the two meshes' groups need not agree.
 */
function selectedTopFace(solid: Solid): { area: number; centroid: readonly number[] } {
  const mesh = tessellateTagged(oc, solid, { angularDeflection: 0.1 });
  const sel = resolveSelector(oc, solid, { kind: "topFace" });
  expect(sel.faces).toHaveLength(1);
  const ref = sel.faces[0]!;
  expect(ref.centroid, "a resolved FaceRef must carry its centroid").toBeDefined();
  const group = mesh.faceGroups.find(
    (g) =>
      Math.hypot(
        g.centroid[0] - ref.centroid![0],
        g.centroid[1] - ref.centroid![1],
        g.centroid[2] - ref.centroid![2],
      ) < 1e-12,
  );
  expect(group, "topFace must resolve to a real face group").toBeDefined();
  const { vertices, indices } = mesh;
  let area = 0;
  for (let i = group!.start; i < group!.start + group!.count; i += 3) {
    const p = (k: number): [number, number, number] => [
      vertices[indices[k]! * 3]!,
      vertices[indices[k]! * 3 + 1]!,
      vertices[indices[k]! * 3 + 2]!,
    ];
    const [a, b, c] = [p(i), p(i + 1), p(i + 2)];
    const u: [number, number, number] = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const v: [number, number, number] = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    area +=
      0.5 *
      Math.hypot(
        u[1] * v[2] - u[2] * v[1],
        u[2] * v[0] - u[0] * v[2],
        u[0] * v[1] - u[1] * v[0],
      );
  }
  return { area, centroid: group!.centroid };
}

/** A cylinder of `radius` and height `h`, axis +Z, centred at (cx, cy). */
function cylinder(cx: number, cy: number, radius: number, h: number): Solid {
  return extrude(oc, Sketch.circle(planeXY(), cx, cy, radius), h);
}

describe("§2.2 booleans unify coplanar faces", () => {
  it("a flush union yields the SIX faces of the merged box, not ten fragments", () => {
    // Two 30 mm cubes flush at x=30 form one 60×30×30 box. The audit measured the
    // raw fuse at 10 faces (the shared top/bottom/front/back each split in two).
    const a = makeBox(oc, mm(30), mm(30), mm(30));
    const b = makeBoxAt(oc, [mm(30), 0, 0], mm(30), mm(30), mm(30));
    const u = union(oc, a, b);
    expect(u.ok).toBe(true);
    if (!u.ok) return;

    expect(faceCount(u.solid)).toBe(6);
    expect(u.lumps).toBe(1);
    // Unification must not change the geometry it merges.
    expect(u.solid.volume()).toBeCloseTo(2 * mm(30) ** 3, 12);
    expect(u.solid.isValid()).toBe(true);
    // Bounding boxes are asserted at 1e-6, not tighter: BRepBndLib includes the
    // shape's vertex tolerance, so EVERY box — even a primitive that saw no
    // boolean — reports its extent padded by Precision::Confusion (1e-7 m).
    // (Volume, above, is exact and is the real geometric check.)
    const bb = u.solid.boundingBox();
    expect(bb.max[0]).toBeCloseTo(mm(60), 6);
    expect(bb.max[1]).toBeCloseTo(mm(30), 6);
    expect(bb.max[2]).toBeCloseTo(mm(30), 6);

    u.solid.delete();
    b.delete();
    a.delete();
  });

  it("topFace selects the WHOLE joined face — the fragment defect, measured", () => {
    // THE user-visible bug: pre-fix, topFace resolved to one 30×30 fragment, so
    // shell/fillet silently acted on half the top. It must now cover 60×30.
    const a = makeBox(oc, mm(30), mm(30), mm(30));
    const b = makeBoxAt(oc, [mm(30), 0, 0], mm(30), mm(30), mm(30));
    const u = union(oc, a, b);
    expect(u.ok).toBe(true);
    if (!u.ok) return;

    const top = selectedTopFace(u.solid);
    // The whole 60×30 top, not a 30×30 fragment.
    expect(top.area).toBeCloseTo(mm(60) * mm(30), 9);
    // And it is centred on the MERGED face: a surviving fragment would sit at
    // x=15 or x=45, so this pins WHICH face was selected, not just its size.
    expect(top.centroid[0]).toBeCloseTo(mm(30), 6);
    expect(top.centroid[1]).toBeCloseTo(mm(15), 6);
    expect(top.centroid[2]).toBeCloseTo(mm(30), 6);

    u.solid.delete();
    b.delete();
    a.delete();
  });

  it("keeps genuinely distinct faces apart (an L-shaped union is not over-merged)", () => {
    // Guard against the opposite error: UnifySameDomain must merge only SAME-
    // surface faces. An L keeps its two different-height top faces separate.
    const a = makeBox(oc, mm(60), mm(30), mm(10));
    const b = makeBox(oc, mm(20), mm(30), mm(40));
    const u = union(oc, a, b);
    expect(u.ok).toBe(true);
    if (!u.ok) return;

    // An L-prism has 8 faces; over-merging would drop below that.
    expect(faceCount(u.solid)).toBe(8);
    expect(u.solid.volume()).toBeCloseTo(mm(60) * mm(30) * mm(10) + mm(20) * mm(30) * mm(30), 12);
    expect(u.solid.isValid()).toBe(true);

    u.solid.delete();
    b.delete();
    a.delete();
  });

  it("merges the two half-cylinders of a through-hole wall into one face", () => {
    // OCCT splits a full cylindrical wall at its seam; unification restores the
    // single analytic face a §2.1 FaceRef then identifies by radius+axis.
    const plate = makeBox(oc, mm(40), mm(30), mm(20));
    const tool = cylinder(mm(20), mm(15), mm(8), mm(20));
    const r = subtract(oc, plate, tool);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const mesh = tessellateTagged(oc, r.solid, { linearDeflection: 5e-4 });
    const walls = mesh.faceGroups.filter((g) => g.surface.kind === "cylinder");
    expect(walls, "the hole wall must be ONE cylindrical face").toHaveLength(1);
    expect(r.lumps).toBe(1);
    expect(r.solid.volume()).toBeCloseTo(
      mm(40) * mm(30) * mm(20) - Math.PI * mm(8) ** 2 * mm(20),
      10,
    );

    r.solid.delete();
    tool.delete();
    plate.delete();
  });
});

describe("§2.2 booleans report structure and survive hard operands", () => {
  it("reports lumps=2 when a cut SPLITS a body instead of pretending it is one solid", () => {
    // A slab cut clean through the middle leaves two disjoint lumps in a compound.
    // Downstream code assumes one solid, so the count is surfaced (not rejected:
    // a split is legitimate — cf. §4.2's over-strict lumps!==1 rejection).
    const bar = makeBox(oc, mm(60), mm(10), mm(10));
    const knife = makeBoxAt(oc, [mm(25), -mm(5), -mm(5)], mm(10), mm(20), mm(20));
    const r = subtract(oc, bar, knife);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.lumps).toBe(2);
    expect(r.solid.volume()).toBeCloseTo(2 * mm(25) * mm(10) * mm(10), 12);

    r.solid.delete();
    knife.delete();
    bar.delete();
  });

  it("intersecting DISJOINT solids succeeds with an empty result, and does not crash", () => {
    const a = makeBox(oc, mm(10), mm(10), mm(10));
    const b = makeBoxAt(oc, [mm(50), 0, 0], mm(10), mm(10), mm(10));
    const r = intersect(oc, a, b);
    // OCCT returns an empty compound rather than failing; either is acceptable,
    // but it must never report a phantom volume.
    if (r.ok) {
      expect(r.lumps).toBe(0);
      expect(r.solid.volume()).toBeCloseTo(0, 12);
      r.solid.delete();
    }
    b.delete();
    a.delete();
  });

  it("unions TANGENT cylinders (the classic fuzzy-tolerance failure) without error", () => {
    // Two cylinders touching along exactly one line: the operands meet at a
    // measure-zero contact, historically where booleans throw or emit slivers.
    const c1 = cylinder(0, 0, mm(10), mm(20));
    const c2 = cylinder(mm(20), 0, mm(10), mm(20));
    const u = union(oc, c1, c2);
    expect(u.ok).toBe(true);
    if (!u.ok) return;

    expect(u.solid.volume()).toBeCloseTo(2 * Math.PI * mm(10) ** 2 * mm(20), 9);
    expect(u.solid.isValid()).toBe(true);

    u.solid.delete();
    c2.delete();
    c1.delete();
  });

  it("SetNonDestructive: the operands are unchanged and still usable afterwards", () => {
    // NonDestructive() defaults to FALSE in OCCT, so this is a real behaviour
    // change: the rebuild accumulator and the hole/pattern loops reuse the same
    // Solid across successive booleans and must not see it mutated underneath.
    const a = makeBox(oc, mm(30), mm(30), mm(30));
    const b = makeBoxAt(oc, [mm(15), 0, 0], mm(30), mm(30), mm(30));
    const beforeA = a.volume();
    const beforeB = b.volume();

    const u = union(oc, a, b);
    expect(u.ok).toBe(true);
    if (u.ok) u.solid.delete();

    expect(a.volume()).toBeCloseTo(beforeA, 12);
    expect(b.volume()).toBeCloseTo(beforeB, 12);
    // Still usable as an operand for a SECOND boolean.
    const s = subtract(oc, a, b);
    expect(s.ok).toBe(true);
    if (s.ok) {
      expect(s.solid.volume()).toBeCloseTo(mm(15) * mm(30) * mm(30), 12);
      s.solid.delete();
    }
    b.delete();
    a.delete();
  });
});

describe("§2.2 unionAll — N-ary fuse in one pass", () => {
  it("fuses four flush cubes into one 120×30×30 box with six faces", () => {
    // Pairwise folding re-runs the intersection machinery on the growing
    // accumulator N−1 times; one N-ary call does it in a single pass.
    const cubes = [0, 1, 2, 3].map((i) =>
      makeBoxAt(oc, [i * mm(30), 0, 0], mm(30), mm(30), mm(30)),
    );
    const u = unionAll(oc, cubes);
    expect(u.ok).toBe(true);
    if (!u.ok) return;

    expect(u.lumps).toBe(1);
    expect(faceCount(u.solid)).toBe(6);
    expect(u.solid.volume()).toBeCloseTo(4 * mm(30) ** 3, 12);
    expect(u.solid.boundingBox().max[0]).toBeCloseTo(mm(120), 6);

    u.solid.delete();
    cubes.forEach((c) => c.delete());
  });

  it("a single solid returns an independent copy; disjoint operands report their lumps", () => {
    const only = makeBox(oc, mm(10), mm(10), mm(10));
    const one = unionAll(oc, [only]);
    expect(one.ok).toBe(true);
    if (one.ok) {
      expect(one.solid.volume()).toBeCloseTo(mm(10) ** 3, 12);
      // A copy, not the input: deleting it must leave `only` usable.
      one.solid.delete();
      expect(only.volume()).toBeCloseTo(mm(10) ** 3, 12);
    }
    only.delete();

    const far = [0, 1, 2].map((i) => makeBoxAt(oc, [i * mm(50), 0, 0], mm(10), mm(10), mm(10)));
    const u = unionAll(oc, far);
    expect(u.ok).toBe(true);
    if (u.ok) {
      expect(u.lumps).toBe(3);
      u.solid.delete();
    }
    far.forEach((c) => c.delete());
  });

  it("rejects an empty operand list rather than returning a phantom solid", () => {
    const r = unionAll(oc, []);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/no solids/);
  });
});
