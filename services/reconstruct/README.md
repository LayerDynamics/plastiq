# plastiq-reconstruct — mesh → B-rep + STEP service

Turns a generated/imported triangle **mesh document** into a real OpenCASCADE **B-rep**
shape and exports it as **STEP**, so the creative path's output can become editable CAD
geometry that round-trips through `@plastiq/cad`'s `importStep`.

This is a **server** (Python + [pythonOCC]) — a deliberate departure from Plastiq's
otherwise no-server design — because OCCT surface fitting and analytic-solid construction
are not feasible in the browser's trimmed OCCT-WASM build. It reverses two SPEC-6 decisions
on purpose (see `docs/specs/SPEC-6-ai-generation.md` §13 and the no-server identity); the
parametric path stays fully client-side and unchanged. The reconstruction work is specified
in its own milestone — see **[`docs/specs/SPEC-7-mesh-reconstruction.md`](../../docs/specs/SPEC-7-mesh-reconstruction.md)**
and the plan in `docs/plans/2026-06-20-spec7-r6-reconstruction.md`.

All detection and fitting are **deterministic** (SPEC-7 NFR-2): a normal-cluster /
Gauss-map axis with closed-form least-squares primitive fits — **no RANSAC** (randomised
fitters break reproducibility). The same mesh always reconstructs to the same B-rep.

## What it does today

The default method is **`auto`**: after mesh cleanup it tries, in order, the cleanest
reconstruction that volume-validates, and always falls back so nothing is dropped:

1. **single analytic primitive** — the whole mesh is one **cylinder / sphere / cone** →
   one watertight analytic solid (`detect.py` + `curved_faces.py`, box-safe shape gates).
2. **surface of revolution** — a turned part (stepped shaft, chamfered / capped cylinder)
   → a section profile revolved with `BRepPrimAPI_MakeRevol` into one analytic solid,
   volume-validated (`revolution.py`).
3. **CSG booleans** — an axis-aligned box with cylindrical features → `BRepAlgoAPI_Fuse`
   (bosses) then `BRepAlgoAPI_Cut` (through-holes), OCCT computing the shared edges
   (InverseCSG paradigm), volume-validated (`csg.py`).
4. **`fitted`** — group coplanar+adjacent triangles into **facets**, collapse each planar
   facet into a **single trimmed OCCT planar face** (faceted fallback for holed facets +
   leftover triangles). A clean, compact B-rep for flat regions (a box → 6 faces, not 12
   triangles). Selectable directly as `method="fitted"`.
5. **`faceted`** — the per-triangle baseline; always produces a valid B-rep from any
   triangle soup. Selectable as `method="faceted"` (fallback / comparison).

A freeform builder (`freeform.py` — `BRepOffsetAPI_MakeFilling`) handles smooth non-primitive
regions. A freeform cap whose boundary is the same straight mesh polyline its planar
neighbours use **does join a watertight solid** (`freeform_capped_solid` — coincident
boundaries sew at 1e-6 → `MakeSolid`, volume-validated). Still future: segmenting
freeform-vs-planar regions in an arbitrary organic mesh inside `auto`, and the analytic-rim
sagitta case (a smooth fitted arc vs a faceted polyline neighbour — see the honest caveat).
Cleanup (weld coincident vertices, drop degenerate/duplicate faces, fix winding/normals, fill
small holes — `cleanup.py`) runs first; STEP is written via `STEPControl_Writer`.

Coordinates are passed through unscaled (SI metres), matching `@plastiq/cad`'s STEP I/O
(`packages/cad/src/io/index.ts`), so the output imports back with consistent units.

## API (submit → poll, mirrors the fal mesh-gen queue the client already speaks)

| Method | Path | Body / result |
|---|---|---|
| `GET`  | `/health` | `{ status, service }` |
| `POST` | `/reconstruct` | `{ glb_base64, file_type? }` → `{ id, state }` |
| `GET`  | `/jobs/{id}/status` | `{ id, state, error? }` — `queued`/`running`/`completed`/`failed` |
| `GET`  | `/jobs/{id}/result` | `{ step, report }` when completed (409 while running, 500 if failed) |

`report` = `{ triangles_in, triangles_used, faces_built, planar_faces, is_solid, is_valid,
method, primitive? }` — `triangles_in` = raw, `triangles_used` = after cleanup,
`planar_faces` = facets collapsed into single trimmed faces (0 unless `method="fitted"`),
`method` = the path taken (`cylinder`/`sphere`/`cone`/`revolution`/`csg`/`fitted`/`faceted`),
`primitive` = the analytic kind when `auto` matched one (else absent).

## Run locally

```bash
mamba env create -f environment.yml          # one-time (pythonocc-core is conda-forge only)
mamba run -n plastiq-reconstruct uvicorn app.main:app --port 8000
```

## Test (real OCCT, no mocks)

```bash
mamba run -n plastiq-reconstruct python -m pytest -q
```

Covers (real OCCT, no mocks): cleanup; planar `fitted` and `faceted`; the deterministic
cylinder / sphere / cone fits → watertight analytic solids; `auto` classification (and that
a box is not misread as a primitive); surface-of-revolution stepped shafts; CSG box−hole /
box+boss solids; standalone freeform faces; and the full `POST /reconstruct` → poll →
`result` flow over the ASGI app (incl. a CORS preflight) with real GLB fixtures.

## Docker / deploy

```bash
docker build -t plastiq-reconstruct services/reconstruct
docker run -p 8000:8000 plastiq-reconstruct
```

The image builds the conda env from `environment.yml` on `condaforge/miniforge3`. **Verified
locally:** it builds, `/health` returns ok, and a real GLB reconstructs end-to-end through
the running container. The browser reaches it by base URL (set the app's
`reconstructBaseURL`) — same BYO/self-host spirit as the AI proxy seam, so no provider key
leaves the user's control.

The image is **≈4.7 GB** (conda + OCCT/pythonOCC + numpy/scipy/trimesh). That is fine for
local Docker but **exceeds the ~4 GB cap** of some hosted runners — a hosted deploy needs
slimming first (multi-stage copy of just the conda env, prune build tooling). A hosted
deploy is descoped for now (SPEC-7 decision D-6); local Docker is the supported mode.

## Honest caveat

The creative path generates **organic** meshes, which are the **hardest** case for
mesh→B-rep: smooth blobs have no clean primitives to fit, so even after the fitting
milestones they reconstruct mostly as dense freeform/faceted faces. Mechanical-looking
meshes (flats, holes, fillets) reconstruct far better. This is a fundamental limit of
automatic reconstruction, not an implementation gap.

## Roadmap (milestone R6 — full detail in SPEC-7)

- **R6.1 (done)** — service skeleton + faceted mesh→STEP.
- **R6.2 (done)** — mesh cleanup (weld/repair/winding/normals/fill-holes via trimesh).
- **R6.3 (done)** — planar facet segmentation (coplanar+adjacent triangles via trimesh/scipy).
- **R6.4 (done, planar)** — collapse each planar facet into a single trimmed analytic face
  (faceted fallback for holed facets + leftovers).
- **R6.4a (done)** — cylinder spike (GATE): deterministic cylinder fit (`primitives.py`) +
  analytic 3-face solid sharing the exact rim circles (`curved_faces.py`) + region detection
  (`detect.py`). Proves `is_solid` survives the analytic collapse; faceted caps regress to a
  shell (the shared-edge crux). See SPEC-7 §D-3.
- **R6.4b (done)** — sphere + cone fits/solids + **auto single-primitive classification**
  (`detect.try_single_primitive`, default `method="auto"`, box-safe shape gates), and
  **surface-of-revolution** mixed parts (`revolution.py` — stepped shafts / chamfered /
  capped cylinders → one analytic revolved solid, volume-validated).
- **R6.4b-iii/iv (done, bounded)** — mixed parts via **CSG booleans** (`csg.py` — InverseCSG
  paradigm): axis-aligned box, fuse cylindrical bosses, cut cylindrical through-holes
  (`BRepAlgoAPI_Fuse`/`Cut`, OCCT computes shared edges), volume-validated. The base box may
  be axis-aligned **or arbitrarily rotated** (an oriented frame is derived from the part's own
  planar normals), and multiple features are supported. Non-cylindrical features and arbitrary
  nested CSG trees remain future (SPEC-7).
- **R6.5 (done — builder + bounded topology integration)** — freeform faces via
  `BRepOffsetAPI_MakeFilling` (`freeform.py`), and `freeform_capped_solid`: a freeform cap
  whose boundary is the shared straight mesh polyline joins a watertight solid (sews at 1e-6,
  volume-validated). Still future: arbitrary-mesh freeform/planar segmentation in `auto`, and
  the analytic-rim sagitta case — closed organic blobs keep the valid faceted solid.
- **R6.6 (done)** — client `reconstructMesh` (submit/poll) + a "Convert to CAD (STEP)"
  action in the GenerationPanel → `stepToImportDocument` → the kernel `importStep` feature
  → an editable `CadDocument` (`apps/plastiq/src/ai/reconstruct.ts`).
- **R6.7 (done)** — server tests (real-OCCT pytest) + client↔server integration test (keyed
  on `RECONSTRUCT_URL`) + a no-mock browser E2E (`e2e/plastiq/reconstruct.spec.ts`, gated on
  the service being reachable; CORS added to `main.py` so the browser can call cross-origin).
- **R6.8 (deferred, local-only)** — the Dockerfile + `environment.yml` build/run locally
  (below); a hosted deploy is descoped for now (SPEC-7 decision D-6).

[pythonOCC]: https://github.com/tpaviot/pythonocc-core
