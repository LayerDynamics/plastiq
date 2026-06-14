// oc/init — SMOKE: initOcct resolves to a usable OCCT module.

import { describe, expect, it } from "vitest";

import { initOcct } from "./init.js";

describe("initOcct — smoke", () => {
  it("resolves to a defined module exposing core OCCT members", async () => {
    const oc = await initOcct();
    expect(oc).toBeDefined();
    expect(oc.TopoDS).toBeDefined();
    expect(oc.BRep_Tool).toBeDefined();
  }, 120_000);
});
