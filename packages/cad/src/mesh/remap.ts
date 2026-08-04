// mesh/remap.ts — §13.1 derivation-based naming (the deep fix under R1).
//
// A history-capable op (booleans via BRepAlgoAPI_*::History(); fillet/chamfer/
// shell/draft via the BRepBuilderAPI_MakeShape maker) knows EXACTLY how each
// input subshape maps into its result: a face is Modified (trimmed/split into new
// faces), Generated (new faces born from it), or IsRemoved (consumed). This module
// turns that history into an `oldFaceId → newFaceId` map so a persistent FaceRef
// captured on the previous body can be re-anchored to the same face on the new
// body WITHOUT a centroid tie-break — the ambiguous case §4.1 / resolve.ts:66-67
// documents (two faces sharing one analytic surface, e.g. through-hole walls).
//
// faceIds here are the SAME transient ids `tessellateTagged` assigns (tagged.ts /
// tessellate.ts:97-159): the render-group index among faces that carry a
// triangulation, in TopExp_Explorer order, dropped (un-triangulated) faces
// skipped. `orderedFaceHandles` reproduces that exact numbering so a B-rep face
// handle can be named by its faceId.
//
// The callability of BRepTools_History.{Modified,Generated,IsRemoved} in this wasm
// is PROVEN in oc/history.pin.test.ts (the symbol was bound "as the basis for
// derivation-based naming" but had zero call sites — a .d.ts declaration is not
// proof against this build's declared-but-uncallable embind methods).

import type { TopoDS_Face, TopoDS_Shape, TopTools_ListOfShape } from "opencascade.js";

import type { Occt } from "../oc/init.js";
import type { Solid } from "../solid/solid.js";
import { MESH_PURPOSE, shapeEnums } from "./normals.js";
import { surfacesMatch } from "./surface.js";
import type { FaceGroup, TaggedMesh } from "./tagged.js";

/**
 * Sentinel `newFaceId` meaning the previous face was REMOVED by the op
 * (`history.IsRemoved` returned true) — it has no successor on the new body. It is
 * kept in the returned map (rather than omitted) so a caller can DISTINGUISH
 * "this face was consumed" from "this face's id was never queried", and drop or
 * flag any stored ref that pointed at it instead of silently re-matching it to an
 * unrelated face.
 */
export const FACE_REMOVED = -1;

/**
 * The subset of a shape-history object the remap needs.
 *
 * Satisfied STRUCTURALLY by `BRepTools_History` — the object a boolean yields via
 * `BRepAlgoAPI_*::History().get()`, whose three methods are pinned callable in
 * oc/history.pin.test.ts. The dress-up makers (BRepFilletAPI_* / BRepOffsetAPI_*,
 * all BRepBuilderAPI_MakeShape) expose the same operations as
 * `{Modified, Generated, IsDeleted}`; the main-loop wiring that makes those ops
 * RETURN `{solid, history}` adapts `IsDeleted → IsRemoved` (OCCT's maker-side
 * spelling) when it passes one here — see remap.test.ts for that adapter driven by
 * a real fillet.
 */
export interface ShapeHistory {
  Modified(s: TopoDS_Shape): TopTools_ListOfShape;
  Generated(s: TopoDS_Shape): TopTools_ListOfShape;
  IsRemoved(s: TopoDS_Shape): boolean;
}

/**
 * A {@link ShapeHistory} that owns an OCCT resource (a `Handle_BRepTools_History`
 * from a boolean, or a dress-up maker kept alive for Modified/Generated/IsDeleted).
 * Call {@link OwnedShapeHistory.delete} once the remap is done — otherwise the
 * long-lived geometry worker leaks the handle/maker on every history-capable step.
 */
export type OwnedShapeHistory = ShapeHistory & {
  /** Free the underlying handle/maker. Idempotent. */
  delete(): void;
};

/**
 * Wrap a boolean's `Handle_BRepTools_History` as an owned {@link ShapeHistory}.
 * Returns `undefined` when the handle is null or `get()` yields nothing (history
 * fill disabled / uncallable). Takes ownership of `handle` on every path — either
 * the returned object's `delete()`, or an immediate free here.
 */
export function ownedBooleanHistory(handle: {
  IsNull(): boolean;
  get(): ShapeHistory | null | undefined;
  delete(): void;
}): OwnedShapeHistory | undefined {
  if (handle.IsNull()) {
    handle.delete();
    return undefined;
  }
  const hist = handle.get();
  if (!hist) {
    handle.delete();
    return undefined;
  }
  let disposed = false;
  return {
    Modified: (s) => hist.Modified(s),
    Generated: (s) => hist.Generated(s),
    IsRemoved: (s) => hist.IsRemoved(s),
    delete() {
      if (disposed) return;
      disposed = true;
      handle.delete();
    },
  };
}

/**
 * Adapt a BRepBuilderAPI_MakeShape-style maker (`Modified`/`Generated`/`IsDeleted`)
 * to {@link ShapeHistory} (`IsDeleted` → `IsRemoved`). The maker MUST outlive every
 * history query — ownership transfers here and is released by `delete()`.
 *
 * Fillet/chamfer expose all three methods directly; shell/draft inherit them from
 * `BRepBuilderAPI_MakeShape`. Their runtime dispatch is pinned by the dress-up
 * history tests before rebuild relies on the adapter.
 */
export function ownedMakerHistory(maker: {
  Modified(s: TopoDS_Shape): TopTools_ListOfShape;
  Generated(s: TopoDS_Shape): TopTools_ListOfShape;
  IsDeleted(s: TopoDS_Shape): boolean;
  delete(): void;
}): OwnedShapeHistory {
  let disposed = false;
  return {
    Modified: (s) => maker.Modified(s),
    Generated: (s) => maker.Generated(s),
    IsRemoved: (s) => maker.IsDeleted(s),
    delete() {
      if (disposed) return;
      disposed = true;
      maker.delete();
    },
  };
}

/**
 * The B-rep face handles of `solid`, indexed so `handles[faceId]` is the face
 * `tessellateTagged` tagged with that faceId. Reproduces tessellate.ts:97-159:
 * faces are explored in `TopExp_Explorer(shape, FACE)` order, and a face with no
 * cached triangulation is DROPPED (does not consume a faceId) exactly as the
 * tessellator drops it. The triangulation cache is the one the prior
 * `tessellateTagged(solid)` left on the shape (same MESH_PURPOSE), so the drop
 * decision is byte-identical.
 *
 * Caller owns every returned handle and MUST delete them. `expectFaceCount`
 * (the mesh's `faceGroups.length`) is asserted so a divergence from the tagged
 * numbering fails LOUDLY here instead of silently mis-naming faces downstream.
 */
function orderedFaceHandles(oc: Occt, solid: Solid, expectFaceCount: number): TopoDS_Face[] {
  const S = shapeEnums(oc);
  const out: TopoDS_Face[] = [];
  const exp = new oc.TopExp_Explorer_2(solid.shape, S.TopAbs_FACE, S.TopAbs_SHAPE);
  try {
    for (; exp.More(); exp.Next()) {
      const face = oc.TopoDS.Face_1(exp.Current());
      const loc = new oc.TopLoc_Location_1();
      const handle = oc.BRep_Tool.Triangulation(face, loc, MESH_PURPOSE);
      const dropped = handle.IsNull();
      handle.delete();
      loc.delete();
      if (dropped) {
        // Un-triangulated → tessellate omitted it and did NOT advance faceId.
        face.delete();
        continue;
      }
      out.push(face); // index === faceId (matching tessellate's push order)
    }
  } catch (err) {
    for (const f of out) f.delete();
    exp.delete();
    throw err;
  }
  exp.delete();
  if (out.length !== expectFaceCount) {
    for (const f of out) f.delete();
    throw new Error(
      `faceIdRemap: B-rep face count ${out.length} != tagged faceGroups ${expectFaceCount} — ` +
        `the faceId numbering the remap depends on has diverged from the mesh`,
    );
  }
  return out;
}

/**
 * Read a `TopTools_ListOfShape` into owned `TopoDS_Shape` handles (caller frees).
 * A history Modified/Generated list is normally tiny (1 for a trimmed face; 2+
 * only when a face splits). The list is Assign-copied first so RemoveFirst drains
 * the COPY, never the caller's list.
 */
function listToShapes(oc: Occt, list: TopTools_ListOfShape): TopoDS_Shape[] {
  const out: TopoDS_Shape[] = [];
  const copy = new oc.TopTools_ListOfShape_1();
  try {
    copy.Assign(list);
    while (copy.Size() > 0) {
      out.push(copy.First_1());
      copy.RemoveFirst();
    }
  } finally {
    copy.delete();
  }
  return out;
}

/** faceId of the current-body face equal (B-rep identity) to `target`, or -1. */
function faceIdByIdentity(target: TopoDS_Shape, curFaces: readonly TopoDS_Face[]): number {
  for (let j = 0; j < curFaces.length; j++) {
    if (curFaces[j]!.IsSame(target)) return j;
  }
  return -1;
}

/**
 * faceId of the current-body face whose ANALYTIC surface matches `prev`'s, nearest
 * by centroid, or -1. The history-less / copied-identity fallback (importStep,
 * NonDestructive booleans whose result faces are copies): trimming a face leaves
 * its analytic surface unchanged, so `surface` still matches; `centroid`
 * disambiguates two faces sharing that surface (resolve.ts's own strategy).
 */
function faceIdBySignature(prev: FaceGroup, curGroups: readonly FaceGroup[]): number {
  let best = -1;
  let bestD = Infinity;
  for (const cand of curGroups) {
    if (!surfacesMatch(prev.surface, cand.surface)) continue;
    const dx = prev.centroid[0] - cand.centroid[0];
    const dy = prev.centroid[1] - cand.centroid[1];
    const dz = prev.centroid[2] - cand.centroid[2];
    const d = dx * dx + dy * dy + dz * dz;
    if (d < bestD) {
      bestD = d;
      best = cand.faceId;
    }
  }
  return best;
}

/**
 * Derive an `oldFaceId → newFaceId` map from a build step's shape history.
 *
 * For each face of the PREVIOUS body (named by its tagged faceId):
 *   • `IsRemoved`      → maps to {@link FACE_REMOVED} (consumed; no successor).
 *   • `Modified` (or, when Modified is empty, `Generated`) non-empty → the new
 *     face(s) it BECAME; mapped to the first that resolves on the current body by
 *     B-rep identity. A face that split into several has no single successor, so
 *     the first fragment is chosen (documented 1:1 collapse).
 *   • otherwise        → UNCHANGED: the same face persists in the result, found by
 *     B-rep identity (`IsSame`).
 *   • identity miss    → analytic-signature fallback against `curTagged` (history-
 *     less steps, or a result whose faces are non-destructive copies).
 *
 * `history` is optional: with none supplied EVERY face takes the signature
 * fallback, which is exactly the R1 behaviour §13.1 keeps for history-less steps
 * (importStep, service round-trips).
 */
export function faceIdRemap(
  oc: Occt,
  prevTagged: TaggedMesh,
  prevSolid: Solid,
  curTagged: TaggedMesh,
  curSolid: Solid,
  history?: ShapeHistory,
): Map<number, number> {
  const map = new Map<number, number>();
  const prevFaces = orderedFaceHandles(oc, prevSolid, prevTagged.faceGroups.length);
  let curFaces: TopoDS_Face[] = [];
  try {
    curFaces = orderedFaceHandles(oc, curSolid, curTagged.faceGroups.length);

    for (let oldId = 0; oldId < prevFaces.length; oldId++) {
      const pf = prevFaces[oldId]!;

      if (history?.IsRemoved(pf)) {
        map.set(oldId, FACE_REMOVED);
        continue;
      }

      // The new faces this old face BECAME (Modified first; Generated when a face
      // was wholly re-generated rather than trimmed). Each successor handle is
      // freed after we test it.
      let mapped = false;
      if (history) {
        let successors: TopoDS_Shape[] = [];
        const modified = history.Modified(pf);
        try {
          successors = listToShapes(oc, modified);
        } finally {
          modified.delete();
        }
        if (successors.length === 0) {
          const generated = history.Generated(pf);
          try {
            successors = listToShapes(oc, generated);
          } finally {
            generated.delete();
          }
        }
        try {
          for (const succ of successors) {
            const nid = faceIdByIdentity(succ, curFaces);
            if (nid >= 0) {
              map.set(oldId, nid);
              mapped = true;
              break;
            }
          }
        } finally {
          for (const s of successors) s.delete();
        }
      }
      if (mapped) continue;

      // No recorded change → the face passed through unchanged; it is the SAME
      // B-rep face in the result (OCCT shares the subshape). Fillet/chamfer keep
      // unmodified faces shared, so IsSame finds them.
      const same = faceIdByIdentity(pf, curFaces);
      if (same >= 0) {
        map.set(oldId, same);
        continue;
      }

      // History-less step, or a result whose surviving faces are non-destructive
      // COPIES (identity broken): re-anchor by analytic signature.
      const geo = faceIdBySignature(prevTagged.faceGroups[oldId]!, curTagged.faceGroups);
      if (geo >= 0) map.set(oldId, geo);
      // else: genuinely unresolvable — left OUT of the map (a lookup miss), never
      // guessed. The caller keeps R1 signature re-matching as the last resort.
    }

    return map;
  } finally {
    for (const f of prevFaces) f.delete();
    for (const f of curFaces) f.delete();
  }
}
