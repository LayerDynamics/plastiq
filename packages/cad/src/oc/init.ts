// opencascade.js (OCCT → WebAssembly) engine initializer.
//
// One engine instance, memoized. Two load paths:
//  - Browser: call the Emscripten factory in `opencascade.full.js` directly,
//    passing the bundler-resolved wasm URL (e.g. Vite `?url`) through
//    `locateFile`. We bypass the package's `index.js` because it does an ESM
//    `import … .wasm` that bundlers (Vite) reject; the factory fetches the wasm
//    at runtime.
//  - Node/CI: the `node.js` entry patches __dirname and self-locates the wasm.
//    Marked `@vite-ignore` so the browser build never pulls Node built-ins.

import type { OpenCascadeInstance } from "opencascade.js";

/** The initialized OCCT engine handle (the full opencascade.js instance). */
export type Occt = OpenCascadeInstance;

let engine: Promise<Occt> | null = null;

function isNode(): boolean {
  // Probe the global without a hard @types/node dependency.
  const g = globalThis as { process?: { versions?: { node?: string } } };
  return Boolean(g.process?.versions?.node);
}

async function initNode(): Promise<Occt> {
  const mod = (await import(/* @vite-ignore */ "opencascade.js/dist/node.js")) as {
    default: (settings?: { mainWasm?: string }) => Promise<Occt>;
  };
  return mod.default();
}

async function initBrowser(wasmUrl?: string): Promise<Occt> {
  const mod = (await import("opencascade.js/dist/opencascade.full.js")) as unknown as {
    default: new (opts: { locateFile: (path: string) => string }) => Promise<Occt>;
  };
  return new mod.default({
    locateFile: (path: string) => (path.endsWith(".wasm") && wasmUrl ? wasmUrl : path),
  });
}

/**
 * Initialize (or return the memoized) OCCT engine. In the browser pass
 * `{ wasmUrl }` — the bundler-resolved URL of `opencascade.full.wasm`.
 */
export function initOcct(opts?: { wasmUrl?: string }): Promise<Occt> {
  if (!engine) {
    engine = isNode() ? initNode() : initBrowser(opts?.wasmUrl);
  }
  return engine;
}
