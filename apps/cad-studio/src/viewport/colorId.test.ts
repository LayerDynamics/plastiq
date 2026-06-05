import { describe, expect, it } from "vitest";
import { decodeId, encodeId, encodeIdFloat } from "./colorId.js";

describe("GPU color-id codec (NFR-4)", () => {
  it("round-trips ids through RGB bytes", () => {
    for (const id of [0, 1, 2, 255, 256, 65535, 65536, 1_000_000, 0xfffffe]) {
      const [r, g, b] = encodeId(id);
      expect(decodeId(r, g, b)).toBe(id);
    }
  });

  it("reserves the clear colour (0,0,0) as a miss, so id 0 is still pickable", () => {
    expect(decodeId(0, 0, 0)).toBeNull();
    expect(encodeId(0)).toEqual([0, 0, 1]); // id 0 → stored as 1
    expect(decodeId(0, 0, 1)).toBe(0);
  });

  it("float encoding matches the byte encoding / 255", () => {
    expect(encodeIdFloat(0)).toEqual([0, 0, 1 / 255]);
    const [r, g, b] = encodeId(70000);
    expect(encodeIdFloat(70000)).toEqual([r / 255, g / 255, b / 255]);
  });
});
