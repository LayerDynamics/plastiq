// component hierarchy — INTEGRATION: build a parent/child assembly tree of bodies
// and mass each one through the material library (the real lowering shape: a tree of
// bodies whose mass is volume × material density).

import { describe, expect, it } from "vitest";

import { Component, defaultLibrary, makeBody } from "./component.js";

describe("component — assembly tree + material lookup (integration)", () => {
  it("nests bodies in a tree and masses each via the library", () => {
    const lib = defaultLibrary();
    const root = new Component("root");
    root.addBody(makeBody("frame", "structural-steel"));
    const sub = new Component("sub");
    sub.addBody(makeBody("panel", "aluminum"));
    root.addChild(sub);

    const litre = 0.001; // m³
    const frame = root.bodies[0]!;
    const panel = root.children[0]!.bodies[0]!;
    expect(litre * lib.density(frame.material)).toBeCloseTo(7.85, 9); // steel
    expect(litre * lib.density(panel.material)).toBeCloseTo(2.7, 9); // aluminium
  });
});
