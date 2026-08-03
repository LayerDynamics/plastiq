// action/boolean — SMOKE (real OCCT): union/subtract/intersect/cut on two
// overlapping boxes. Exact volumes are in features.test.ts.

import { beforeAll, describe, expect, it } from "vitest";

import { initOcct, type Occt } from "../oc/init.js";
import { mm } from "../unit/index.js";
import { makeBox, makeBoxAt } from "../solid/primitives.js";
import { cut, intersect, releaseBooleanHistory, subtract, union } from "./boolean.js";

let oc: Occt;
beforeAll(async () => {
  oc = await initOcct();
}, 120_000);

describe("boolean — smoke", () => {
  it("union / subtract / intersect succeed; cut returns a solid (overlapping boxes)", () => {
    const a = makeBox(oc, mm(100), mm(100), mm(100));
    const b = makeBoxAt(oc, [mm(50), mm(50), mm(50)], mm(100), mm(100), mm(100));

    const u = union(oc, a, b);
    expect(u.ok).toBe(true);
    if (u.ok) {
      expect(u.solid.volume()).toBeGreaterThan(0);
      releaseBooleanHistory(u);
      u.solid.delete();
    }
    const s = subtract(oc, a, b);
    expect(s.ok).toBe(true);
    if (s.ok) {
      expect(s.solid.volume()).toBeGreaterThan(0);
      releaseBooleanHistory(s);
      s.solid.delete();
    }
    const i = intersect(oc, a, b);
    expect(i.ok).toBe(true);
    if (i.ok) {
      expect(i.solid.volume()).toBeGreaterThan(0);
      releaseBooleanHistory(i);
      i.solid.delete();
    }
    const c = cut(oc, a, b);
    expect(c.volume()).toBeGreaterThan(0);
    c.delete();

    a.delete();
    b.delete();
  });
});
