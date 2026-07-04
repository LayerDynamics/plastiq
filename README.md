# Plastiq

**Plastiq** is an interactive, parametric, web based **CAD editor that runs
entirely in the browser**. Sketch a 2D profile, build an ordered
feature history (extrude / revolve / cut / loft / sweep / fillet / chamfer /
shell / draft / pattern / mirror / boolean), select faces/edges/vertices in 3D,
assemble component instances with mates and joints, persist projects to an
in-browser SQLite store with crash recovery, and **simulate the result under
gravity in a real physics engine** — all client-side. A separate **Sculpt**
workspace edits dense voxel bodies whose surface can be converted back to an
editable B-rep (see the reconstruction service below). It ships both in the
browser and as a native **desktop app** ([`apps/desktop`](apps/desktop), a Tauri
shell around the same editor).

It also has **AI generation** (SPEC-6): describe a part in natural language and a
model authors it through a tool-using agent (`build_part` / `inspect_geometry`),
can edit the open part, and runs from a side panel or a ⌘/Ctrl-K command palette.
Providers are bring-your-own — **local Ollama** (no key, offline) or **Anthropic
Claude** — so the editor itself stays serverless; only the model call leaves the
browser, to the endpoint you choose. A creative path turns text/image prompts into
mesh bodies via cloud 3D-gen, and those meshes can be reconstructed into editable
B-rep STEP solids by an **optional, self-hosted** reconstruction service
([`services/reconstruct`](services/reconstruct), Python + pythonOCC — see
[SPEC-7](docs/specs/SPEC-7-mesh-reconstruction.md)). Two further optional,
self-hosted **Apple-Silicon (MLX)** services feed the same "Convert to CAD" path
from real-world capture: [`services/nerf`](services/nerf) (posed photos → a
trained NeRF/VolSDF field → mesh, [SPEC-11](docs/specs/SPEC-11-nerf-service.md))
and [`services/capture`](services/capture) (a point cloud → a watertight mesh, or
a partial scan completed, [SPEC-10](docs/specs/SPEC-10-capture-and-completion.md)).
Each has an in-editor panel; all three run entirely on your own machine.

## Architecture

Plastiq is a pnpm workspace of two apps and four owned packages, plus three
optional self-hosted services:

```text
apps/plastiq           React + Zustand + Tailwind + three.js editor (the front end)
apps/desktop           @plastiq/desktop — a Tauri shell hosting the editor natively
packages/cad           @plastiq/cad — the parametric CAD kernel
packages/sim           @plastiq/sim — the pluggable physics layer
packages/nerf          @plastiq/nerf — browser client for the NeRF capture service
packages/capture       @plastiq/capture — browser client for the point-cloud service
services/reconstruct   optional Python + pythonOCC mesh→B-rep (STEP) service (SPEC-7)
services/nerf          optional MLX NeRF/VolSDF photo-capture service (SPEC-11)
services/capture       optional MLX point-cloud → mesh / scan-completion service (SPEC-10)
e2e/plastiq            no-mock Playwright end-to-end tests
```

(`services/nurbs` and the `packages/{data,embed,recon,rl,segment}` directories
are empty scaffolding reserved for future work — no code yet.)

- **`@plastiq/cad`** — a parametric B-rep kernel built directly on
  [`opencascade.js`](https://ocjs.org) (full OCCT compiled to WebAssembly). It
  owns geometry, ~18 feature operations, tagged tessellation with persistent
  face/edge references, STEP import + export with IGES and glTF export (the app
  additionally imports glTF/GLB meshes as non-parametric mesh bodies), a 2D sketch
  constraint solver
  backed by [`@salusoft89/planegcs`](https://www.npmjs.com/package/@salusoft89/planegcs)
  (FreeCAD PlaneGCS, wasm), a first-party 3D assembly-mate solver, and
  assembly→sim lowering. Runs in the browser (in a Web Worker) and headless under
  Node.
- **`@plastiq/sim`** — one `PhysicsEngine` interface with four interchangeable
  backends, selectable at runtime:
  [MuJoCo](https://mujoco.org/) (DeepMind, the default — vendored WASM, expresses
  world-axis hinges between arbitrarily-oriented bodies natively),
  [Rapier](https://rapier.rs/), [ammo.js](https://github.com/kripken/ammo.js)
  (Bullet), and [cannon-es](https://pmndrs.github.io/cannon-es/). It spawns the
  kernel's `SimManifest` and steps it under gravity. Each body is a **compound of
  convex-hull colliders**: a convex part is one hull (exact); a concave part is
  split into several convex pieces by [V-HACD](https://github.com/kmammou/v-hacd)
  so the collider tracks the real concave shape instead of bulging across the
  pocket — a multi-piece convex *approximation*, tunable by tolerance, not a
  single bounding hull. Beyond `revolute`/`fixed`, the manifest expresses
  `slider`/`cylindrical`/`ball`/`planar` joints; each backend implements every
  kind it can and **fails loudly** on the few it genuinely cannot (documented in
  the `PhysicsEngine` interface), never silently mis-simulating.
- **`@plastiq/nerf`** — the browser client for `services/nerf`: submits posed
  photos, polls the training job, and lands the resulting mesh as a document that
  feeds "Convert to CAD". Optional bearer-token auth.
- **`@plastiq/capture`** — the browser client for `services/capture`: parses a
  point cloud (ASCII PLY / XYZ / JSON), submits it to the neural-SDF `/capture` or
  scan-completion `/complete` endpoint, and lands the returned mesh the same way.

The editor uses React + Zustand + Tailwind + three.js, with `@plastiq/cad`
running in a Web Worker (the OCCT wasm stays in the worker chunk) and the sketch
solver on the main thread.

## Scripts

```sh
pnpm install                              # install the workspace
pnpm -C apps/plastiq run dev           # Vite dev server
pnpm -C apps/plastiq run build         # tsc --noEmit + production build
pnpm exec vitest run                      # unit/integration suite (real OCCT + wasm)
pnpm exec playwright test                 # no-mock browser E2E (served on :4177)
pnpm -r run typecheck                     # type-check every package + the app
```

A [`justfile`](justfile) wraps the common recipes (`just test`, `just e2e`,
`just build`, …).

## Running it

The editor is a static, fully client-side bundle — `pnpm -C apps/plastiq run
build` produces `apps/plastiq/dist`, which any static host can serve. A
self-host image ([`deploy/plastiq-web/`](deploy/plastiq-web/), nginx with
precompressed wasm and immutable-asset caching) is wrapped by `just
app-docker-build` / `just app-docker-run`; `apps/desktop` packages the same
editor as a native app via `pnpm -C apps/desktop tauri build`. The three optional
services run locally with `just services` (starts reconstruct/nerf/capture on
:8000/:8001/:8002 with health checks; `just services-stop` tears them down). Full
instructions, the single-threaded-wasm/no-COOP-COEP note, and bundle-size
expectations are in [`docs/deploy.md`](docs/deploy.md).

## Benchmarking (CADGenBench)

The AI generation path is evaluated against
[**CADGenBench**](https://huggingface.co/spaces/HuggingAI4Engineering/CADGenBench)
(*description → 3D STEP*) via a local harness in
[`benchmark/harness/`](benchmark/harness/). It runs Plastiq's generation agent
**headlessly** ([`apps/plastiq/src/headless/`](apps/plastiq/src/headless/),
`plastiq-gen`: text/image → `CadDocument` → `exportStep`) against a local
OpenAI-compatible model, validates the candidates with the benchmark's own
CAD-validity gate, and packages a leaderboard submission. The scorer runs in a
dedicated `cadgenbench` Python 3.12 env; ground-truth scoring is the leaderboard
Space's (the GT is private). Local/manual — not part of push-CI. See
[`benchmark/harness/README.md`](benchmark/harness/README.md) and the plan
[`docs/plans/2026-06-22-cadgenbench-integration.md`](docs/plans/2026-06-22-cadgenbench-integration.md).

## Bundle size / the OCCT trim

The shipped OCCT wasm is a **custom trimmed build** of `opencascade.js` containing
bindings for only the OCCT symbols the kernel uses — **~5.6 MB gzip, down from
~13.7 MB gzip** for the full prebuilt build. It lives at
[`packages/cad/vendor/occt/`](packages/cad/vendor/occt/) and is loaded by
`src/oc/init.ts` in both Node and the browser. The symbol list
([`packages/cad/occt.build.yml`](packages/cad/occt.build.yml)) is verified by
running the full test suite against the trimmed wasm — a missing symbol fails loudly
with an embind `UnboundTypeError`. To rebuild it (Docker, ≥12 GB memory):
`just cad-occt` — see
[`packages/cad/vendor/occt/PROVENANCE.md`](packages/cad/vendor/occt/PROVENANCE.md)
and [`packages/cad/scripts/build-occt.md`](packages/cad/scripts/build-occt.md).
The full `opencascade.js` package stays a dependency (API types + rebuild source).

## License

Plastiq's first-party code is licensed under the **PolyForm Noncommercial
License 1.0.0** (see [`LICENSE`](LICENSE)) — the source is available and free for
noncommercial use, with commercial rights reserved by LayerDynamics. Bundled and
vendored third-party components (OCCT/`opencascade.js` and planegcs under LGPL,
MuJoCo under Apache-2.0, V-HACD under BSD-3-Clause, and the MIT/Apache runtime
dependencies) remain under their own licenses; they are enumerated in
[`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md), and the LGPL wasm artifacts
carry their license text in their `vendor/` directories.
