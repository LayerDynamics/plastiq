// M4 — declarative `.assy` assembly description + auto-BOM (partcad-inspired; our own schema).
// Parse → realize into the AssemblyModel → derive a rolled-up BOM, and round-trip back. Pure,
// deterministic (docs/adr/0004).

import { describe, expect, it } from "vitest";

import { parseAssy, realizeAssembly, deriveBOM, assemblyToAssy, type AssyDoc } from "./assy.js";

describe("parseAssy", () => {
  it("accepts a well-formed document", () => {
    const doc = parseAssy({ name: "widget", links: [{ part: "plate" }, { part: "bolt" }] });
    expect(doc.links).toHaveLength(2);
    expect(doc.links[0]!.part).toBe("plate");
  });

  it("rejects malformed input", () => {
    expect(() => parseAssy(null)).toThrow();
    expect(() => parseAssy({})).toThrow(/links/);
    expect(() => parseAssy({ links: [{}] })).toThrow(/part/);
    expect(() => parseAssy({ links: [{ part: 5 }] })).toThrow(/part/);
  });
});

describe("realizeAssembly", () => {
  it("places one instance per leaf link, with the location's pose", () => {
    const doc: AssyDoc = {
      links: [
        { part: "plate" },
        { part: "bolt", name: "bolt-1", location: { position: [10, 0, 0] } },
      ],
    };
    const model = realizeAssembly(doc);
    expect(model.instances).toHaveLength(2);
    expect(model.instances[1]!.name).toBe("bolt-1");
    expect(model.instances[1]!.pose.position).toEqual([10, 0, 0]);
    expect(model.instances[0]!.pose.orientation).toEqual([0, 0, 0, 1]); // identity when no axis/angle
  });

  it("composes a sub-assembly's placement with its children (recursive nesting)", () => {
    const doc: AssyDoc = {
      links: [{ part: "sub", location: { position: [0, 0, 10] } }],
      subAssemblies: { sub: { links: [{ part: "bolt", location: { position: [1, 0, 0] } }] } },
    };
    const model = realizeAssembly(doc);
    expect(model.instances).toHaveLength(1);
    expect(model.instances[0]!.name).toBe("bolt");
    // child [1,0,0] under parent translate [0,0,10] → world [1,0,10]
    expect(model.instances[0]!.pose.position[0]).toBeCloseTo(1, 9);
    expect(model.instances[0]!.pose.position[2]).toBeCloseTo(10, 9);
  });

  it("a 90° sub-assembly rotation rotates the child's offset", () => {
    const doc: AssyDoc = {
      links: [{ part: "sub", location: { axis: [0, 0, 1], angle: 90 } }],
      subAssemblies: { sub: { links: [{ part: "pin", location: { position: [1, 0, 0] } }] } },
    };
    const p = realizeAssembly(doc).instances[0]!.pose.position;
    expect(p[0]).toBeCloseTo(0, 6); // [1,0,0] rotated 90° about +Z → [0,1,0]
    expect(p[1]).toBeCloseTo(1, 6);
  });

  it("generates deterministic, unique instance ids", () => {
    const doc: AssyDoc = { links: [{ part: "a" }, { part: "a" }] };
    const a = realizeAssembly(doc).instances.map((i) => i.id);
    const b = realizeAssembly(doc).instances.map((i) => i.id);
    expect(a).toEqual(b); // deterministic
    expect(new Set(a).size).toBe(2); // unique
  });
});

describe("deriveBOM", () => {
  it("counts leaf parts, expanding sub-assemblies, rolled up and sorted", () => {
    const doc: AssyDoc = {
      links: [{ part: "plate" }, { part: "sub" }, { part: "sub" }],
      subAssemblies: { sub: { links: [{ part: "bolt" }, { part: "bolt" }, { part: "bolt" }] } },
    };
    expect(deriveBOM(doc)).toEqual([
      { part: "bolt", count: 6 }, // 2 subs × 3 bolts
      { part: "plate", count: 1 },
    ]);
  });

  it("an empty assembly has an empty BOM", () => {
    expect(deriveBOM({ links: [] })).toEqual([]);
  });
});

describe("assemblyToAssy (round-trip)", () => {
  it("exports a model to a doc that realizes back to the same instances", () => {
    const doc: AssyDoc = {
      links: [{ part: "plate" }, { part: "bolt", name: "b1", location: { position: [5, 0, 0] } }],
    };
    const model = realizeAssembly(doc);
    const exported = assemblyToAssy(model);
    const round = realizeAssembly(exported);
    expect(round.instances).toHaveLength(2);
    expect(round.instances[1]!.pose.position).toEqual([5, 0, 0]);
    expect(deriveBOM(exported).map((e) => e.part).sort()).toEqual(["bolt", "plate"]);
  });
});
