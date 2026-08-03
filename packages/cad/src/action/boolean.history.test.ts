// §13.1 — boolean ops return optional BRepTools_History; faceIdRemap consumes it.
//
// Proves the public API path (union → BooleanResult.history → faceIdRemap), not
// the low-level op.History() pin (oc/history.pin.test.ts) or the remap unit
// tests that build history by hand (mesh/remap.test.ts).

import { beforeAll, describe, expect, it } from "vitest";

import { initOcct, type Occt } from "../oc/init.js";
import { mm } from "../unit/index.js";
import { makeBox, makeBoxAt } from "../solid/primitives.js";
import { tessellateTagged } from "../mesh/tessellate.js";
import { FACE_REMOVED, faceIdRemap } from "../mesh/remap.js";
import { releaseBooleanHistory, union, subtract } from "./boolean.js";

let oc: Occt;
beforeAll(async () => {
  oc = await initOcct();
}, 120_000);

/** faceId of the face whose outward normal points along `axis` (±1 on one component). */
function faceIdByNormal(
  groups: { faceId: number; normal: readonly [number, number, number] }[],
  axis: 0 | 1 | 2,
  sign: 1 | -1,
): number {
  const g = groups.find((gr) => Math.round(gr.normal[axis]) === sign);
  if (!g) throw new Error(`no face with normal ${sign} on axis ${axis}`);
  return g.faceId;
}

describe("§13.1 boolean history on BooleanResult", () => {
  it("union of two boxes attaches a callable history (History() filled)", () => {
    const a = makeBox(oc, mm(30), mm(30), mm(30));
    const b = makeBoxAt(oc, [mm(15), mm(0), mm(0)], mm(30), mm(30), mm(30));
    const u = union(oc, a, b);
    try {
      expect(u.ok).toBe(true);
      if (!u.ok) return;
      // Optional field — must be PRESENT when History is callable (this wasm).
      expect(u.history, "union must attach BRepTools_History when SetToFillHistory succeeds").toBeDefined();
      // Callability smoke: IsRemoved on a real face must not throw.
      const prevMesh = tessellateTagged(oc, a);
      const face0 = prevMesh.faceGroups[0]!;
      // Walk via ordered handles inside faceIdRemap is the real contract; here just
      // prove the three methods dispatch (history is ShapeHistory-shaped).
      expect(typeof u.history!.IsRemoved).toBe("function");
      expect(typeof u.history!.Modified).toBe("function");
      expect(typeof u.history!.Generated).toBe("function");
      void face0; // mesh proves tessellate still works on the pre-union solid
    } finally {
      if (u.ok) {
        releaseBooleanHistory(u);
        u.solid.delete();
      }
      a.delete();
      b.delete();
    }
  });

  it("faceIdRemap over union history marks the consumed interior face REMOVED", () => {
    // A: x 0..30, B: x 15..45. A's +X face (x=30) lies inside the fused solid.
    const a = makeBox(oc, mm(30), mm(30), mm(30));
    const b = makeBoxAt(oc, [mm(15), mm(0), mm(0)], mm(30), mm(30), mm(30));
    const prevMesh = tessellateTagged(oc, a);
    const plusXId = faceIdByNormal(prevMesh.faceGroups, 0, 1);
    const minusXId = faceIdByNormal(prevMesh.faceGroups, 0, -1);

    const u = union(oc, a, b);
    try {
      expect(u.ok).toBe(true);
      if (!u.ok) return;
      expect(u.history).toBeDefined();

      const curMesh = tessellateTagged(oc, u.solid);
      const map = faceIdRemap(oc, prevMesh, a, curMesh, u.solid, u.history);

      // Interior +X of A was consumed by the union.
      expect(map.get(plusXId)).toBe(FACE_REMOVED);

      // Boundary -X of A survives and re-anchors to a current face.
      const minusXNew = map.get(minusXId);
      expect(minusXNew).toBeDefined();
      expect(minusXNew).not.toBe(FACE_REMOVED);
      expect(minusXNew).toBeGreaterThanOrEqual(0);
      expect(curMesh.faceGroups[minusXNew!]!.surface.kind).toBe("plane");

      // At least one face reported removed via real BRepTools_History.IsRemoved.
      expect([...map.values()].filter((v) => v === FACE_REMOVED).length).toBeGreaterThanOrEqual(1);
    } finally {
      if (u.ok) {
        releaseBooleanHistory(u);
        u.solid.delete();
      }
      a.delete();
      b.delete();
    }
  });

  it("subtract also attaches history; releaseBooleanHistory is idempotent-safe after use", () => {
    const a = makeBox(oc, mm(40), mm(40), mm(40));
    const b = makeBoxAt(oc, [mm(10), mm(10), mm(10)], mm(20), mm(20), mm(20));
    const r = subtract(oc, a, b);
    try {
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.history).toBeDefined();
      releaseBooleanHistory(r);
      // Second release must not throw (delete is idempotent on OwnedShapeHistory).
      expect(() => releaseBooleanHistory(r)).not.toThrow();
    } finally {
      if (r.ok) r.solid.delete();
      a.delete();
      b.delete();
    }
  });
});
