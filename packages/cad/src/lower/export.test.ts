// R6 (chunk A) — assembly→SimManifest lowering against the real OCCT wasm.

import { beforeAll, describe, expect, it } from "vitest";

import { initOcct, type Occt } from "../oc/init.js";
import { mm } from "../unit/index.js";
import { makeBox } from "../solid/primitives.js";
import { Component, defaultLibrary, makeBody } from "./component.js";
import { exportForSim } from "./export.js";
import { isLowerable, lowerJoints, makeJoint, type JointBinding } from "./joints.js";
import { massProperties } from "./massprops.js";
import { isSimManifest } from "./manifest.js";

let oc: Occt;

beforeAll(async () => {
  oc = await initOcct();
}, 120_000);

describe("massProperties", () => {
  it("computes mass = volume × density and the centroid", () => {
    const box = makeBox(oc, mm(60), mm(40), mm(30));
    const mp = massProperties(oc, box, 7850);
    expect(mp.volume).toBeCloseTo(7.2e-5, 9);
    expect(mp.mass).toBeCloseTo(7.2e-5 * 7850, 6);
    expect(mp.com[0]).toBeCloseTo(mm(30), 6);
    expect(mp.com[2]).toBeCloseTo(mm(15), 6);
    box.delete();
  });
});

describe("exportForSim", () => {
  it("lowers two posed instances of one part into two valid bodies", () => {
    const part = makeBox(oc, mm(20), mm(20), mm(20));
    const root = new Component("assembly");

    const a = new Component("i1");
    a.placement = { position: [0, 0, 0], orientation: [0, 0, 0, 1] };
    const ba = makeBody("i1", "structural-steel");
    ba.geometry = part;
    a.addBody(ba);
    root.addChild(a);

    const b = new Component("i2");
    b.placement = { position: [0.1, 0, 0], orientation: [0, 0, 0, 1] };
    const bb = makeBody("i2", "structural-steel");
    bb.geometry = part;
    b.addBody(bb);
    root.addChild(b);

    const manifest = exportForSim(oc, root, defaultLibrary(), "test", {});
    expect(isSimManifest(manifest)).toBe(true);
    expect(manifest.bodies).toHaveLength(2);
    expect(manifest.gravity).toEqual([0, 0, -9.81]);

    // Body i1's COM = placement (0) + local centroid (10,10,10)mm.
    expect(manifest.bodies[0]!.com[0]).toBeCloseTo(mm(10), 6);
    // Body i2 is shifted +100mm in x → COM x = 100 + 10 = 110mm.
    expect(manifest.bodies[1]!.com[0]).toBeCloseTo(mm(110), 6);
    // Half-extents = half the 20mm box.
    expect(manifest.bodies[0]!.halfExtents[0]).toBeCloseTo(mm(10), 6);
    part.delete();
  });
});

describe("joint lowering", () => {
  it("lowers revolute→hinge and fixed→fixed, skipping prismatic", () => {
    expect(isLowerable("revolute")).toBe(true);
    expect(isLowerable("fixed")).toBe(true);
    expect(isLowerable("prismatic")).toBe(false);
    expect(isLowerable("cylindrical")).toBe(false);

    const bindings: JointBinding[] = [
      { joint: makeJoint("revolute", 0, 0, { origin: [0, 0, 0], axis: [0, 0, 1] }), bodyA: "i1", bodyB: "i2" },
      { joint: makeJoint("fixed", 0, 0, { origin: [0, 0, 0], axis: [1, 0, 0] }), bodyA: "i2", bodyB: "i3" },
    ];
    const constraints = lowerJoints(bindings);
    expect(constraints[0]!.kind).toBe("hinge");
    expect(constraints[0]!.axis).toEqual([0, 0, 1]);
    expect(constraints[1]!.kind).toBe("fixed");
  });
});
