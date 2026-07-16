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

  it("on success the imported shape is handed to the Solid, not deleted", () => {
    const kept = { IsNull: () => false, delete: del("SHAPE-KEPT") };
    const oc = makeOc({
      ReadFile: () => RET_DONE,
      TransferRoots: () => {},
      OneShape: () => kept,
      delete: del("reader"),
    });

    const solid = importStep(oc, "ISO-10303-21;");
    expect(solid.shape).toBe(kept);
    expect(deleted).toEqual(expect.arrayContaining(["reader", "progress"]));
    expect(deleted).not.toContain("SHAPE-KEPT");
  });
});
