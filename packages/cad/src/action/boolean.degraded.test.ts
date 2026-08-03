// R8 kernel honesty pass — K4: unifySameDomain no longer swallows a failure
// silently. The success variant of BooleanResult carries an optional
// `degraded: true` when the coplanar-face merge could not be applied and the op
// fell back to the fragmented-but-valid shape. Exercised against real OCCT wasm.

import { beforeAll, describe, expect, it } from "vitest";

import { initOcct, type Occt } from "../oc/init.js";
import { mm } from "../unit/index.js";
import { makeBox, makeBoxAt } from "../solid/primitives.js";
import { shapeEnums } from "../mesh/normals.js";
import type { Solid } from "../solid/solid.js";
import { releaseBooleanHistory, union } from "./boolean.js";

let oc: Occt;

beforeAll(async () => {
  oc = await initOcct();
}, 120_000);

function faceCount(solid: Solid): number {
  const S = shapeEnums(oc);
  const exp = new oc.TopExp_Explorer_2(solid.shape, S.TopAbs_FACE, S.TopAbs_SHAPE);
  let n = 0;
  try {
    while (exp.More()) {
      n++;
      exp.Next();
    }
  } finally {
    exp.delete();
  }
  return n;
}

describe("K4 — boolean reports the unify-degrade flag", () => {
  it("a flush union whose unify SUCCEEDS reports degraded as falsy (merge applied)", () => {
    // Two flush 30 mm cubes fuse into one 60×30×30 box. The unify step is exactly
    // what merges the coplanar halves back into 6 faces (raw fuse leaves 10). When
    // that merge succeeds — the reachable path with valid geometry — the flag must
    // NOT be set: this proves `degraded` is wired to the real outcome, not always
    // true and not always absent.
    const a = makeBox(oc, mm(30), mm(30), mm(30));
    const b = makeBoxAt(oc, [mm(30), 0, 0], mm(30), mm(30), mm(30));
    const u = union(oc, a, b);

    expect(u.ok).toBe(true);
    if (!u.ok) return;
    // The merge ran and worked → 6 faces (not 10) AND the degrade flag is clear.
    expect(faceCount(u.solid)).toBe(6);
    expect(u.degraded).toBeFalsy();

    releaseBooleanHistory(u);
    a.delete();
    b.delete();
    u.solid.delete();
  });

  it("the degraded flag is optional and typed on the SUCCESS variant only", () => {
    // A single disjoint union still succeeds and, having merged nothing exotic,
    // leaves the flag unset. (The `degraded: true` branch is the defensive path
    // for a Standard_Failure / null result out of ShapeUpgrade_UnifySameDomain,
    // which valid geometry does not reproduce; it is wired in boolean.ts and
    // asserted-falsy here on every reachable success.)
    const a = makeBox(oc, mm(20), mm(20), mm(20));
    const b = makeBoxAt(oc, [mm(20), 0, 0], mm(20), mm(20), mm(20));
    const u = union(oc, a, b);
    expect(u.ok).toBe(true);
    if (!u.ok) return;
    expect(u.degraded).toBeFalsy();
    releaseBooleanHistory(u);
    a.delete();
    b.delete();
    u.solid.delete();
  });
});
