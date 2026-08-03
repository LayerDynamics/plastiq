// §2.5 — the `scale` feature. The kernel had a uniform-scale op (transform.ts)
// that was reachable from NOWHERE (no feature type, no rebuild case, no action,
// no AI schema) — a user could not resize a body. These tests prove the feature
// now executes through the rebuild evaluator with the correct volume law.

import { beforeAll, describe, expect, it } from "vitest";
import { initOcct, mm, type Occt } from "@plastiq/cad";
import type { CadDocument, EditorFeature } from "../store/types.js";
import { rebuildDocument } from "./rebuild.js";

let oc: Occt;
beforeAll(async () => {
  oc = await initOcct();
}, 120_000);

/** A 20×30×40 mm box, optionally followed by extra features. */
function boxDoc(extra: EditorFeature[] = []): CadDocument {
  return {
    features: [
      { id: "f1", type: "box", params: { dx: mm(20), dy: mm(30), dz: mm(40) } },
      ...extra,
    ],
    params: {},
  };
}

describe("§2.5 scale feature — uniform resize now reachable through rebuild", () => {
  it("scales the body volume by factor³", () => {
    const base = rebuildDocument(oc, boxDoc())!;
    const v0 = base.volume();
    base.delete();

    const scaled = rebuildDocument(
      oc,
      boxDoc([{ id: "f2", type: "scale", params: { factor: 2 } }]),
    )!;
    // A uniform ×2 scale multiplies volume by 2³ = 8.
    expect(scaled.volume() / v0).toBeCloseTo(8, 5);
    scaled.delete();
  });

  it("scales about an explicit pivot without changing the volume law", () => {
    const base = rebuildDocument(oc, boxDoc())!;
    const v0 = base.volume();
    base.delete();

    const scaled = rebuildDocument(
      oc,
      boxDoc([{ id: "f2", type: "scale", params: { factor: 0.5, px: mm(10), py: mm(15), pz: mm(20) } }]),
    )!;
    expect(scaled.volume() / v0).toBeCloseTo(0.125, 6); // 0.5³
    scaled.delete();
  });

  it("factor 1 is a no-op (volume unchanged)", () => {
    const base = rebuildDocument(oc, boxDoc())!;
    const v0 = base.volume();
    base.delete();

    const same = rebuildDocument(oc, boxDoc([{ id: "f2", type: "scale", params: { factor: 1 } }]))!;
    expect(same.volume()).toBeCloseTo(v0, 9);
    same.delete();
  });

  it("rejects a non-positive factor LOUDLY — never a silent collapse to a point", () => {
    expect(() =>
      rebuildDocument(oc, boxDoc([{ id: "f2", type: "scale", params: { factor: 0 } }])),
    ).toThrow(/factor/);
    expect(() =>
      rebuildDocument(oc, boxDoc([{ id: "f2", type: "scale", params: { factor: -2 } }])),
    ).toThrow(/factor/);
  });
});
