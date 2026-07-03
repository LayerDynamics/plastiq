import { beforeAll, describe, expect, it } from "vitest";
import { initOcct, isSimManifest, makeBox, mm, type Occt, type Solid } from "@plastiq/cad";
import { lowerAssembly } from "./lower.js";
import type { AssemblyModel } from "../assembly/model.js";

const INIT_TIMEOUT_MS = 120_000;

describe("lowerAssembly — assembly → SimManifest (SPEC-5 M4.5)", () => {
  let oc: Occt;
  let box: Solid;
  beforeAll(async () => {
    oc = await initOcct();
    box = makeBox(oc, mm(20), mm(20), mm(20)); // COM at (10,10,10) mm
  }, INIT_TIMEOUT_MS);

  it("lowers N instances to N bodies posed into the COM frame", () => {
    const assembly: AssemblyModel = {
      instances: [
        {
          id: "i0",
          name: "A",
          pose: { position: [0, 0, 0], orientation: [0, 0, 0, 1] },
          fixed: true,
        },
        { id: "i1", name: "B", pose: { position: [mm(80), 0, 0], orientation: [0, 0, 0, 1] } },
      ],
      mates: [],
      joints: [],
    };
    const { manifest, localCom } = lowerAssembly(oc, box, assembly, "test:asm");
    expect(isSimManifest(manifest)).toBe(true);
    expect(manifest.bodies).toHaveLength(2);
    expect(manifest.bodies.map((b) => b.id)).toEqual(["i0", "i1"]);
    // The shared part's local COM = the 20mm box centre (10,10,10) mm.
    expect(localCom[0]).toBeCloseTo(mm(10), 6);
    expect(localCom[2]).toBeCloseTo(mm(10), 6);
    // com = world centre of mass: i0 at origin → (10,10,10) mm; i1 offset +80 mm in x.
    expect(manifest.bodies[0]!.com[0]).toBeCloseTo(mm(10), 6);
    expect(manifest.bodies[1]!.com[0]).toBeCloseTo(mm(90), 6);
    // Each body carries a positive mass (volume × steel density).
    expect(manifest.bodies[0]!.mass).toBeGreaterThan(0);
    // i0 is grounded (the editor's "Fix" toggle) → it lowers to a static body;
    // i1 is free → no fixed flag, so it stays dynamic.
    expect(manifest.bodies[0]!.fixed).toBe(true);
    expect(manifest.bodies[1]!.fixed).toBeUndefined();
    // A grounded body still carries its real mass (backends key static off `fixed`).
    expect(manifest.bodies[0]!.mass).toBeCloseTo(manifest.bodies[1]!.mass, 9);
  });

  it("lowers a revolute joint to a hinge constraint between the two bodies", () => {
    const assembly: AssemblyModel = {
      instances: [
        {
          id: "i0",
          name: "A",
          pose: { position: [0, 0, 0], orientation: [0, 0, 0, 1] },
          fixed: true,
        },
        { id: "i1", name: "B", pose: { position: [mm(80), 0, 0], orientation: [0, 0, 0, 1] } },
      ],
      mates: [],
      joints: [
        {
          id: "j0",
          kind: "revolute",
          parent: "i0",
          child: "i1",
          origin: [mm(40), 0, 0],
          axis: [0, 0, 1],
        },
      ],
    };
    const { manifest, skippedJoints } = lowerAssembly(oc, box, assembly, "test:asm");
    expect(skippedJoints).toEqual([]);
    expect(manifest.constraints).toHaveLength(1);
    const c = manifest.constraints[0]!;
    expect(c.kind).toBe("hinge");
    expect((c as { bodyA: string; bodyB: string }).bodyA).toBe("i0");
    expect((c as { bodyB: string }).bodyB).toBe("i1");
  });

  it("skips non-lowerable joint kinds (prismatic has no V1 sim equivalent)", () => {
    const assembly: AssemblyModel = {
      instances: [
        {
          id: "i0",
          name: "A",
          pose: { position: [0, 0, 0], orientation: [0, 0, 0, 1] },
          fixed: true,
        },
        { id: "i1", name: "B", pose: { position: [mm(80), 0, 0], orientation: [0, 0, 0, 1] } },
      ],
      mates: [],
      joints: [
        {
          id: "j1",
          kind: "prismatic",
          parent: "i0",
          child: "i1",
          origin: [0, 0, 0],
          axis: [1, 0, 0],
        },
      ],
    };
    const { manifest, skippedJoints } = lowerAssembly(oc, box, assembly, "test:asm");
    expect(skippedJoints).toEqual(["j1"]);
    expect(manifest.constraints).toHaveLength(0);
    expect(isSimManifest(manifest)).toBe(true);
  });

  it("throws when the assembly has no instances", () => {
    expect(() => lowerAssembly(oc, box, { instances: [], mates: [], joints: [] }, "x")).toThrow(
      /no component instances/,
    );
  });
});
