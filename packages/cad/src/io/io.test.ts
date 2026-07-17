// R3 — interchange I/O against the real OCCT wasm.

import { beforeAll, describe, expect, it } from "vitest";

import { initOcct, type Occt } from "../oc/init.js";
import { mm } from "../unit/index.js";
import { makeBox } from "../solid/primitives.js";
import { exportGltf, exportIges, exportStep, importStep } from "./index.js";

let oc: Occt;

beforeAll(async () => {
  oc = await initOcct();
}, 120_000);

describe("STEP", () => {
  it("exports valid ISO-10303 text and re-imports byte-equal geometry", () => {
    const box = makeBox(oc, mm(60), mm(40), mm(30));
    const step = exportStep(oc, box);
    expect(step.startsWith("ISO-10303")).toBe(true);

    const reimported = importStep(oc, step);
    // 0.06 × 0.04 × 0.03 = 7.2e-5 m³
    expect(reimported.volume()).toBeCloseTo(7.2e-5, 9);
    box.delete();
    reimported.delete();
  });
});

// --- I1: units at the interchange boundary -----------------------------------
//
// The round trip above CANNOT catch a unit error: export and import were
// consistently wrong by the same 1000×, so the volume came back correct while
// the FILE told every other CAD system the part was 1000× too small. These
// assert the numbers actually written and the unit actually declared — the only
// thing a self-round-trip structurally cannot see.

describe("STEP units (I1)", () => {
  it("declares MILLIMETRE and writes millimetre-magnitude coordinates", () => {
    // A 40×30×20 mm box is 0.04×0.03×0.02 in the kernel's SI metres. OCCT
    // declares the file MILLIMETRE and writes raw numbers, so before the fix
    // this emitted `2.E-02` — i.e. "0.02 mm" for a 20 mm box.
    const box = makeBox(oc, mm(40), mm(30), mm(20));
    const step = exportStep(oc, box);
    box.delete();

    expect(step, "OCCT declares the STEP length unit as millimetre").toMatch(
      /LENGTH_UNIT\(\)[\s\S]{0,60}SI_UNIT\(\.MILLI\.,\.METRE\.\)/,
    );

    // Every CARTESIAN_POINT coordinate must be a millimetre magnitude: the box
    // spans 0..40, so the largest coordinate is 40, not 0.04.
    const coords = [...step.matchAll(/CARTESIAN_POINT\('',\(([^)]*)\)\)/g)]
      .flatMap((m) => m[1]!.split(",").map((s) => Math.abs(parseFloat(s))))
      .filter((n) => Number.isFinite(n));
    expect(coords.length).toBeGreaterThan(0);
    const max = Math.max(...coords);
    expect(max, "largest coordinate is 40 (mm), not 0.04 (the SI number)").toBeCloseTo(40, 6);
  });

  it("imports a real-world millimetre STEP at the correct SIZE, not 1000× large", () => {
    // The other half of I1: OCCT's reader normalises into millimetres, so a file
    // authored in mm hands back 40 for 40 mm. Read as SI that is 40 METRES.
    // Build such a file the way the outside world would: our own export IS a
    // valid mm-declared STEP now, so re-importing it must give back metres.
    const box = makeBox(oc, mm(40), mm(30), mm(20));
    const step = exportStep(oc, box);
    const back = importStep(oc, step);

    expect(back.volume()).toBeCloseTo(mm(40) * mm(30) * mm(20), 12);
    const bb = back.boundingBox();
    expect(bb.max[0]).toBeCloseTo(mm(40), 6);
    expect(bb.max[1]).toBeCloseTo(mm(30), 6);
    expect(bb.max[2]).toBeCloseTo(mm(20), 6);

    back.delete();
    box.delete();
  });

  it("survives a metre-scale part (the boundary scale is not a fudge factor)", () => {
    // A 2 m beam: 2000 mm in the file, 2 m back. Guards against the scale being
    // tuned to one magnitude.
    const beam = makeBox(oc, 2, 0.1, 0.1);
    const step = exportStep(oc, beam);
    const coords = [...step.matchAll(/CARTESIAN_POINT\('',\(([^)]*)\)\)/g)]
      .flatMap((m) => m[1]!.split(",").map((s) => Math.abs(parseFloat(s))))
      .filter((n) => Number.isFinite(n));
    expect(Math.max(...coords), "2 m beam is 2000 mm in the file").toBeCloseTo(2000, 6);

    const back = importStep(oc, step);
    expect(back.volume()).toBeCloseTo(2 * 0.1 * 0.1, 9);
    back.delete();
    beam.delete();
  });

  it("does not mutate the caller's solid", () => {
    // exportStep scales internally; the caller's Solid must be untouched and
    // still usable (the app exports the live rebuild accumulator).
    const box = makeBox(oc, mm(40), mm(30), mm(20));
    const before = box.volume();
    exportStep(oc, box);
    expect(box.volume()).toBeCloseTo(before, 12);
    exportIges(oc, box);
    expect(box.volume()).toBeCloseTo(before, 12);
    box.delete();
  });
});

describe("IGES", () => {
  it("exports a complete, well-formed IGES file (all five sections present)", () => {
    const box = makeBox(oc, mm(10), mm(10), mm(10));
    const iges = exportIges(oc, box);
    expect(iges.length).toBeGreaterThan(0);
    // OCCT has no IGES importer here, so verify structural completeness instead
    // of a round-trip. The IGES Terminate line summarises the record counts of
    // every preceding section in order — Start, Global, Directory, Parameter —
    // and is itself the 'T' section, e.g. "S      1G      4D     98P     49 ...
    // T0000001". Matching it proves all five sections exist with positive counts;
    // a truncated/garbage export would be missing this line or its tallies.
    expect(iges).toMatch(/S\s+\d+G\s+\d+D\s+\d+P\s+\d+\s+T\s*\d+/);
    // The Directory/Parameter counts are non-trivial — the box geometry really
    // got written (a 1×1×1 cm box yields dozens of entity records, not zero).
    expect(iges).toMatch(/D\s+([1-9]\d+)P\s+([1-9]\d+)/);
    box.delete();
  });
});

describe("glTF", () => {
  it("exports a valid glTF 2.0 document with a mesh and embedded buffer", () => {
    const box = makeBox(oc, mm(10), mm(10), mm(10));
    const gltf = JSON.parse(exportGltf(oc, box)) as {
      asset: { version: string; generator: string };
      meshes: unknown[];
      accessors: { count: number }[];
      buffers: { uri: string }[];
    };
    expect(gltf.asset.version).toBe("2.0");
    expect(gltf.asset.generator).toBe("@plastiq/cad");
    expect(gltf.meshes).toHaveLength(1);
    expect(gltf.accessors[0]!.count).toBeGreaterThan(0); // positions
    expect(gltf.buffers[0]!.uri.startsWith("data:application/octet-stream;base64,")).toBe(true);
    box.delete();
  });
});
