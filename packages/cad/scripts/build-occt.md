# Building the trimmed `opencascade.js` (SPEC-4 Task 0.2 / R1 / NFR-4)

The kernel runs on `opencascade.js` (full OCCT → WebAssembly via Emscripten).
Two builds are in play:

| Build                | Source                                                     | Size                         | Used for                                                             |
| -------------------- | ---------------------------------------------------------- | ---------------------------- | -------------------------------------------------------------------- |
| **Full (prebuilt)**  | `opencascade.js` npm package (pinned `2.0.0-beta.b5ff984`) | 48 MB raw / **13.2 MB gzip** | **Development + tests (now).** The proven, complete OCCT.            |
| **Trimmed (custom)** | `occt.build.yml` → Docker build → `vendor/mechx-occt.*`    | target **≤ 3 MB gzip** (Q10) | **Production browser bundle (later).** Only symbols the kernel uses. |

## Why the trim is deferred (not stubbed)

A custom build includes only the OCCT **symbols you list** in `occt.build.yml`.
That list is only correct once the kernel's full symbol surface is known — which
is ≈ M5, after every feature op is implemented. Building a trim earlier would
either omit symbols (breaking features) or include guesses. So:

- **M0–M4:** develop and test against the **full** prebuilt build (the engine
  initializer `src/oc/init.ts` loads `opencascade.js`). Correctness first.
- **M5 (or when the symbol set stabilizes):** finalize `occt.build.yml` bindings,
  run the Docker build, drop the result in `vendor/`, point `init.ts` at it, and
  re-measure against the Q10 budget.

This is the same workflow shipping ocjs apps (replicad, CascadeStudio) use.

## Running the trimmed build

Requires Docker (verified available in this environment). The build compiles the
selected OCCT toolkits via Emscripten — expect **30–90 min** and several GB.

```sh
just cad-occt
# = docker run --rm -v "$PWD/packages/cad:/src" -u "$(id -u):$(id -g)" \
#       donalffons/opencascade.js:2.0.0-beta.b5ff984 occt.build.yml
```

The image tag MUST match the pinned npm version so the generated bindings/typings
line up. Output (`mechx-occt.js` + `.wasm` + `.d.ts`) is written under
`packages/cad/`; move it to `packages/cad/vendor/` and update `init.ts`'s
`mainJS`/`mainWasm`.

## Reproducibility (NFR-2 / C6)

`occt.build.yml` sets `-sUSE_PTHREADS=0` (single-threaded) so boolean/mesh
algorithms are deterministic. The trimmed build is pinned to the same OCCT
version as the npm full build; bit-identity is defined per (build, JS engine),
not across versions (ADR-0011-style caveat).
