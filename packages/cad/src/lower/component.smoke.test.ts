// component hierarchy — SMOKE tests: construct the types + look up a density.

import { describe, expect, it } from "vitest";

import { Component, defaultLibrary, makeBody } from "./component.js";

describe("component — smoke", () => {
  it("builds bodies/components and resolves a density without throwing", () => {
    const c = new Component("c");
    c.addBody(makeBody("b", "steel"));
    c.addChild(new Component("d"));
    expect(c.bodies).toHaveLength(1);
    expect(c.children).toHaveLength(1);
    expect(Number.isFinite(defaultLibrary().density("steel"))).toBe(true);
  });
});
