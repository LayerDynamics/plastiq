# Building the vendored `opencascade.js` kernel for `@plastiq/cad`

The CAD kernel runs the repository's custom, trimmed OCCT WebAssembly build in
both the browser and Node/CI. `src/oc/init.ts` loads
`vendor/occt/plastiq-occt.{js,wasm}`; the full `opencascade.js` npm package stays
pinned at `2.0.0-beta.b5ff984` as the source distribution and TypeScript API
superset used to compile this build.

The 2026-08-03 artifact is **19,447,072 bytes raw** and **5,949,734 bytes gzip**.
For comparison, the upstream full prebuilt wasm is about 48 MB raw / 13.7 MB
gzip. The trim is therefore the shipped kernel, not a future switch or a stub.

## Running the trimmed build

Requires Docker. The build compiles the selected OCCT toolkits via Emscripten —
expect **30–90 min** and several GB.

```sh
just cad-occt
# stages occt.build.yml in packages/cad/build/occt, then runs:
# docker run --rm -v "$PWD/packages/cad/build/occt:/src" -u "$(id -u):$(id -g)" \
#       donalffons/opencascade.js:2.0.0-beta.b5ff984 occt.build.yml
```

The image tag must match the pinned npm version so generated bindings and the
OCCT ABI agree. The `just` recipe copies `occt.build.yml` into the gitignored
`packages/cad/build/occt/` staging directory, runs the builder there, and then
copies `plastiq-occt.{js,wasm,d.ts}` into `packages/cad/vendor/occt/`. The copy
updates the live kernel immediately; review the artifact diff and run the gates
below before committing it.

## Validation after a rebuild

Run the binding pin first, then the complete CAD tests and browser acceptance:

```sh
./node_modules/.bin/vitest run packages/cad/src/oc/bindings.test.ts
./node_modules/.bin/vitest run packages/cad/src
./node_modules/.bin/playwright test --project=plastiq
wc -c packages/cad/vendor/occt/plastiq-occt.wasm
gzip -c packages/cad/vendor/occt/plastiq-occt.wasm | wc -c
```

A new OCCT leaf may also require its complete embind base-class chain and any
returned `Handle_*` wrapper. A build that links successfully can still be
uncallable at runtime, so every added family needs a constructibility or behavior
assertion in `src/oc/bindings.test.ts` (or a focused real-kernel test).

## Reproducibility

`occt.build.yml` sets `-sUSE_PTHREADS=0` (single-threaded) and the Docker image is
pinned to the same `opencascade.js` revision as the npm dependency. The committed
YAML plus the pinned image and `just cad-occt` recipe are the reproducible source
of the three vendored artifacts.
