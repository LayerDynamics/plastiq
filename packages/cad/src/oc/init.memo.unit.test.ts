// initOcct memoization — UNIT (mocked wasm factory, NOT real OCCT).
//
// The memo must not cache a rejected promise: a transient load failure (network
// blip on the wasm fetch, momentary OOM) formerly poisoned `engine` forever, so
// every later call re-awaited the same rejection. The fix follows the documented
// pattern at lower/decompose.ts initDecomposer — clear the memo on rejection so
// a later call can retry — while a SUCCESSFUL init stays memoized.

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ factory: vi.fn() }));

// initOcct loads the vendored Emscripten factory via this dynamic import.
vi.mock("../../vendor/occt/plastiq-occt.js", () => ({ default: h.factory }));

beforeEach(() => {
  vi.resetModules(); // fresh module state → fresh `engine` memo per test
  h.factory.mockReset();
});

describe("initOcct does not poison its memo on a failed load", () => {
  it("a rejected init clears the memo so the next call retries (and can succeed)", async () => {
    const { initOcct } = await import("./init.js");
    const fake = { marker: "occt-instance" };
    h.factory.mockRejectedValueOnce(new Error("wasm fetch failed"));
    h.factory.mockResolvedValueOnce(fake);

    await expect(initOcct()).rejects.toThrow(/wasm fetch failed/);
    // Before the fix this returned the SAME rejected promise forever.
    await expect(initOcct()).resolves.toBe(fake);
    expect(h.factory).toHaveBeenCalledTimes(2);
  });

  it("concurrent callers of a failing init all see the rejection, then a retry works", async () => {
    const { initOcct } = await import("./init.js");
    const fake = { marker: "occt-instance" };
    h.factory.mockRejectedValueOnce(new Error("transient"));
    h.factory.mockResolvedValueOnce(fake);

    const [a, b] = [initOcct(), initOcct()];
    await expect(a).rejects.toThrow(/transient/);
    await expect(b).rejects.toThrow(/transient/);
    // Both awaited the ONE in-flight attempt (no duplicate load), and the memo
    // was cleared exactly once — the retry succeeds.
    expect(h.factory).toHaveBeenCalledTimes(1);
    await expect(initOcct()).resolves.toBe(fake);
    expect(h.factory).toHaveBeenCalledTimes(2);
  });

  it("a successful init stays memoized (a single factory call)", async () => {
    const { initOcct } = await import("./init.js");
    const fake = { marker: "occt-instance" };
    h.factory.mockResolvedValue(fake);

    const first = await initOcct();
    const second = await initOcct();
    expect(first).toBe(fake);
    expect(second).toBe(fake);
    expect(h.factory).toHaveBeenCalledTimes(1);
  });
});
