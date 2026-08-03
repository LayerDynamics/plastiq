// R8 kernel honesty pass — K5: exportForSim throws on a geometry-less body
// (a wiring bug) instead of silently omitting it from the SimManifest. The
// legitimate "body wrapping the bare part" path must still lower. Also §17:
// non-solid bodies (shells/faces) are rejected explicitly. Exercised against
// the real OCCT wasm.

import { beforeAll, describe, expect, it } from "vitest";

import { surfaceLoft } from "../action/surface.js";
import { offsetPlane, planeXY } from "../env/plane.js";
import { initOcct, type Occt } from "../oc/init.js";
import { Sketch } from "../sketch/sketch.js";
import { mm } from "../unit/index.js";
import { makeBox } from "../solid/primitives.js";
import { Component, defaultLibrary, makeBody } from "./component.js";
import { exportForSim } from "./export.js";
import { initDecomposer } from "./decompose.js";
import { isSimManifest } from "./manifest.js";

let oc: Occt;

beforeAll(async () => {
  oc = await initOcct();
  await initDecomposer();
}, 120_000);

describe("K5 — exportForSim rejects geometry-less bodies", () => {
  it("lowers a legitimate body that wraps the bare part (the body0 path)", () => {
    // This mirrors the synthesized body0 the worker builds around a bare part:
    // one component, one body carrying the part solid. It MUST still lower.
    const part = makeBox(oc, mm(20), mm(20), mm(20));
    const root = new Component("assembly");
    const comp = new Component("body0");
    comp.placement = { position: [0, 0, 0], orientation: [0, 0, 0, 1] };
    const body = makeBody("body0", "structural-steel");
    body.geometry = part; // the bare part wired in
    comp.addBody(body);
    root.addChild(comp);

    const manifest = exportForSim(oc, root, defaultLibrary(), "test", {});
    expect(isSimManifest(manifest)).toBe(true);
    expect(manifest.bodies).toHaveLength(1);
    expect(manifest.bodies[0]!.id).toBe("body0");
    part.delete();
  });

  it("throws a NAMED error identifying a mis-wired, geometry-less body", () => {
    // A Body whose `geometry` was never assigned is a wiring bug. The old code did
    // `if (!solid) continue;` and the body VANISHED from the manifest with no
    // error; now it must throw and name the offending body + component.
    const root = new Component("assembly");
    const comp = new Component("armLink");
    comp.placement = { position: [0, 0, 0], orientation: [0, 0, 0, 1] };
    const body = makeBody("linkBody", "structural-steel"); // geometry left null
    comp.addBody(body);
    root.addChild(comp);

    expect(() => exportForSim(oc, root, defaultLibrary(), "test", {})).toThrow(
      /body 'linkBody' in component 'armLink' has no geometry/,
    );
  });

  it("throws even when a GOOD body precedes the mis-wired one (no partial manifest)", () => {
    // Ordering guard: a valid body first must not mask a later geometry-less body.
    const part = makeBox(oc, mm(10), mm(10), mm(10));
    const root = new Component("assembly");

    const good = new Component("good");
    good.placement = { position: [0, 0, 0], orientation: [0, 0, 0, 1] };
    const goodBody = makeBody("goodBody", "structural-steel");
    goodBody.geometry = part;
    good.addBody(goodBody);
    root.addChild(good);

    const bad = new Component("bad");
    bad.placement = { position: [mm(50), 0, 0], orientation: [0, 0, 0, 1] };
    bad.addBody(makeBody("badBody", "structural-steel")); // null geometry
    root.addChild(bad);

    expect(() => exportForSim(oc, root, defaultLibrary(), "test", {})).toThrow(
      /body 'badBody' in component 'bad' has no geometry/,
    );
    part.delete();
  });
});

describe("exportForSim rejects non-solid bodies (§17)", () => {
  function square(half: number, z: number): Sketch {
    const sk = new Sketch(offsetPlane(planeXY(), z));
    sk.lineTo(-half, -half).lineTo(half, -half).lineTo(half, half).lineTo(-half, half);
    return sk;
  }

  it("throws a named error when a body is a shell, not a solid", () => {
    const shell = surfaceLoft(oc, [square(mm(20), 0), square(mm(10), mm(50))], {
      ruled: true,
    });
    const root = new Component("assembly");
    const comp = new Component("sheet");
    comp.placement = { position: [0, 0, 0], orientation: [0, 0, 0, 1] };
    const body = makeBody("sheetBody", "aluminum");
    body.geometry = shell;
    comp.addBody(body);
    root.addChild(comp);

    expect(() => exportForSim(oc, root, defaultLibrary(), "test", {})).toThrow(
      /body 'sheetBody' in component 'sheet' is a shell, not a solid/,
    );
    shell.delete();
  });
});
