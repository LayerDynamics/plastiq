// SPEC-11 N11.3 (11-M3) — filename-based image↔frame pairing. The nerf service pairs
// images[i] ↔ frames[i] positionally, so a picker order that differs from the frames order
// would silently misassign poses. pairImagesToFrames reorders the selected images into FRAME
// order by filename, errors clearly on missing/ambiguous matches, and falls back to positional
// (flagged) when transforms carries no per-frame file paths.

import { describe, it, expect } from "vitest";
import { pairImagesToFrames, type NamedImage } from "./framePairing.js";

const img = (name: string, data: string): NamedImage => ({ name, data });
const transforms = (files: (string | null)[]): string =>
  JSON.stringify({ frames: files.map((f) => (f === null ? {} : { file_path: f })) });

describe("pairImagesToFrames — reorders to FRAME order by filename", () => {
  it("out-of-order picker selection is reordered to match the frames", () => {
    // Frames want v0, v1, v2; the picker handed them back v2, v0, v1.
    const images = [img("v2.png", "D2"), img("v0.png", "D0"), img("v1.png", "D1")];
    const result = pairImagesToFrames(images, transforms(["v0.png", "v1.png", "v2.png"]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.matched).toBe(true);
    expect(result.order.map((i) => i.data)).toEqual(["D0", "D1", "D2"]); // frame order, not picker order
  });

  it("strips directory prefixes and matches case-insensitively", () => {
    const images = [img("V1.PNG", "D1"), img("v0.png", "D0")];
    const result = pairImagesToFrames(images, transforms(["images/v0.png", "images/v1.png"]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.order.map((i) => i.data)).toEqual(["D0", "D1"]);
  });

  it("is extension-tolerant (frame path lacks or differs in extension)", () => {
    const images = [img("v1.jpeg", "D1"), img("v0.jpeg", "D0")];
    // transforms references bare stems / a different extension than the actual files.
    const result = pairImagesToFrames(images, transforms(["v0", "v1.png"]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.order.map((i) => i.data)).toEqual(["D0", "D1"]);
  });
});

describe("pairImagesToFrames — errors clearly", () => {
  it("count mismatch keeps the exact 'must match' wording the panel relies on", () => {
    const result = pairImagesToFrames([img("a.png", "A")], transforms(["a.png", "b.png"]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("must match");
    expect(result.error).toContain("(1)");
    expect(result.error).toContain("(2)");
  });

  it("a frame with no matching image errors (naming the missing file)", () => {
    const images = [img("v0.png", "D0"), img("v9.png", "D9")];
    const result = pairImagesToFrames(images, transforms(["v0.png", "v1.png"]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("v1.png");
  });

  it("an ambiguous filename (duplicate stems) errors instead of guessing", () => {
    const images = [img("v0.png", "D0a"), img("v0.jpg", "D0b")];
    const result = pairImagesToFrames(images, transforms(["v0", "v0"]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.toLowerCase()).toContain("multiple");
  });

  it("invalid JSON and a missing frames array error clearly", () => {
    expect(pairImagesToFrames([], "{not json")).toEqual({ ok: false, error: "transforms.json is not valid JSON." });
    expect(pairImagesToFrames([], JSON.stringify({ foo: 1 }))).toEqual({
      ok: false,
      error: "transforms.json has no 'frames' array.",
    });
  });

  it("some-but-not-all frames carrying file_path is an error (can't pair reliably)", () => {
    const images = [img("a.png", "A"), img("b.png", "B")];
    const result = pairImagesToFrames(images, transforms(["a.png", null]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("missing 'file_path'");
  });
});

describe("pairImagesToFrames — positional fallback when no file paths", () => {
  it("keeps selection order and flags matched:false with a note", () => {
    const images = [img("first.png", "D0"), img("second.png", "D1")];
    const result = pairImagesToFrames(images, transforms([null, null]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.matched).toBe(false);
    expect(result.order.map((i) => i.data)).toEqual(["D0", "D1"]); // unchanged selection order
    expect(result.note).toBeTruthy();
    expect(result.note).toContain("selection order");
  });
});
