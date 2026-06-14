// io — SMOKE (real OCCT): every exporter produces non-empty text and importStep
// returns a solid. Round-trip fidelity + format detail is in io.test.ts.

import { beforeAll, describe, expect, it } from "vitest";

import { initOcct, type Occt } from "../oc/init.js";
import { makeBox } from "../solid/primitives.js";
import { mm } from "../unit/index.js";
import { exportGltf, exportIges, exportStep, importStep } from "./index.js";

let oc: Occt;
beforeAll(async () => {
  oc = await initOcct();
}, 120_000);

describe("io — smoke", () => {
  it("exportStep / exportIges / exportGltf emit non-empty text", () => {
    const box = makeBox(oc, mm(40), mm(30), mm(20));
    expect(exportStep(oc, box).length).toBeGreaterThan(0);
    expect(exportIges(oc, box).length).toBeGreaterThan(0);
    expect(exportGltf(oc, box).length).toBeGreaterThan(0);
    box.delete();
  });

  it("importStep re-reads an exported STEP into a positive-volume solid", () => {
    const box = makeBox(oc, mm(40), mm(30), mm(20));
    const step = exportStep(oc, box);
    const reimported = importStep(oc, step);
    expect(reimported.volume()).toBeGreaterThan(0);
    reimported.delete();
    box.delete();
  });
});
