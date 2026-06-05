import { beforeAll, describe, expect, it } from "vitest";
import { Component } from "../hierarchy/component.js";
import { makeBody } from "../hierarchy/body.js";
import { defaultLibrary } from "../material/library.js";
import { MATERIAL_PRESETS } from "../material/presets.js";
import { initOcct, type Occt } from "../oc/init.js";
import { makeBox } from "../solid/primitives.js";
import { mm } from "../unit/index.js";
import { exportForSim } from "./export.js";
import { isSimManifest } from "./manifest.js";

const INIT_TIMEOUT_MS = 120_000;

describe("exportForSim — hierarchy → SimManifest (FR-25/FR-26)", () => {
  let oc: Occt;
  beforeAll(async () => {
    oc = await initOcct();
  }, INIT_TIMEOUT_MS);

  it("a one-body model exports a valid manifest with exact mass props + box shape", () => {
    const root = new Component("part");
    const body = makeBody("block", "aluminum-6061");
    body.geometry = makeBox(oc, mm(20), mm(20), mm(20)); // 8e-6 m³
    root.addBody(body);
    try {
      const manifest = exportForSim(oc, root, defaultLibrary(), "test:block");
      expect(isSimManifest(manifest)).toBe(true);
      expect(manifest.bodies).toHaveLength(1);

      const b = manifest.bodies[0]!;
      expect(b.name).toBe("block");
      expect(b.shape.kind).toBe("box");
      // Aluminum density × volume.
      const density = MATERIAL_PRESETS["aluminum-6061"]!.density;
      expect(b.mass.volume).toBeCloseTo(8e-6, 12);
      expect(b.mass.mass).toBeCloseTo(density * 8e-6, 9);
      expect(b.material.density).toBe(density);
      // Body frame is COM-centred → com is the origin.
      expect(b.mass.com).toEqual([0, 0, 0]);
      // makeBox corner at origin → world COM at the box centre (0.01,0.01,0.01).
      expect(b.translation[0]).toBeCloseTo(0.01, 9);
      expect(b.translation[1]).toBeCloseTo(0.01, 9);
      expect(b.translation[2]).toBeCloseTo(0.01, 9);
      expect(b.orientation).toEqual([0, 0, 0, 1]);
      expect(manifest.constraints).toEqual([]);
    } finally {
      body.geometry?.delete();
    }
  });

  it("a component translation shifts the body's world COM", () => {
    const root = new Component("assembly");
    const sub = new Component("carrier");
    sub.placement = { position: [1, 0, 0], orientation: [0, 0, 0, 1] };
    const body = makeBody("block", "structural-steel");
    body.geometry = makeBox(oc, mm(20), mm(20), mm(20));
    sub.addBody(body);
    root.addChild(sub);
    try {
      const manifest = exportForSim(oc, root, defaultLibrary(), "test:placed");
      const b = manifest.bodies[0]!;
      // Local COM (0.01,0.01,0.01) translated by the carrier (+1 in x).
      expect(b.translation[0]).toBeCloseTo(1.01, 9);
      expect(b.translation[1]).toBeCloseTo(0.01, 9);
    } finally {
      body.geometry?.delete();
    }
  });

  it("exports multiple bodies across the tree", () => {
    const root = new Component("multi");
    const a = makeBody("a", "abs");
    a.geometry = makeBox(oc, mm(10), mm(10), mm(10));
    const b = makeBody("b", "brass");
    b.geometry = makeBox(oc, mm(15), mm(15), mm(15));
    root.addBody(a);
    root.addBody(b);
    try {
      const manifest = exportForSim(oc, root, defaultLibrary(), "test:multi");
      expect(isSimManifest(manifest)).toBe(true);
      expect(manifest.bodies.map((x) => x.name).sort()).toEqual(["a", "b"]);
    } finally {
      a.geometry?.delete();
      b.geometry?.delete();
    }
  });

  it("throws on a body with no geometry / no material / duplicate names", () => {
    const lib = defaultLibrary();

    const noGeom = new Component("g");
    noGeom.addBody(makeBody("x", "abs"));
    expect(() => exportForSim(oc, noGeom, lib, "s")).toThrow(/no geometry/);

    const noMat = new Component("m");
    const nm = makeBody("y");
    nm.geometry = makeBox(oc, mm(5), mm(5), mm(5));
    noMat.addBody(nm);
    try {
      expect(() => exportForSim(oc, noMat, lib, "s")).toThrow(/no material/);
    } finally {
      nm.geometry?.delete();
    }

    const dup = new Component("d");
    const d1 = makeBody("same", "abs");
    d1.geometry = makeBox(oc, mm(5), mm(5), mm(5));
    const d2 = makeBody("same", "abs");
    d2.geometry = makeBox(oc, mm(6), mm(6), mm(6));
    dup.addBody(d1);
    dup.addBody(d2);
    try {
      expect(() => exportForSim(oc, dup, lib, "s")).toThrow(/duplicate body name/);
    } finally {
      d1.geometry?.delete();
      d2.geometry?.delete();
    }
  });
});
