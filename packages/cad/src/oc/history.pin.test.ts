// §13.1 groundwork — PIN: prove `BRepTools_History` is actually CALLABLE in this wasm.
//
// FablesFindings.md §4.1 / §13.1: `BRepTools_History` is bound "as the basis for
// derivation-based naming" (occt.build.yml:114-122) yet has ZERO call sites in the
// whole repo. This build's embind is KNOWN to ship declared-but-uncallable methods
// — BOPAlgo_ArgumentAnalyzer's reference-returning setters degrade to read-only
// getters (boolean.ts:26-33), and `Standard_OStream`-taking methods are unbound
// (boolean.ts:34-37). A `.d.ts` declaration is therefore NOT proof of callability.
//
// Before any naming code is written we must PROVE, against the real kernel, that
// the three methods §13.1's remap depends on really dispatch to compiled C++ and
// return real `TopTools_ListOfShape` / booleans without throwing. Two history
// sources feed the remap and BOTH are pinned here:
//
//   • booleans   → BRepAlgoAPI_*::History() → Handle_BRepTools_History.get()
//                  → BRepTools_History.{Modified,Generated,IsRemoved}
//                  (the zero-call-site symbol itself).
//   • fillet/etc → BRepFilletAPI_* / BRepBuilderAPI_MakeShape
//                  ::{Modified,Generated,IsDeleted} directly on the maker
//                  (these makers expose no BRepTools_History object; IsDeleted is
//                  the maker's spelling of IsRemoved).
//
// The pins assert callability AND real content (a fuse actually modifies/removes
// faces; a fillet actually generates a face from its edge) — a method that were
// bound-but-inert would return empty and this would catch it.

import { beforeAll, describe, expect, it } from "vitest";

import { initOcct, type Occt } from "./init.js";
import { mm } from "../unit/index.js";
import { makeBox, makeBoxAt } from "../solid/primitives.js";
import { shapeEnums } from "../mesh/normals.js";
import type { ChFi3d_FilletShape } from "opencascade.js";

let oc: Occt;
beforeAll(async () => {
  oc = await initOcct();
}, 120_000);

describe("BRepTools_History callability (via a boolean)", () => {
  it("History().get() yields a BRepTools_History whose Modified/Generated/IsRemoved dispatch to real C++", () => {
    // Two 30 mm boxes overlapping in +X (A: 0..30, B: 15..45). A's +X face (x=30)
    // falls INSIDE the fused solid ⇒ it must be REMOVED; the coplanar bottom/top
    // faces are MODIFIED. So a correctly-wired history returns real content, not
    // just callable-but-empty stubs.
    const a = makeBox(oc, mm(30), mm(30), mm(30));
    const b = makeBoxAt(oc, [mm(15), mm(0), mm(0)], mm(30), mm(30), mm(30));
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
      expect(op.HasHistory()).toBe(true);

      // --- The load-bearing calls: History() → Handle → get() → BRepTools_History.
      const handle = op.History();
      expect(handle.IsNull(), "boolean must fill a non-null history handle").toBe(false);
      const history = handle.get();
      expect(history, "Handle_BRepTools_History.get() must yield a BRepTools_History").toBeTruthy();

      // HasModified/HasRemoved are cheap top-level proofs the object is live.
      expect(typeof history.HasModified()).toBe("boolean");
      expect(typeof history.HasRemoved()).toBe("boolean");

      // Walk EVERY face of operand A and call all three methods. None may throw.
      const S = shapeEnums(oc);
      const exp = new oc.TopExp_Explorer_2(a.shape, S.TopAbs_FACE, S.TopAbs_SHAPE);
      let anyModified = false;
      let anyRemoved = false;
      let facesSeen = 0;
      try {
        for (; exp.More(); exp.Next()) {
          const f = oc.TopoDS.Face_1(exp.Current());
          try {
            const modified = history.Modified(f);
            const generated = history.Generated(f);
            const removed = history.IsRemoved(f);
            // Callability proof: real return types, no throw.
            expect(typeof removed).toBe("boolean");
            expect(typeof modified.Size()).toBe("number");
            expect(typeof generated.Size()).toBe("number");
            expect(modified.Size()).toBeGreaterThanOrEqual(0);
            if (modified.Size() > 0) anyModified = true;
            if (removed) anyRemoved = true;
            modified.delete();
            generated.delete();
          } finally {
            f.delete();
          }
          facesSeen++;
        }
      } finally {
        exp.delete();
        handle.delete();
      }

      expect(facesSeen).toBe(6); // A is a box
      // Content proof: the fuse genuinely modified some faces and removed the
      // interior +X face. If Modified/IsRemoved were bound-but-inert both would be
      // false here and this fails — exactly the trap the pin exists to catch.
      expect(anyModified, "fuse must report at least one MODIFIED face of A").toBe(true);
      expect(anyRemoved, "fuse must report A's interior +X face as REMOVED").toBe(true);
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

describe("BRepBuilderAPI_MakeShape history callability (via a fillet maker)", () => {
  it("BRepFilletAPI_MakeFillet.{Generated,Modified,IsDeleted} dispatch to real C++", () => {
    const box = makeBox(oc, mm(40), mm(40), mm(40));
    const shapeType = oc.ChFi3d_FilletShape.ChFi3d_Rational as unknown as ChFi3d_FilletShape;
    const maker = new oc.BRepFilletAPI_MakeFillet(box.shape, shapeType);
    const S = shapeEnums(oc);
    // Grab the first B-rep edge of the box and round it.
    const eexp = new oc.TopExp_Explorer_2(box.shape, S.TopAbs_EDGE, S.TopAbs_SHAPE);
    const edge = oc.TopoDS.Edge_1(eexp.Current());
    eexp.delete();
    try {
      maker.Add_2(mm(4), edge);
      const result = maker.Shape(); // build must run before history is queried
      expect(result.IsNull()).toBe(false);

      // A fillet GENERATES a new face from the rounded edge — the maker's
      // Generated(edge) must return that face (non-empty), proving real content.
      const genFromEdge = maker.Generated(edge);
      expect(typeof genFromEdge.Size()).toBe("number");
      expect(genFromEdge.Size(), "fillet must GENERATE a face from its edge").toBeGreaterThan(0);
      genFromEdge.delete();

      // Modified/IsDeleted must be callable on the operand's faces without throwing.
      const fexp = new oc.TopExp_Explorer_2(box.shape, S.TopAbs_FACE, S.TopAbs_SHAPE);
      let anyModified = false;
      try {
        for (; fexp.More(); fexp.Next()) {
          const f = oc.TopoDS.Face_1(fexp.Current());
          try {
            const modified = maker.Modified(f);
            const deleted = maker.IsDeleted(f);
            expect(typeof deleted).toBe("boolean");
            expect(typeof modified.Size()).toBe("number");
            if (modified.Size() > 0) anyModified = true;
            modified.delete();
          } finally {
            f.delete();
          }
        }
      } finally {
        fexp.delete();
      }
      result.delete();
      // The two faces adjacent to the rounded edge are trimmed ⇒ MODIFIED.
      expect(anyModified, "fillet must report the edge's adjacent faces as MODIFIED").toBe(true);
    } finally {
      edge.delete();
      maker.delete();
      box.delete();
    }
  });
});
