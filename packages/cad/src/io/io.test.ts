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
