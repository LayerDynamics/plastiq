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

  it("rejects a direct sub-assembly self-cycle, naming the path", () => {
    expect(() =>
      parseAssy({ links: [{ part: "a" }], subAssemblies: { a: { links: [{ part: "a" }] } } }),
    ).toThrow(/assy: sub-assembly cycle: a -> a/);
  });

  it("rejects a transitive sub-assembly cycle, naming the path", () => {
    expect(() =>
      parseAssy({
        links: [{ part: "a" }],
        subAssemblies: {
          a: { links: [{ part: "b" }] },
          b: { links: [{ part: "a" }] },
        },
      }),
    ).toThrow(/assy: sub-assembly cycle: a -> b -> a/);
  });

  it("valid deep nesting (and diamond sharing) still parses and realizes", () => {
    const doc = parseAssy({
      links: [{ part: "a" }],
      subAssemblies: {
        // a → b → c is a chain; a ALSO references c directly (diamond) — legal, not a cycle.
        a: { links: [{ part: "b" }, { part: "c" }] },
        b: { links: [{ part: "c" }] },
        c: { links: [{ part: "washer" }] },
      },
    });
    expect(realizeAssembly(doc).instances.map((i) => i.part)).toEqual(["washer", "washer"]);
    expect(deriveBOM(doc)).toEqual([{ part: "washer", count: 2 }]);
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

  it("round-trips fixed flags, mates, and joints through JSON (§2.11.3)", () => {
    // An editor-built model: grounded base + two placed parts, a coincident mate
    // with pick geometry, a valued distance mate, and a limited revolute joint.
    const model = realizeAssembly({
      links: [
        { part: "base", fixed: true },
        { part: "arm", location: { position: [0.1, 0, 0] } },
        { part: "cap", location: { position: [0.2, 0, 0], axis: [0, 0, 1], angle: 90 } },
      ],
      mates: [
        {
          kind: "coincident",
          a: { instance: 0, point: [0.01, 0.02, 0.03], dir: [0, 0, 1] },
          b: { instance: 1, point: [0, 0, 0] },
        },
        { kind: "distance", a: { instance: 1 }, b: { instance: 2 }, value: 0.05 },
      ],
      joints: [
        {
          kind: "revolute",
          parent: 0,
          child: 1,
          origin: [0.1, 0, 0],
          axis: [0, 0, 1],
          limits: { lower: -1.5, upper: 1.5 },
        },
      ],
    });
    // Through the REAL serialization boundary, like exportAssyFromStore/importAssyText.
    const round = realizeAssembly(parseAssy(JSON.parse(JSON.stringify(assemblyToAssy(model)))));

    expect(round.instances.map((i) => i.fixed ?? false)).toEqual([true, false, false]);
    for (let i = 0; i < 3; i++) {
      for (let a = 0; a < 3; a++) {
        expect(round.instances[i]!.pose.position[a]).toBeCloseTo(model.instances[i]!.pose.position[a]!, 9);
      }
      for (let a = 0; a < 4; a++) {
        expect(round.instances[i]!.pose.orientation[a]).toBeCloseTo(model.instances[i]!.pose.orientation[a]!, 9);
      }
    }

    expect(round.mates).toHaveLength(2);
    expect(round.mates[0]).toMatchObject({
      kind: "coincident",
      a: { instance: round.instances[0]!.id, point: [0.01, 0.02, 0.03], dir: [0, 0, 1] },
      b: { instance: round.instances[1]!.id, point: [0, 0, 0] },
    });
    expect(round.mates[1]).toMatchObject({
      kind: "distance",
      a: { instance: round.instances[1]!.id },
      b: { instance: round.instances[2]!.id },
      value: 0.05,
    });

    expect(round.joints).toHaveLength(1);
    expect(round.joints[0]).toMatchObject({
      kind: "revolute",
      parent: round.instances[0]!.id,
      child: round.instances[1]!.id,
      origin: [0.1, 0, 0],
      axis: [0, 0, 1],
      limits: { lower: -1.5, upper: 1.5 },
    });
  });

  it("throws (never silently drops) on a mate referencing an unknown instance id", () => {
    const model = realizeAssembly({ links: [{ part: "a" }, { part: "b" }] });
    model.mates.push({
      id: "m9",
      kind: "parallel",
      a: { instance: model.instances[0]!.id },
      b: { instance: "i-does-not-exist" },
    });
    expect(() => assemblyToAssy(model)).toThrow(/mate "m9".*unknown instance/);
  });
});

describe("grounding on realize (§2.11.3 — imported assemblies must not free-fall)", () => {
  it("grounds the first instance when no link declares fixed (addInstance convention)", () => {
    const model = realizeAssembly({ links: [{ part: "a" }, { part: "b" }] });
    expect(model.instances[0]!.fixed).toBe(true);
    expect(model.instances[1]!.fixed).toBeUndefined();
  });

  it("respects an explicit fixed link and does NOT add another ground", () => {
    const model = realizeAssembly({ links: [{ part: "a" }, { part: "b", fixed: true }] });
    expect(model.instances[0]!.fixed).toBeUndefined();
    expect(model.instances[1]!.fixed).toBe(true);
  });

  it("a fixed sub-assembly link grounds every instance it expands to", () => {
    const model = realizeAssembly({
      links: [{ part: "sub", fixed: true }, { part: "free" }],
      subAssemblies: { sub: { links: [{ part: "a" }, { part: "b" }] } },
    });
    expect(model.instances.map((i) => i.fixed ?? false)).toEqual([true, true, false]);
  });

  it("an empty document realizes with nothing to ground", () => {
    expect(realizeAssembly({ links: [] }).instances).toEqual([]);
  });
});

describe("mate/joint validation", () => {
  it("parse rejects a bad mate kind, ref shape, or missing value on valued kinds", () => {
    const base = { links: [{ part: "a" }, { part: "b" }] };
    expect(() =>
      parseAssy({ ...base, mates: [{ kind: "glued", a: { instance: 0 }, b: { instance: 1 } }] }),
    ).toThrow(/mate 0 kind/);
    expect(() =>
      parseAssy({ ...base, mates: [{ kind: "parallel", a: { instance: -1 }, b: { instance: 1 } }] }),
    ).toThrow(/non-negative integer/);
    expect(() =>
      parseAssy({ ...base, mates: [{ kind: "distance", a: { instance: 0 }, b: { instance: 1 } }] }),
    ).toThrow(/requires a finite numeric `value`/);
    expect(() =>
      parseAssy({ ...base, mates: [{ kind: "coincident", a: { instance: 0, point: [1, 2] }, b: { instance: 1 } }] }),
    ).toThrow(/point must be \[x,y,z\]/);
  });

  it("parse rejects a bad joint kind, zero axis, or malformed limits", () => {
    const base = { links: [{ part: "a" }, { part: "b" }] };
    expect(() =>
      parseAssy({ ...base, joints: [{ kind: "magnetic", parent: 0, child: 1, origin: [0, 0, 0], axis: [0, 0, 1] }] }),
    ).toThrow(/joint 0 kind/);
    expect(() =>
      parseAssy({ ...base, joints: [{ kind: "revolute", parent: 0, child: 1, origin: [0, 0, 0], axis: [0, 0, 0] }] }),
    ).toThrow(/axis` must be non-zero/);
    expect(() =>
      parseAssy({
        ...base,
        joints: [{ kind: "revolute", parent: 0, child: 1, origin: [0, 0, 0], axis: [0, 0, 1], limits: { lower: "x" } }],
      }),
    ).toThrow(/limits.lower/);
  });

  it("realize rejects an out-of-range instance index, naming the mate/joint", () => {
    expect(() =>
      realizeAssembly({
        links: [{ part: "a" }],
        mates: [{ kind: "parallel", a: { instance: 0 }, b: { instance: 7 } }],
      }),
    ).toThrow(/mate 0 references instance 7 but the document realizes only 1/);
    expect(() =>
      realizeAssembly({
        links: [{ part: "a" }],
        joints: [{ kind: "revolute", parent: 0, child: 3, origin: [0, 0, 0], axis: [0, 0, 1] }],
      }),
    ).toThrow(/joint 0 `child` references instance 3/);
  });

  it("parse rejects a non-boolean fixed flag", () => {
    expect(() => parseAssy({ links: [{ part: "a", fixed: 1 }] })).toThrow(/fixed` must be a boolean/);
  });
});
