// R8 §5.6 — the geometry bridge must not hang forever on a silent worker.

import { describe, expect, it } from "vitest";

import { GeometryClient } from "./bridge.js";

describe("GeometryClient worker timeout (CADStudio.md §5.6)", () => {
  it("rejects a request when the worker never responds", async () => {
    // A worker that accepts postMessage but never posts a reply.
    const silent = {
      postMessage: () => {},
      terminate: () => {},
      onmessage: null,
      onerror: null,
      addEventListener: () => {},
      removeEventListener: () => {},
    } as unknown as Worker;

    const client = new GeometryClient({ worker: silent, timeoutMs: 50 });
    await expect(client.build({ features: [], params: {} })).rejects.toThrow(/timed out/);
    client.dispose();
  });

  it("resolves normally when the worker replies before the timeout", async () => {
    // A worker that echoes a valid build response on the next tick.
    const responder = {
      postMessage(msg: { id: number; op: string }) {
        queueMicrotask(() => {
          responder.onmessage?.({
            data: { id: msg.id, ok: true, op: "build", mesh: null },
          } as MessageEvent);
        });
      },
      terminate: () => {},
      onmessage: null as ((ev: MessageEvent) => void) | null,
      onerror: null,
      addEventListener: () => {},
      removeEventListener: () => {},
    };
    const client = new GeometryClient({ worker: responder as unknown as Worker, timeoutMs: 1000 });
    await expect(client.build({ features: [], params: {} })).resolves.toBeNull();
    client.dispose();
  });

  it("rejects with the worker's error message when it replies {ok:false} (R5)", async () => {
    // A worker that replies with a typed error (the kernel's per-feature message).
    const failer = {
      postMessage(msg: { id: number }) {
        queueMicrotask(() => {
          failer.onmessage?.({
            data: { id: msg.id, ok: false, error: "feature 'f2' (fillet): boom" },
          } as MessageEvent);
        });
      },
      terminate: () => {},
      onmessage: null as ((ev: MessageEvent) => void) | null,
      onerror: null,
      addEventListener: () => {},
      removeEventListener: () => {},
    };
    const client = new GeometryClient({ worker: failer as unknown as Worker, timeoutMs: 1000 });
    // Await the rejection BEFORE disposing — the error reply is delivered on a
    // microtask, so disposing first would reject with "disposed" instead.
    await expect(client.build({ features: [], params: {} })).rejects.toThrow(
      /feature 'f2' \(fillet\): boom/,
    );
    client.dispose();
  });

  it("dispose() rejects in-flight requests instead of leaving them to hang (R4)", async () => {
    // A worker that NEVER replies — without the dispose-rejects fix, this awaits
    // forever (or until the 120s timeout). dispose() must settle it promptly.
    const silent = {
      postMessage: () => {},
      terminate: () => {},
      onmessage: null,
      onerror: null,
      addEventListener: () => {},
      removeEventListener: () => {},
    } as unknown as Worker;

    const client = new GeometryClient({ worker: silent, timeoutMs: 60_000 });
    const inFlight = client.build({ features: [], params: {} });
    client.dispose(); // must reject the pending build now, not after 60s
    await expect(inFlight).rejects.toThrow(/disposed/);
  });
});
