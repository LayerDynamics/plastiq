// @vitest-environment jsdom
// Geometry-worker RPC shim (Review #17): the worker's OWN OCCT-init memo must
// not cache a rejected promise (decompose.ts pattern; initOcct itself was fixed
// in 8db2d10, but the shim memoizes the promise again). A transient init
// failure surfaces as a typed error response AND the next request retries the
// init instead of re-awaiting the poisoned promise.
//
// jsdom provides the `self` the shim binds its onmessage/postMessage to; the
// heavyweight pieces (initOcct, the pure request core) are mocked so this
// exercises exactly the shim's memo + error-envelope logic.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkerRequest } from "./protocol.js";

const { initOcctMock, handleRequestMock } = vi.hoisted(() => ({
  initOcctMock: vi.fn(),
  handleRequestMock: vi.fn(),
}));

vi.mock("@plastiq/cad", () => ({ initOcct: initOcctMock }));
vi.mock("@plastiq/cad/vendor/occt/plastiq-occt.wasm?url", () => ({ default: "occt.wasm" }));
vi.mock("./geometry.worker.core.js", () => ({ handleRequest: handleRequestMock }));

type WorkerScope = {
  onmessage: ((ev: { data: WorkerRequest }) => void) | null;
  postMessage: (msg: unknown, transfer?: unknown[]) => void;
};

afterEach(() => {
  vi.clearAllMocks();
});

describe("geometry.worker shim", () => {
  it("a failed OCCT init responds with a typed error and does NOT poison the memo", async () => {
    const fakeOc = { fake: "occt" };
    initOcctMock
      .mockRejectedValueOnce(new Error("wasm fetch failed"))
      .mockResolvedValue(fakeOc);
    handleRequestMock.mockImplementation((_oc: unknown, req: WorkerRequest) =>
      Promise.resolve({ response: { id: req.id, ok: true }, transfer: [] }),
    );

    await import("./geometry.worker.js"); // binds self.onmessage
    const scope = self as unknown as WorkerScope;
    const posted = vi.fn();
    scope.postMessage = posted; // jsdom's window.postMessage rejects our transfer arg
    const onmessage = scope.onmessage;
    expect(onmessage).toBeTypeOf("function");

    // 1st request: init rejects → typed error envelope, no crash.
    onmessage!({ data: { id: 1 } as WorkerRequest });
    await vi.waitFor(() => expect(posted).toHaveBeenCalledTimes(1));
    expect(posted.mock.calls[0]![0]).toEqual({
      id: 1,
      ok: false,
      error: "wasm fetch failed",
    });
    expect(handleRequestMock).not.toHaveBeenCalled();

    // 2nd request: the memo must have been cleared → initOcct is retried and
    // the request now succeeds. (With a poisoned memo, initOcct would still
    // have exactly 1 call and this would fail again.)
    onmessage!({ data: { id: 2 } as WorkerRequest });
    await vi.waitFor(() => expect(posted).toHaveBeenCalledTimes(2));
    expect(initOcctMock).toHaveBeenCalledTimes(2);
    expect(posted.mock.calls[1]![0]).toEqual({ id: 2, ok: true });
    expect(handleRequestMock).toHaveBeenCalledWith(fakeOc, { id: 2 });

    // 3rd request: a SUCCESSFUL init stays memoized — no third init.
    onmessage!({ data: { id: 3 } as WorkerRequest });
    await vi.waitFor(() => expect(posted).toHaveBeenCalledTimes(3));
    expect(initOcctMock).toHaveBeenCalledTimes(2);
    expect(posted.mock.calls[2]![0]).toEqual({ id: 3, ok: true });
  });
});
