// oc/init — INTEGRATION: the engine initOcct returns is a functional kernel that
// builds real geometry end to end (the precondition every other OCCT module relies on).

import { describe, expect, it } from "vitest";

import { initOcct } from "./init.js";
import { makeBox } from "../solid/primitives.js";
import { mm } from "../unit/index.js";

describe("initOcct — functional kernel (integration)", () => {
  it("builds a real box with the correct volume", async () => {
    const oc = await initOcct();
    const box = makeBox(oc, mm(50), mm(40), mm(30));
    expect(box.volume()).toBeCloseTo(0.05 * 0.04 * 0.03, 12); // 6e-5 m³
    box.delete();
  }, 120_000);
});
