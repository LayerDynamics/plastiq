// exportForSim — SMOKE (real OCCT + V-HACD): lowers a one-body component tree to a
// valid SimManifest. The multi-body / joints / decomposition correctness is in
// export.test.ts (integration).

import { beforeAll, describe, expect, it } from "vitest";

import { initOcct, type Occt } from "../oc/init.js";
import { makeBox } from "../solid/primitives.js";
import { mm } from "../unit/index.js";
import { Component, defaultLibrary, makeBody } from "./component.js";
import { initDecomposer } from "./decompose.js";
import { exportForSim } from "./export.js";
import { isSimManifest } from "./manifest.js";

let oc: Occt;
beforeAll(async () => {
  oc = await initOcct();
  await initDecomposer();
}, 120_000);

describe("exportForSim — smoke", () => {
  it("lowers a one-body component tree to a valid SimManifest", () => {
    const root = new Component("root");
    const body = makeBody("part", "structural-steel");
    const solid = makeBox(oc, mm(50), mm(50), mm(50));
    body.geometry = solid;
    root.addBody(body);

    const manifest = exportForSim(oc, root, defaultLibrary(), "smoke");
    expect(isSimManifest(manifest)).toBe(true);
    expect(manifest.bodies).toHaveLength(1);
    expect(manifest.source).toBe("smoke");
    expect(manifest.bodies[0]!.mass).toBeGreaterThan(0);

    solid.delete();
  });
});
