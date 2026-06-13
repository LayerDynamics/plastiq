// Geometry Web Worker (SPEC-5 FR-5): runs @plastiq/cad (opencascade.js) off the
// main thread. It lazily inits OCCT, then on each build request rebuilds the
// document's feature tree, tags its tessellation (FR-6), and posts the result
// back as transferable typed arrays so the UI thread never blocks on OCCT.

import wasmUrl from "@plastiq/cad/vendor/occt/plastiq-occt.wasm?url";
import { initOcct, type Occt } from "@plastiq/cad";
import { handleRequest } from "./geometry.worker.core.js";
import type { WorkerRequest, WorkerResponse } from "./protocol.js";

// Loose worker-scope typing (avoids pulling the WebWorker lib alongside DOM).
const ctx = self as unknown as {
  postMessage(msg: WorkerResponse, transfer?: Transferable[]): void;
  onmessage: ((ev: MessageEvent<WorkerRequest>) => void) | null;
};

let ocPromise: Promise<Occt> | null = null;
const getOc = (): Promise<Occt> => (ocPromise ??= initOcct({ wasmUrl }));

// Thin RPC shim: init OCCT once, delegate the request to the pure core (which is
// unit-tested in geometry.worker.core.test.ts), then post its response back. A
// failure to init OCCT itself surfaces as a typed error response.
ctx.onmessage = (ev: MessageEvent<WorkerRequest>): void => {
  const req = ev.data;
  void (async (): Promise<void> => {
    try {
      const oc = await getOc();
      const { response, transfer } = await handleRequest(oc, req);
      ctx.postMessage(response, transfer);
    } catch (err) {
      ctx.postMessage({
        id: req.id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  })();
};
