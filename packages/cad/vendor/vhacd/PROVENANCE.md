# Vendored: vhacd-js

- **Package:** [`vhacd-js`](https://www.npmjs.com/package/vhacd-js)
- **Version:** `0.0.1` (pinned; vendored verbatim)
- **License:** BSD-3-Clause (see `LICENSE`)
- **Upstream algorithm:** [V-HACD](https://github.com/kmammou/v-hacd) by Khaled
  Mammou — the canonical Voxelized Hierarchical Approximate Convex Decomposition.

## Why this is vendored, not an npm dependency

Plastiq exists because the project's previous geometry/physics dependencies
(`@mechx/cad`, `@mechx/sim`) became unavailable. `vhacd-js` is a single-maintainer
`0.0.1` pre-release; depending on it from npm would reintroduce exactly the
supply-chain failure mode this project was created to escape. The runtime is small
(~190 KB, zero runtime deps) and self-contained, so we vendor it.

## What is vendored

Only the runtime needed at import time, under `lib/`:

| File | Role |
|------|------|
| `vhacd.js` | Public `ConvexMeshDecomposition` wrapper (the entry we import) |
| `vhacd-wasm-api.js` | Thin typed binding over the wasm module |
| `vhacd-wasm.js` | Emscripten glue with the **base64-embedded** wasm (`SINGLE_FILE` build — no separate `.wasm` asset, so it bundles and runs unchanged in a Web Worker and in Node) |
| `vhacd.d.ts`, `vhacd-wasm-api.d.ts` | Type declarations |

The C++ sources, build scripts, test fixtures, and prebuilt `.exe` from the npm
tarball are intentionally **not** vendored.

## Consumed by

`packages/cad/src/lower/decompose.ts` imports `./vendor/vhacd/lib/vhacd.js`
(relative), so resolution never depends on npm or a bundler `module` field.

## Updating

Replace the files under `lib/` from a newer `vhacd-js` tarball and bump the
version above. Keep the `lib/` layout — `vhacd.js` imports `../lib/vhacd-wasm.js`
relative to itself.
