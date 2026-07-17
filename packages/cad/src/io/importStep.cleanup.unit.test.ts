// importStep failure-path cleanup — UNIT (fake kernel, NOT real OCCT).
//
// `reader.OneShape()` is an owned embind handle even when null, so the
// empty-shape rejection must free it before throwing (the boolean.ts finish()
// convention) — it formerly leaked in the long-lived geometry worker. Same
// `.delete()`-spy pattern as action/cleanup.unit.test.ts.

import { beforeEach, describe, expect, it } from "vitest";

import type { Occt } from "../oc/init.js";
import { importStep } from "./index.js";

let deleted: string[];
const del = (label: string) => () => deleted.push(label);

beforeEach(() => {
  deleted = [];
});

const RET_DONE = 1;

/** The scaled shape `scale()` hands back — distinct from the raw imported one. */
const SCALED = { IsNull: () => false, delete: del("SCALED") };

function makeOc(reader: object): Occt {
  return {
    FS: { writeFile: () => {} },
    IFSelect_ReturnStatus: { IFSelect_RetDone: RET_DONE },
    STEPControl_Reader_1: function () {
      return reader;
    },
    Message_ProgressRange_1: function () {
      return { delete: del("progress") };
    },
    // importStep converts the reader's millimetres to kernel metres (I1), which
    // goes through action/transform `scale` — so the fake kernel must supply the
    // transform machinery it uses.
    gp_Trsf_1: function () {
      return { SetScale: () => {}, delete: del("trsf") };
    },
    gp_Pnt_3: function () {
      return { delete: del("pnt") };
    },
    BRepBuilderAPI_Transform_2: function () {
      return { Shape: () => SCALED, delete: del("xform") };
    },
  } as unknown as Occt;
}

describe("importStep frees the null OneShape() handle before throwing", () => {
  it("deletes the null shape plus the reader and progress range", () => {
    const oc = makeOc({
      ReadFile: () => RET_DONE,
      TransferRoots: () => {},
      OneShape: () => ({ IsNull: () => true, delete: del("shape") }),
      delete: del("reader"),
    });

    expect(() => importStep(oc, "ISO-10303-21;")).toThrow(/empty shape/);
    // The fix: the null OneShape() handle is freed (it leaked before).
    expect(deleted).toContain("shape");
    expect(deleted).toEqual(expect.arrayContaining(["shape", "reader", "progress"]));
  });

  it("a failed ReadFile still frees the reader and progress (finally)", () => {
    const oc = makeOc({
      ReadFile: () => 0, // not RetDone
      TransferRoots: () => {},
      OneShape: () => ({ IsNull: () => true, delete: del("shape") }),
      delete: del("reader"),
    });

    expect(() => importStep(oc, "garbage")).toThrow(/STEP read/);
    expect(deleted).toEqual(expect.arrayContaining(["reader", "progress"]));
  });

  it("on success returns the SCALED shape and frees the raw millimetre one", () => {
    // I1 changed this contract deliberately. importStep no longer hands the
    // reader's shape straight to the Solid: that shape is in MILLIMETRES (OCCT
    // normalises every file into mm), so it is scaled to kernel metres and the
    // raw one becomes an intermediate. An intermediate that is not freed is a
    // leak in the long-lived worker — exactly what this file exists to catch —
    // so assert BOTH halves: the caller gets the scaled shape, and the mm shape
    // is released.
    const raw = { IsNull: () => false, delete: del("RAW-MM") };
    const oc = makeOc({
      ReadFile: () => RET_DONE,
      TransferRoots: () => {},
      OneShape: () => raw,
      delete: del("reader"),
    });

    const solid = importStep(oc, "ISO-10303-21;");
    expect(solid.shape, "the caller receives the metre-scaled shape").toBe(SCALED);
    expect(deleted, "the raw millimetre shape is an intermediate and must be freed").toContain(
      "RAW-MM",
    );
    // The scaled shape is owned by the returned Solid — it must NOT be freed.
    expect(deleted).not.toContain("SCALED");
    // And every transform temporary is released too.
    expect(deleted).toEqual(expect.arrayContaining(["reader", "progress", "trsf", "pnt", "xform"]));
  });
});
