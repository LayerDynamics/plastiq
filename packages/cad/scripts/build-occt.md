# Building the trimmed `opencascade.js` for @plastiq/cad

The kernel runs on `opencascade.js` (full OCCT → WebAssembly via Emscripten).
Two builds are in play:

| Build                | Source                                                     | Size                         | Used for                                                      |
| -------------------- | ---------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------- |
| **Full (prebuilt)**  | `opencascade.js` npm package (pinned `2.0.0-beta.b5ff984`) | ~48 MB raw / **~14 MB gzip** | **Development + tests (now).** The proven, complete OCCT.     |
| **Trimmed (custom)** | `occt.build.yml` → Docker build → `vendor/plastiq-occt.*`  | target **≤ 3 MB gzip**       | **Production browser bundle (later).** Only the symbols used. |

## Why the trim is deferred (not stubbed)

A custom build includes only the OCCT **symbols you list** in `occt.build.yml`.
That list must match the kernel's actual OCCT surface — which is enumerable from
`packages/cad/src/` and is captured in `occt.build.yml`. The trim is **optional
and deferred**: shipping the full prebuilt build is correct and complete; the
trim is purely a bundle-size optimisation (NFR-4). So today the engine
initialiser (`src/oc/init.ts`) loads the full `opencascade.js`; running the trim
is a follow-up once the bundle budget needs it.

## Running the trimmed build

Requires Docker. The build compiles the selected OCCT toolkits via Emscripten —
expect **30–90 min** and several GB.

```sh
just cad-occt
# = docker run --rm -v "$PWD/packages/cad:/src" -u "$(id -u):$(id -g)" \
#       donalffons/opencascade.js:2.0.0-beta.b5ff984 occt.build.yml
```

The image tag MUST match the pinned npm version so the generated bindings/typings
line up. Output (`plastiq-occt.js` + `.wasm` + `.d.ts`) is written under
`packages/cad/`.

## Switching the kernel to the trimmed build

1. Move the build output to `packages/cad/vendor/`.
2. Point `src/oc/init.ts`'s `initBrowser` at the vendored wasm/js instead of
   `opencascade.js/dist/opencascade.full.js` (pass the vendored URL through
   `locateFile`).
3. Re-run the full `vitest` + Playwright E2E suites against the trimmed build to
   confirm every feature's OCCT symbol survived the trim.
4. Re-measure the gzip size against the budget.

## Reproducibility

`occt.build.yml` sets `-sUSE_PTHREADS=0` (single-threaded) so boolean/mesh
algorithms are deterministic. The trimmed build is pinned to the same OCCT
version as the npm full build.
