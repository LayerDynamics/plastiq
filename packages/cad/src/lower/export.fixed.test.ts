// Ground/fixed lowering — a Component marked `fixed` lowers its bodies (and its
// whole subtree's bodies) to static ManifestBody entries (`fixed: true`), so a
// grounded assembly doesn't free-fall in the sim. Runs against the real OCCT wasm.

import { beforeAll, describe, expect, it } from "vitest";

import { initOcct, type Occt } from "../oc/init.js";
import { mm } from "../unit/index.js";
import { makeBox } from "../solid/primitives.js";
import type { Solid } from "../solid/solid.js";
import { Component, defaultLibrary, makeBody } from "./component.js";
import { exportForSim } from "./export.js";
import { initDecomposer } from "./decompose.js";
import { isSimManifest } from "./manifest.js";

let oc: Occt;
let part: Solid;

beforeAll(async () => {
  oc = await initOcct();
  await initDecomposer();
  part = makeBox(oc, mm(20), mm(20), mm(20));
}, 120_000);

/** A one-body component named `id`, placed at `x` metres, sharing `part`. */
function instance(id: string, x: number, fixed = false): Component {
  const comp = new Component(id);
  comp.placement = { position: [x, 0, 0], orientation: [0, 0, 0, 1] };
  comp.fixed = fixed;
  const body = makeBody(id, "structural-steel");
  body.geometry = part;
  comp.addBody(body);
  return comp;
}

describe("exportForSim — fixed (grounded) components", () => {
  it("a fixed component's body emits fixed:true; a free sibling emits no flag", () => {
    const root = new Component("assembly");
    root.addChild(instance("ground", 0, true));
    root.addChild(instance("free", 0.1));

    const manifest = exportForSim(oc, root, defaultLibrary(), "test", {});
    expect(isSimManifest(manifest)).toBe(true);
    expect(manifest.bodies.map((b) => b.id)).toEqual(["ground", "free"]);
    expect(manifest.bodies[0]!.fixed).toBe(true);
    expect(manifest.bodies[1]!.fixed).toBeUndefined();
    // Grounding does NOT zero the mass — backends key static purely off `fixed`.
    expect(manifest.bodies[0]!.mass).toBeCloseTo(manifest.bodies[1]!.mass, 9);
    expect(manifest.bodies[0]!.mass).toBeGreaterThan(0);
  });

  it("fixed composes down the tree: a fixed ancestor grounds nested bodies", () => {
    // fixed base ─┬─ (own body "base")
    //             └─ free child subassembly ── (body "arm") ← still grounded
    const root = new Component("assembly");
    const base = instance("base", 0, true);
    const arm = instance("arm", 0.1); // NOT itself fixed
    base.addChild(arm);
    root.addChild(base);

    const manifest = exportForSim(oc, root, defaultLibrary(), "test", {});
    expect(isSimManifest(manifest)).toBe(true);
    const byId = new Map(manifest.bodies.map((b) => [b.id, b]));
    expect(byId.get("base")!.fixed).toBe(true);
    expect(byId.get("arm")!.fixed).toBe(true);
    // The nested placement still composes: arm's COM = 100mm offset + 10mm centroid.
    expect(byId.get("arm")!.com[0]).toBeCloseTo(mm(110), 6);
  });

  it("a fixed child under a free parent grounds only the child's subtree", () => {
    // free parent ─┬─ (own body "carrier") ← dynamic
    //              └─ fixed child ── (body "anchor") ← static
    const root = new Component("assembly");
    const carrier = instance("carrier", 0);
    const anchor = instance("anchor", 0.1, true);
    carrier.addChild(anchor);
    root.addChild(carrier);

    const manifest = exportForSim(oc, root, defaultLibrary(), "test", {});
    expect(isSimManifest(manifest)).toBe(true);
    const byId = new Map(manifest.bodies.map((b) => [b.id, b]));
    expect(byId.get("carrier")!.fixed).toBeUndefined();
    expect(byId.get("anchor")!.fixed).toBe(true);
  });
});
