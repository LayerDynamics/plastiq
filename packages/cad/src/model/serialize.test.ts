import { beforeAll, describe, expect, it } from "vitest";
import { canonicalize } from "../lower/canonical.js";
import { massProperties } from "../lower/massprops.js";
import { tessellate } from "../mesh/tessellate.js";
import { initOcct, type Occt } from "../oc/init.js";
import type { Solid } from "../solid/solid.js";
import { mm } from "../unit/index.js";
import {
  buildModel,
  defaultFeatureRegistry,
  parseModelDoc,
  serializeModelDoc,
  type ModelDoc,
} from "./serialize.js";

const INIT_TIMEOUT_MS = 120_000;

// A small parametric tree: a box with a smaller box subtracted (a CSG pocket).
const DOC: ModelDoc = {
  params: { wall: 0.002 },
  features: [
    { id: "base", type: "box", params: { dx: mm(40), dy: mm(30), dz: mm(20) } },
    { id: "tool", type: "box", params: { dx: mm(20), dy: mm(20), dz: mm(50) } },
    { id: "cut", type: "subtract", deps: ["base", "tool"] },
  ],
};

/** Build the doc, canonicalize the final solid's mass-props + mesh, clean up. */
function artifact(oc: Occt, doc: ModelDoc): string {
  const model = buildModel(oc, doc, defaultFeatureRegistry());
  const ids = ["base", "tool", "cut"];
  try {
    const cut = model.result("cut") as Solid;
    expect(model.status("cut")?.ok).toBe(true);
    return canonicalize({
      mass: massProperties(oc, cut, 2700),
      mesh: tessellate(oc, cut, { linearDeflection: mm(0.2) }),
    });
  } finally {
    for (const id of ids) (model.result(id) as Solid | undefined)?.delete();
  }
}

describe("reproducible model serialization (FR-34 / Q9)", () => {
  let oc: Occt;
  beforeAll(async () => {
    oc = await initOcct();
  }, INIT_TIMEOUT_MS);

  it("a model reloaded from its JSON rebuilds byte-identical geometry", () => {
    const original = artifact(oc, DOC);
    const json = serializeModelDoc(DOC);
    const reloaded = parseModelDoc(json);
    const rebuilt = artifact(oc, reloaded);
    expect(rebuilt).toBe(original);
  });

  it("serialization is stable (re-serializing a reloaded doc is identical)", () => {
    const json1 = serializeModelDoc(DOC);
    const json2 = serializeModelDoc(parseModelDoc(json1));
    expect(json2).toBe(json1);
  });

  it("an unknown feature type fails the build with a typed error", () => {
    const bad: ModelDoc = { features: [{ id: "x", type: "wormhole" }] };
    expect(() => buildModel(oc, bad, defaultFeatureRegistry())).toThrow(/unknown feature type/);
  });

  it("rejects malformed model JSON (NFR-3)", () => {
    expect(() => parseModelDoc('{"features": "nope"}')).toThrow(/features.*array/);
    expect(() => parseModelDoc('{"features": [{"type": "box"}]}')).toThrow(/string 'id'/);
  });
});
