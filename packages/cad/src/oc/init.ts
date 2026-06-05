// opencascade.js engine initializer (SPEC-4 Task 0.3).
//
// Loads the OCCT-on-WASM engine once and memoizes it. The SAME engine runs in
// the browser (the CAD editor) and under Node (tests/CI/headless): we pick the
// right package entry per environment. The engine is initialized
// SINGLE-THREADED (no worker passed) so boolean/mesh algorithms are
// deterministic for same-engine reproducibility (SPEC-4 C6 / NFR-2).
//
// During M0–M4 this loads the prebuilt FULL build; the trimmed production build
// (packages/cad/occt.build.yml, Task 0.2) is swapped in at M5 by repointing the
// dynamic import / locateFile — see scripts/build-occt.md.

import type { OpenCascadeInstance } from "opencascade.js";

/** The initialized OCCT engine handle. */
export type Occt = OpenCascadeInstance;

type InitFn = (settings?: { worker?: string; mainWasm?: string }) => Promise<Occt>;

let engine: Promise<Occt> | undefined;

function isNode(): boolean {
  // Avoid a hard @types/node dependency: probe the global without the type.
  const g = globalThis as { process?: { versions?: { node?: string } } };
  return Boolean(g.process?.versions?.node);
}

// Node uses the `node.js` entry (patches __dirname + self-locates the .wasm).
// @vite-ignore so bundlers don't try to pull node built-ins into a browser build.
async function initNode(): Promise<Occt> {
  const mod = (await import(/* @vite-ignore */ "opencascade.js/dist/node.js")) as {
    default: InitFn;
  };
  return mod.default();
}

// Browser: call the Emscripten factory in `opencascade.full.js` directly,
// passing the bundler-resolved wasm URL (e.g. Vite `?url`) through `locateFile`.
// We bypass the package's `index.js` because it does an ESM `import … .wasm`
// that bundlers (Vite) reject; the factory loads the wasm via runtime fetch.
async function initBrowser(wasmUrl?: string): Promise<Occt> {
  const mod = (await import("opencascade.js/dist/opencascade.full.js")) as unknown as {
    default: new (opts: { locateFile: (path: string) => string }) => Promise<Occt>;
  };
  const Factory = mod.default;
  return new Factory({
    locateFile: (path: string) => (path.endsWith(".wasm") && wasmUrl ? wasmUrl : path),
  });
}

/**
 * Initialize (or return the memoized) OCCT engine. Single-threaded.
 *
 * Repeated calls return the same instance — the WASM module is heavy (~48 MB)
 * and OCCT global state must be shared across the kernel. In the browser pass
 * `{ wasmUrl }` (the bundler-resolved URL of `opencascade.full.wasm`).
 */
export function initOcct(opts?: { wasmUrl?: string }): Promise<Occt> {
  if (engine === undefined) {
    engine = isNode() ? initNode() : initBrowser(opts?.wasmUrl);
  }
  return engine;
}

/**
 * Drop the memoized engine (test-only). The next {@link initOcct} re-initializes
 * a fresh instance — used by the reproducibility gate (Task 0.7) to prove two
 * independent inits agree.
 */
export function resetOcctForTesting(): void {
  engine = undefined;
}
