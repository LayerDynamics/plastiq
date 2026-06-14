// component hierarchy + material library — UNIT tests.

import { describe, expect, it } from "vitest";

import { Body, Component, IDENTITY_PLACEMENT, defaultLibrary, makeBody } from "./component.js";

describe("component hierarchy (unit)", () => {
  it("makeBody builds a Body with id + material and no geometry yet", () => {
    const b = makeBody("b1", "steel");
    expect(b).toBeInstanceOf(Body);
    expect(b.id).toBe("b1");
    expect(b.material).toBe("steel");
    expect(b.geometry).toBeNull();
  });

  it("Component.addBody / addChild append to the tree", () => {
    const root = new Component("root");
    const child = new Component("child");
    const body = makeBody("b", "pla");
    root.addBody(body);
    root.addChild(child);
    expect(root.name).toBe("root");
    expect(root.bodies).toEqual([body]);
    expect(root.children).toEqual([child]);
  });

  it("IDENTITY_PLACEMENT is the origin with identity orientation", () => {
    expect(IDENTITY_PLACEMENT).toEqual({ position: [0, 0, 0], orientation: [0, 0, 0, 1] });
  });

  it("defaultLibrary.density returns known densities and THROWS on an unknown material", () => {
    const lib = defaultLibrary();
    expect(lib.density("structural-steel")).toBe(7850);
    expect(lib.density("aluminum")).toBe(2700);
    expect(lib.density("pla")).toBe(1240);
    expect(() => lib.density("unobtainium")).toThrow(/unknown material/);
  });
});
