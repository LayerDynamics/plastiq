import { beforeAll, describe, expect, it } from "vitest";
import { massProperties } from "../lower/massprops.js";
import { initOcct, type Occt } from "../oc/init.js";
import { makeBox } from "../solid/primitives.js";
import type { Solid } from "../solid/solid.js";
import { mm } from "../unit/index.js";
import { linearPattern, circularPattern } from "./copy.js";
import { offsetShape } from "./offset.js";
import type { FaceRef } from "./selection.js";
import { shell } from "./shell.js";
import { mirror, rotate, translate } from "./transform.js";

const INIT_TIMEOUT_MS = 120_000;

function com(oc: Occt, s: Solid): readonly [number, number, number] {
  return massProperties(oc, s, 1).com;
}
function vol(oc: Occt, s: Solid): number {
  return massProperties(oc, s, 1).volume;
}
function near(a: number, b: number, tol = 1e-9): void {
  expect(Math.abs(a - b)).toBeLessThan(tol);
}

describe("transform / pattern / shell / offset (FR-10/11/14/15)", () => {
  let oc: Occt;
  beforeAll(async () => {
    oc = await initOcct();
  }, INIT_TIMEOUT_MS);

  it("translate shifts the centre of mass", () => {
    const box = makeBox(oc, mm(20), mm(20), mm(20)); // COM (0.01,0.01,0.01)
    try {
      const moved = translate(oc, box, [0.1, 0, 0]);
      try {
        near(com(oc, moved)[0], 0.11);
        near(com(oc, moved)[1], 0.01);
      } finally {
        moved.delete();
      }
    } finally {
      box.delete();
    }
  });

  it("rotate 90° about +Z maps COM (0.01,0.01,·) → (−0.01,0.01,·)", () => {
    const box = makeBox(oc, mm(20), mm(20), mm(20));
    try {
      const r = rotate(oc, box, [0, 0, 0], [0, 0, 1], Math.PI / 2);
      try {
        near(com(oc, r)[0], -0.01, 1e-7);
        near(com(oc, r)[1], 0.01, 1e-7);
      } finally {
        r.delete();
      }
    } finally {
      box.delete();
    }
  });

  it("mirror across the YZ plane negates the COM x", () => {
    const box = makeBox(oc, mm(20), mm(20), mm(20));
    try {
      const m = mirror(oc, box, [0, 0, 0], [1, 0, 0]);
      try {
        near(com(oc, m)[0], -0.01, 1e-9);
      } finally {
        m.delete();
      }
    } finally {
      box.delete();
    }
  });

  it("linearPattern produces N instances at the expected positions", () => {
    const box = makeBox(oc, mm(20), mm(20), mm(20));
    try {
      const instances = linearPattern(oc, box, [1, 0, 0], 0.03, 3);
      try {
        expect(instances).toHaveLength(3);
        near(com(oc, instances[0]!)[0], 0.01);
        near(com(oc, instances[1]!)[0], 0.04);
        near(com(oc, instances[2]!)[0], 0.07);
      } finally {
        instances.forEach((s) => s.delete());
      }
    } finally {
      box.delete();
    }
  });

  it("circularPattern produces N instances", () => {
    const box = makeBox(oc, mm(10), mm(10), mm(10));
    try {
      const instances = circularPattern(oc, box, [0, 0, 0], [0, 0, 1], 6);
      try {
        expect(instances).toHaveLength(6);
        expect(instances.every((s) => s.isValid())).toBe(true);
      } finally {
        instances.forEach((s) => s.delete());
      }
    } finally {
      box.delete();
    }
  });

  it("shell hollows a box (top face open) to a wall thickness", () => {
    const box = makeBox(oc, mm(20), mm(20), mm(20)); // 8e-6
    const topFace: FaceRef = { normal: [0, 0, 1] };
    try {
      const hollow = shell(oc, box, [topFace], mm(2));
      try {
        expect(hollow.isValid()).toBe(true);
        const v = vol(oc, hollow);
        // outer 8e-6 minus cavity 0.016·0.016·0.018 = 4.608e-6 → 3.392e-6.
        expect(Math.abs(v - 3.392e-6) / 3.392e-6).toBeLessThan(1e-3);
      } finally {
        hollow.delete();
      }
    } finally {
      box.delete();
    }
  });

  it("offset grows a box (volume increases)", () => {
    const box = makeBox(oc, mm(20), mm(20), mm(20));
    try {
      const bigger = offsetShape(oc, box, mm(1));
      try {
        expect(bigger.isValid()).toBe(true);
        expect(vol(oc, bigger)).toBeGreaterThan(8e-6);
      } finally {
        bigger.delete();
      }
    } finally {
      box.delete();
    }
  });
});
