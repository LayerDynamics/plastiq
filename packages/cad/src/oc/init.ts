// opencascade.js (OCCT → WebAssembly) engine initializer.
//
// Loads the TRIMMED, vendored OCCT build at packages/cad/vendor/occt/plastiq-occt.*
// — a custom opencascade.js compiled with bindings for ONLY the OCCT symbols the
// kernel uses (see occt.build.yml), so the shipped wasm is ~5 MB gzip instead of
// the ~13 MB gzip full prebuilt. (The full `opencascade.js` package stays a
// dependency: it supplies the API types here and is the source for rebuilding the
// trim.) The trimmed module is the same Emscripten ES6 factory as the full build
// — a default export taking `{ locateFile }` and resolving to the OCCT instance.
//
//  - Browser: the caller passes the bundler-resolved wasm URL (e.g. Vite `?url`),
//    returned from `locateFile` so the factory fetches it at runtime.
//  - Node/CI: resolve the vendored `.wasm` path next to this module and hand it
//    to `locateFile`; Emscripten reads it via fs.

import type { OpenCascadeInstance } from "opencascade.js";

/** The initialized OCCT engine handle. Typed against the full opencascade.js API
 * (a superset of the trimmed runtime — the kernel only calls the bound subset). */
export type Occt = OpenCascadeInstance;

type OcctFactory = (opts: { locateFile: (path: string) => string }) => Promise<Occt>;

let engine: Promise<Occt> | null = null;

function isNode(): boolean {
  // Probe the global without a hard @types/node dependency.
  const g = globalThis as { process?: { versions?: { node?: string } } };
  return Boolean(g.process?.versions?.node);
}

async function loadFactory(): Promise<OcctFactory> {
  const mod = (await import("../../vendor/occt/plastiq-occt.js")) as unknown as {
    default: OcctFactory;
  };
  return mod.default;
}

async function initBrowser(wasmUrl?: string): Promise<Occt> {
  const factory = await loadFactory();
  return factory({
    locateFile: (path: string) => (path.endsWith(".wasm") && wasmUrl ? wasmUrl : path),
  });
}

async function initNode(): Promise<Occt> {
  const factory = await loadFactory();
  // Resolve the vendored .wasm path next to this module using only web-standard
  // URL (so the package needs no @types/node). file:// → fs path: decode %xx and
  // strip a leading Windows drive slash if present.
  const wasmFileUrl = new URL("../../vendor/occt/plastiq-occt.wasm", import.meta.url);
  let wasmPath = decodeURIComponent(wasmFileUrl.pathname);
  if (/^\/[A-Za-z]:\//.test(wasmPath)) wasmPath = wasmPath.slice(1);
  return factory({ locateFile: (path: string) => (path.endsWith(".wasm") ? wasmPath : path) });
}

/**
 * Initialize (or return the memoized) OCCT engine. In the browser pass
 * `{ wasmUrl }` — the bundler-resolved URL of `plastiq-occt.wasm`.
 */
export function initOcct(opts?: { wasmUrl?: string }): Promise<Occt> {
  if (!engine) {
    engine = (isNode() ? initNode() : initBrowser(opts?.wasmUrl)).catch((err: unknown) => {
      // Don't poison the memo: a transient load failure (a network blip on the
      // wasm fetch, a momentary OOM) must not make every future call re-await
      // the same rejected promise — clear it so a later call can retry. Same
      // pattern as lower/decompose.ts initDecomposer.
      engine = null;
      throw err;
    });
  }
  return engine;
}
