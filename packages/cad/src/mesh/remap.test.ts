// mesh/remap — §13.1 derivation-based naming, against the REAL OCCT wasm.
//
// Proves `faceIdRemap` turns a build step's shape history into a coherent
// oldFaceId → newFaceId map, over BOTH history sources §13.1 names:
//   1. a fillet maker (BRepBuilderAPI_MakeShape.{Modified,Generated,IsDeleted},
//      adapted IsDeleted → IsRemoved) — the dress-up path;
//   2. a boolean's BRepTools_History (BRepAlgoAPI_Fuse::History().get()) — the
//      symbol bound "as the basis for derivation-based naming", pinned callable in
//      oc/history.pin.test.ts, driven end-to-end through the remap here.
//
// The callability of these methods is a SEPARATE pin (history.pin.test.ts); this
// file assumes it and tests the map the remap builds on top.

import { beforeAll, describe, expect, it } from "vitest";
import type { ChFi3d_FilletShape } from "opencascade.js";

import { initOcct, type Occt } from "../oc/init.js";
import { mm } from "../unit/index.js";
import { makeBox, makeBoxAt } from "../solid/primitives.js";
import { Solid } from "../solid/solid.js";
import { shapeEnums } from "./normals.js";
import { tessellateTagged } from "./tessellate.js";
import { FACE_REMOVED, faceIdRemap, type ShapeHistory } from "./remap.js";

let oc: Occt;
beforeAll(async () => {
  oc = await initOcct();
}, 120_000);

/** faceId of the box face whose outward normal points along `axis` (±1 on one component). */
function faceIdByNormal(
  groups: { faceId: number; normal: readonly [number, number, number] }[],
  axis: 0 | 1 | 2,
  sign: 1 | -1,
): number {
  const g = groups.find((gr) => Math.round(gr.normal[axis]) === sign);
  if (!g) throw new Error(`no face with normal ${sign} on axis ${axis}`);
  return g.faceId;
}

describe("faceIdRemap — dress-up history (fillet)", () => {
  it("maps every box face to its filleted-body successor; the generated face is a new cylinder", () => {
    const box = makeBox(oc, mm(40), mm(40), mm(40));
    const prevMesh = tessellateTagged(oc, box);
    expect(prevMesh.faceGroups).toHaveLength(6); // a box has six planar faces

    // Fillet the first B-rep edge, keeping the maker alive so its history is
    // queryable. The maker exposes {Modified,Generated,IsDeleted}; adapt IsDeleted
    // → IsRemoved to satisfy ShapeHistory (OCCT's maker-side spelling of removal).
    const shapeType = oc.ChFi3d_FilletShape.ChFi3d_Rational as unknown as ChFi3d_FilletShape;
    const maker = new oc.BRepFilletAPI_MakeFillet(box.shape, shapeType);
    const S = shapeEnums(oc);
    const eexp = new oc.TopExp_Explorer_2(box.shape, S.TopAbs_EDGE, S.TopAbs_SHAPE);
    const edge = oc.TopoDS.Edge_1(eexp.Current());
    eexp.delete();
    maker.Add_2(mm(4), edge);
    edge.delete();

    const result = new Solid(oc, maker.Shape());
    const history: ShapeHistory = {
      Modified: (s) => maker.Modified(s),
      Generated: (s) => maker.Generated(s),
      IsRemoved: (s) => maker.IsDeleted(s),
    };

    try {
      const curMesh = tessellateTagged(oc, result);
      // Box(6) → filleted(7): the two faces on the rounded edge are trimmed (still
      // present) and ONE new cylindrical fillet face appears.
      expect(curMesh.faceGroups).toHaveLength(7);

      const map = faceIdRemap(oc, prevMesh, box, curMesh, result, history);

      // Every one of the 6 old faces resolves (none removed by a fillet).
      expect(map.size).toBe(6);
      for (const [, nid] of map) expect(nid).not.toBe(FACE_REMOVED);

      // The 6 successors are DISTINCT valid current faceIds …
      const values = [...map.values()];
      expect(new Set(values).size).toBe(6);
      for (const v of values) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThan(7);
      }

      // … and each carries the SAME analytic surface as the old face it came from
      // (a trimmed plane is still that plane; an unchanged face is unchanged).
      for (const [oldId, nid] of map) {
        expect(prevMesh.faceGroups[oldId]!.surface.kind).toBe("plane");
        expect(curMesh.faceGroups[nid]!.surface.kind).toBe("plane");
      }

      // Exactly one current face is NOT a successor of any old face — the GENERATED
      // fillet face — and it is a cylinder (the rounded edge became a cylindrical wall).
      const unmapped = curMesh.faceGroups.map((g) => g.faceId).filter((id) => !values.includes(id));
      expect(unmapped).toHaveLength(1);
      expect(curMesh.faceGroups[unmapped[0]!]!.surface.kind).toBe("cylinder");
    } finally {
      // maker must outlive every history query above.
      maker.delete();
      result.delete();
      box.delete();
    }
  });

  it("falls back to analytic-signature matching when no history is supplied", () => {
    // Same fillet, but call the remap WITHOUT history (the R1 path §13.1 keeps for
    // history-less steps). The four faces NOT on the rounded edge are unchanged, so
    // signature matching must still re-anchor them exactly.
    const box = makeBox(oc, mm(40), mm(40), mm(40));
    const prevMesh = tessellateTagged(oc, box);
    const shapeType = oc.ChFi3d_FilletShape.ChFi3d_Rational as unknown as ChFi3d_FilletShape;
    const maker = new oc.BRepFilletAPI_MakeFillet(box.shape, shapeType);
    const S = shapeEnums(oc);
    const eexp = new oc.TopExp_Explorer_2(box.shape, S.TopAbs_EDGE, S.TopAbs_SHAPE);
    const edge = oc.TopoDS.Edge_1(eexp.Current());
    eexp.delete();
    maker.Add_2(mm(4), edge);
    edge.delete();
    const result = new Solid(oc, maker.Shape());
    try {
      const curMesh = tessellateTagged(oc, result);
      const map = faceIdRemap(oc, prevMesh, box, curMesh, result, undefined);
      // No history ⇒ every face resolved by signature (a box fillet has no shared-
      // surface ambiguity), so all 6 map to a distinct current face.
      expect(map.size).toBe(6);
      expect(new Set(map.values()).size).toBe(6);
      for (const [oldId, nid] of map) {
        // A signature match must land on a face sharing the old face's surface kind.
        expect(curMesh.faceGroups[nid]!.surface.kind).toBe(prevMesh.faceGroups[oldId]!.surface.kind);
      }
    } finally {
      maker.delete();
      result.delete();
      box.delete();
    }
  });
});

describe("faceIdRemap — boolean history (BRepTools_History)", () => {
  it("re-anchors a fused body's faces and marks the consumed interior face REMOVED", () => {
    // A: x 0..30, B: x 15..45 (equal y,z extent). A's +X face (x=30) lies wholly
    // inside the fused solid ⇒ REMOVED; A's -X face (x=0) survives on the boundary.
    const a = makeBox(oc, mm(30), mm(30), mm(30));
    const b = makeBoxAt(oc, [mm(15), mm(0), mm(0)], mm(30), mm(30), mm(30));
    const prevMesh = tessellateTagged(oc, a);
    const plusXId = faceIdByNormal(prevMesh.faceGroups, 0, 1); // interior after the fuse
    const minusXId = faceIdByNormal(prevMesh.faceGroups, 0, -1); // survives

    const argList = new oc.TopTools_ListOfShape_1();
    const toolList = new oc.TopTools_ListOfShape_1();
    const range = new oc.Message_ProgressRange_1();
    const op = new oc.BRepAlgoAPI_Fuse_1();
    try {
      argList.Append_1(a.shape);
      toolList.Append_1(b.shape);
      op.SetArguments(argList);
      op.SetTools(toolList);
      op.SetFuzzyValue(1e-7);
      op.SetNonDestructive(true);
      op.SetToFillHistory(true);
      op.Build(range);
      expect(op.IsDone()).toBe(true);
      expect(op.HasErrors()).toBe(false);

      // Raw fused result (no UnifySameDomain — its history is a SEPARATE object;
      // here we walk the fuse's own BRepTools_History).
      const result = new Solid(oc, op.Shape());
      const handle = op.History();
      const history = handle.get(); // real BRepTools_History (structurally a ShapeHistory)
      try {
        const curMesh = tessellateTagged(oc, result);
        const map = faceIdRemap(oc, prevMesh, a, curMesh, result, history);

        // The interior +X face was consumed by the union.
        expect(map.get(plusXId)).toBe(FACE_REMOVED);

        // The boundary -X face survives and re-anchors to a real current face …
        const minusXNew = map.get(minusXId);
        expect(minusXNew).toBeDefined();
        expect(minusXNew).not.toBe(FACE_REMOVED);
        expect(minusXNew).toBeGreaterThanOrEqual(0);
        // … whose surface is still that same -X plane.
        expect(curMesh.faceGroups[minusXNew!]!.surface.kind).toBe("plane");

        // At least the one interior face is reported removed — proving the real
        // BRepTools_History.IsRemoved drove the FACE_REMOVED branch.
        expect([...map.values()].filter((v) => v === FACE_REMOVED).length).toBeGreaterThanOrEqual(1);

        result.delete();
      } finally {
        handle.delete();
      }
    } finally {
      op.delete();
      range.delete();
      toolList.delete();
      argList.delete();
      a.delete();
      b.delete();
    }
  });
});
