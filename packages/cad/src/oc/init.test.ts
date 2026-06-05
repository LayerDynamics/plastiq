import { beforeAll, describe, expect, it } from "vitest";
import { initOcct, type Occt } from "./init.js";

// Instantiating the 48 MB OCCT WASM takes a few seconds; allow generous time.
const INIT_TIMEOUT_MS = 120_000;

describe("initOcct", () => {
  let oc: Occt;

  beforeAll(async () => {
    oc = await initOcct();
  }, INIT_TIMEOUT_MS);

  it("resolves to an OCCT engine exposing modeling APIs", () => {
    // The box primitive constructor must exist — the smoke test that the full
    // OCCT toolkit loaded (the overloaded ctor is suffixed _1.._N by ocjs).
    expect(typeof oc.BRepPrimAPI_MakeBox_2).toBe("function");
    // Topology + validity classes the kernel relies on.
    expect(typeof oc.TopExp_Explorer_1).toBe("function");
    expect(typeof oc.BRepCheck_Analyzer).toBe("function");
  });

  it("memoizes — a second initOcct() returns the same instance", async () => {
    const again = await initOcct();
    expect(again).toBe(oc);
  });
});
