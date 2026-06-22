// @vitest-environment jsdom
//
// Shared File → string readers (used by the NeRF capture + image-attach flows).

import { describe, expect, it } from "vitest";
import { fileToBase64, fileToText } from "./fileRead.js";

describe("fileRead", () => {
  it("fileToText returns the file's text", async () => {
    const f = new File(['{"frames":[]}'], "transforms.json", { type: "application/json" });
    expect(await fileToText(f)).toBe('{"frames":[]}');
  });

  it("fileToBase64 strips the data-URL prefix and returns the base64 payload", async () => {
    const f = new File([new Uint8Array([1, 2, 3])], "v.png", { type: "image/png" });
    expect(await fileToBase64(f)).toBe("AQID"); // base64 of bytes [1,2,3]
  });
});
