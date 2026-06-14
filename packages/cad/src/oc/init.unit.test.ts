// oc/init — UNIT: initOcct memoizes the engine (one load shared across the app).

import { describe, expect, it } from "vitest";

import { initOcct } from "./init.js";

describe("initOcct — memoization (unit)", () => {
  it("returns the SAME engine instance on repeated calls", async () => {
    const a = await initOcct();
    const b = await initOcct();
    expect(a).toBe(b);
  }, 120_000);

  it("returns the same cached promise (no second wasm load)", () => {
    expect(initOcct()).toBe(initOcct());
  });
});
