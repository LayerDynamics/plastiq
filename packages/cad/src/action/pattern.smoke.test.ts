// action/pattern — SMOKE (real OCCT): linearPattern + circularPattern produce
// positive-volume instances. Exact counts/placement are in edgecases/loftsweep tests.

import { beforeAll, describe, expect, it } from "vitest";

import { initOcct, type Occt } from "../oc/init.js";
import { mm } from "../unit/index.js";
import { makeBox } from "../solid/primitives.js";
import { circularPattern, linearPattern } from "./pattern.js";

let oc: Occt;
beforeAll(async () => {
  oc = await initOcct();
}, 120_000);

describe("pattern — smoke", () => {
  it("linearPattern produces positive-volume instances", () => {
    const box = makeBox(oc, mm(10), mm(10), mm(10));
    const copies = linearPattern(oc, box, [1, 0, 0], mm(20), 3);
    expect(copies.length).toBeGreaterThan(0);
    for (const s of copies) {
      expect(s.volume()).toBeGreaterThan(0);
      s.delete();
    }
    box.delete();
  });

  it("circularPattern produces positive-volume instances", () => {
    const box = makeBox(oc, mm(10), mm(10), mm(10));
    const copies = circularPattern(oc, box, [0, 0, 0], [0, 0, 1], 4, 2 * Math.PI);
    expect(copies.length).toBeGreaterThan(0);
    for (const s of copies) {
      expect(s.volume()).toBeGreaterThan(0);
      s.delete();
    }
    box.delete();
  });

  // §4.6 — a degenerate step (zero spacing / zero angle) places every copy on
  // top of the base, and the caller's fuse then collapses them back to the base:
  // the pattern silently "did nothing". These must fail LOUDLY instead.
  it("rejects zero spacing / zero angle for count > 1 (the silent no-op)", () => {
    const box = makeBox(oc, mm(10), mm(10), mm(10));
    expect(() => linearPattern(oc, box, [1, 0, 0], 0, 3)).toThrow(/spacing must be non-zero/);
    expect(() => linearPattern(oc, box, [1, 0, 0], NaN, 3)).toThrow(/spacing must be non-zero/);
    expect(() => circularPattern(oc, box, [0, 0, 0], [0, 0, 1], 4, 0)).toThrow(
      /angle must be non-zero/,
    );
    // count === 1 is just the base, so a missing spacing/angle is fine.
    const one = linearPattern(oc, box, [1, 0, 0], 0, 1);
    expect(one).toHaveLength(1);
    expect(one[0]!.volume()).toBeGreaterThan(0);
    one.forEach((s) => s.delete());
    box.delete();
  });

  // §2.10.4 — a pathological count (the audit's 1e6) hung the single geometry
  // worker WITHOUT erroring. It must now fail loudly, and a large-but-sane count
  // must still be allowed.
  it("rejects a pathologically large count instead of freezing the worker", () => {
    const box = makeBox(oc, mm(1), mm(1), mm(1));
    expect(() => linearPattern(oc, box, [1, 0, 0], mm(2), 1_000_000)).toThrow(/exceeds the maximum/);
    expect(() => circularPattern(oc, box, [0, 0, 0], [0, 0, 1], 1_000_000, Math.PI)).toThrow(
      /exceeds the maximum/,
    );
    // The boundary is inclusive: 10 000 is allowed (though we don't build it here).
    expect(() => linearPattern(oc, box, [1, 0, 0], mm(2), 10_001)).toThrow(/exceeds the maximum/);
    box.delete();
  });
});
