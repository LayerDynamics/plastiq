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
fitters break reproducibility). The report's `surface_deviation` sampling does use
`mx.random`, but seeded from a SHA-256 of the mesh geometry (`fidelity.py`), so the same
mesh always reconstructs to the same B-rep and the same report.

## What it does today

The default method is **`auto`**: after mesh cleanup it tries, in order, the cleanest
reconstruction that volume-validates, and always falls back so nothing is dropped:

1. **single analytic primitive** — the whole mesh is one **cylinder / sphere / cone** →
   one watertight analytic solid (`detect.py` + `curved_faces.py`, box-safe shape gates).
2. **cut sphere** — a sphere trimmed by a plane (hemisphere / spherical cap): `GeomAPI_IntSS`
   confirms sphere∩plane, half-space cuts, volume-validated (`topology.py`, R6.9 / T37).
3. **surface of revolution** — a turned part (stepped shaft, chamfered / capped cylinder)
   → a section profile revolved with `BRepPrimAPI_MakeRevol` into one analytic solid,
   volume-validated (`revolution.py`).
4. **CSG booleans** — a box (axis-aligned or rotated) with cylindrical features →
   `BRepAlgoAPI_Fuse` (bosses) then `BRepAlgoAPI_Cut` (through-holes), OCCT computing the
   shared edges (InverseCSG paradigm), volume-validated (`csg.py`).
5. **cut cylinder** — a cylinder trimmed by non-perpendicular / axis-parallel planes (an
   obliquely-capped cylinder): `GeomAPI_IntSS` confirms each fitted plane crosses the
   cylinder, then boolean half-space cuts build the exact shared edges, volume-validated
   (`topology.py`, SPEC-7 R6.9).
6. **`fitted`** — group coplanar+adjacent triangles into **facets**, collapse each planar
   facet into a **single trimmed OCCT planar face**, AND collapse each single-loop non-planar
   region into one **freeform face** (R6.5; accuracy- and volume-guarded), with a per-triangle
   faceted fallback for holed facets, closed regions, and leftovers. When
   `RECONSTRUCT_NURBS_URL` is set, a whole closed genus-0 organic blob is delegated to the
   nurbs service **closed** mode (6-patch cube-map solid, T38) before faceting. Selectable
   directly as `method="fitted"`.
7. **`faceted`** — the per-triangle baseline; always produces a valid B-rep from any
   triangle soup. Selectable as `method="faceted"` (fallback / comparison). If the fitted
   route itself raises, the pipeline emits this baseline instead of failing the job (NFR-1);
   any raising analytic route likewise degrades to the next route, recorded in the report's
   `attempted` trail.

Every route verifies closure with the same shared chain (`closure.py`: real free-edge count
via `ShapeAnalysis_FreeBounds` → optional `OrientClosedSolid` → `BRepCheck_Analyzer` →
positive volume) — `is_solid` is never assumed and `free_edges` is never hardcoded.

Freeform faces (`freeform.py` — `BRepOffsetAPI_MakeFilling`) handle smooth non-primitive
regions, and the **`fitted` path now uses them**: each connected non-planar region with a
single boundary loop is collapsed into ONE freeform face (sharing the mesh-polyline boundary
of its planar/faceted neighbours), guarded by a per-region accuracy gate and a post-assembly
volume check (rebuilds faceted-only if freeform breaks closure/volume). A domed box becomes a
freeform-capped solid instead of hundreds of triangles. Honest limits: a CLOSED region (no
boundary loop — e.g. a whole organic blob) can't be one `MakeFilling` patch; with
`RECONSTRUCT_NURBS_URL` set it delegates to nurbs closed mode (T38), otherwise stays faceted.
The general per-region analytic-rim sagitta case (smooth fitted arc vs faceted polyline
neighbour) still needs further FR-6 graph work beyond cylinder/sphere∩plane. Cleanup (weld
coincident vertices, drop degenerate/duplicate faces, fix winding/normals, fill small holes —
`cleanup.py`) runs first; STEP is written via `STEPControl_Writer`.

Coordinates are passed through unscaled (SI metres), matching `@plastiq/cad`'s STEP I/O
(`packages/cad/src/io/index.ts`), so the output imports back with consistent units.

## API (submit → poll, mirrors the fal mesh-gen queue the client already speaks)

| Method | Path | Body / result |
|---|---|---|
| `GET`  | `/health` | `{ status, service }` |
| `POST` | `/reconstruct` | `{ glb_base64, file_type?, method? }` → `{ id, state }` — `method` ∈ `auto` (default) / `fitted` / `faceted` (SPEC-7 FR-11; unknown values → 422). 400 on bad/empty base64; **429** when `RECONSTRUCT_MAX_CONCURRENT_JOBS` jobs are already in flight |
| `GET`  | `/jobs/{id}/status` | `{ id, state, error? }` — `queued`/`running`/`completed`/`failed` |
| `GET`  | `/jobs/{id}/result` | `{ step, report }` when completed (409 while running, 500 if failed) |
| `DELETE` | `/jobs/{id}` | 204 — drop/cancel a job record (404 if unknown; an in-flight worker thread can't be force-killed, its result is discarded) |

`report` = `{ triangles_in, triangles_used, faces_built, planar_faces, curved_faces, freeform_faces,
faceted_faces, surface_deviation, fidelity_tol, tangent_regions, is_solid, is_valid, method,
primitive, attempted }` —
`triangles_in` = raw, `triangles_used` = after cleanup, `planar_faces` = flat analytic faces — for
`fitted` the facets collapsed into single trimmed faces, for the analytic routes the built shape's
`Geom_Plane` faces (a cylinder's 2 caps, a CSG box's sides), 0 for `faceted`, `method` = the route
taken — never `"auto"`
(`cylinder`/`sphere`/`cone`/`revolution`/`csg`/`cut_cylinder`/`cut_sphere`/`fitted`/`faceted`), `primitive` = the
analytic kind when an analytic route matched (else `null`), `attempted` = the auto chain's per-route
trail in run order (`{ route, outcome: "matched"|"no_match"|"error", error? }` — an errored analytic
route degrades to the next route; a `fitted` attempt can record `"error"` while `method` is still
`"fitted"`, meaning a freeform region crashed and fell back faceted inside the emitted result),
`surface_deviation` = the **Scaled Chamfer
Distance** of the built B-rep vs the cleaned input mesh (a pose/scale-robust surface-fidelity score,
lower = closer; advisory — complements the volume gate), `fidelity_tol` = its advisory threshold,
`tangent_regions` = tangent-connected regions recognised in the input mesh (box→6, cylinder→3; M2c, a
structural fingerprint — see [`docs/adr/0002`](../../docs/adr/0002-brepnet-cleanroom-traversal.md)).

> `app/fidelity.py` (the SCD metric) is ported (**Apache-2.0**) from
> [StepForge](https://github.com/) `reward/{step_to_pointcloud,scd_reward}.py`; the pose-alignment
> stage (FPFH/RANSAC/ICP, the only open3d user) is omitted because the reconstructed B-rep is built
> from the input mesh — same frame. The metric math (sampling + bidirectional Chamfer) and the M2c
> recognition (dihedral angles + normal spread) run in **MLX** (`mlx.core`; pip dep), with
> OCCT/trimesh for geometry and a Python union-find for connected components. MLX is a **hard
> runtime dependency** — `main.py → pipeline.py → fidelity.py/recognition.py` import `mlx.core`
> at startup. Bare `mlx` ships a backend only on macOS (mlx-metal); on Linux the Dockerfile and
> CI install `mlx[cpu]` explicitly.
> See [`docs/adr/0001`](../../docs/adr/0001-scd-fidelity-metric.md) / [`0002`](../../docs/adr/0002-brepnet-cleanroom-traversal.md).

## Run locally

`pnpm dev` starts the editor with all five supervised services. For a service-only session,
the repo-root command below starts reconstruct :8000, capture :8001, nerf :8002, nurbs :8003,
and photogrammetry :8004, creating missing conda environments and requiring every health gate:

```bash
just services          # `just services-stop` stops only supervisor-owned processes
```

Or run just this service manually:

```bash
mamba env create -f environment.yml          # one-time (pythonocc-core is conda-forge only)
mamba run -n plastiq-reconstruct uvicorn app.main:app --port 8000
```

Job lifecycle (submit/start/complete/fail + duration) and rejected submits are logged via
Python `logging` (INFO default — `RECONSTRUCT_LOG_LEVEL` overrides). The in-memory job store
is bounded in every direction (`app/jobs.py` + `app/main.py`):

- terminal (completed/failed) jobs are evicted by TTL + a max-count cap;
- concurrent submits are capped — beyond `RECONSTRUCT_MAX_CONCURRENT_JOBS` (default 2) a
  submit is rejected with 429 so CPU-bound OCCT load sheds early;
- a job stuck queued/running past `RECONSTRUCT_RUNNING_JOB_TTL_SECONDS` (default 1800) is
  force-failed so it stops holding the concurrency cap;
- `DELETE /jobs/{id}` drops a record on client cancel/cleanup.

CORS is permissive by default (the service holds no secrets); lock it down with
`RECONSTRUCT_CORS_ORIGINS` (comma-separated origins).

## Test (real OCCT, no mocks)

```bash
mamba run -n plastiq-reconstruct python -m pytest -q
```

Covers (real OCCT, no mocks — **122 tests**, all passing as of 2026-07-04): cleanup; planar
`fitted` and `faceted`; the deterministic
cylinder / sphere / cone fits → watertight analytic solids; `auto` classification (and that
a box is not misread as a primitive); surface-of-revolution stepped shafts; CSG box−hole /
box+boss / rotated-base / two-hole solids; the `GeomAPI_IntSS` shared-edge primitive + the
oblique cut-cylinder route (`test_topology.py`); freeform faces + `freeform_capped_solid` + the
**fitted/auto freeform integration** (a domed box → a freeform-capped solid, `freeform_faces>0`);
the shared closure-verification chain (`test_closure.py`); the SCD fidelity metric + tangent-region
recognition (`test_fidelity.py`/`test_recognition.py`); the route-attempt trail and fitted→faceted
exception fallback (`test_pipeline.py`); the bounded submit→poll job store (TTL + cap eviction +
running-job TTL — `test_jobs.py`); and the full
`POST /reconstruct` → poll → `result` flow over the ASGI app (incl. a CORS preflight, the
`method` param round-trip, `DELETE /jobs/{id}`, and the 429 concurrency cap) with
real GLB fixtures. The suite also runs in CI on ubuntu (see `.github/workflows/ci.yml`, which
installs the `mlx[cpu]` Linux backend) with one platform-numerics deselect documented there.

## Docker / deploy

```bash
docker build -t plastiq-reconstruct services/reconstruct
docker run -p 8000:8000 plastiq-reconstruct
```

The image builds the conda env from `environment.yml` on `condaforge/miniforge3`, then
installs **`mlx[cpu]`** explicitly — bare `mlx` ships no Linux backend, and the service
imports `mlx.core` at startup, so without this step uvicorn cannot start in the container
(the same fix CI uses; the image was silently broken on this between 2026-06-22 and
2026-07-04). **Verified locally (2026-07-04):** it builds, `/health` returns ok, and a real
cylinder GLB reconstructs end-to-end through the running container (`method` `cylinder`,
`is_solid` true, SCD ≈0.0039 on the Linux CPU MLX backend). The browser reaches it by base
URL (set the app's `reconstructBaseURL`) — same BYO/self-host spirit as the AI proxy seam,
so no provider key leaves the user's control.

The image is **≈4.8 GB** (conda + OCCT/pythonOCC + numpy/scipy/trimesh + MLX). That is fine
for local Docker but **exceeds the ~4 GB cap** of some hosted runners — a hosted deploy needs
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
- **R6.5 (done — builders + pipeline integration)** — freeform faces via
  `BRepOffsetAPI_MakeFilling` (`freeform.py`; interior-count ladder for accuracy), and
  `freeform_capped_solid` proving freeform joins a watertight solid. **Wired into `fitted`/
  `auto`:** each single-loop non-planar region collapses to one freeform face, accuracy- and
  volume-guarded (faceted rebuild on failure). Honest limits: closed regions (no boundary
  loop) stay faceted; the analytic-rim sagitta case still needs the surface-intersection tail.
- **R6.6 (done)** — client `reconstructMesh` (submit/poll) + a "Convert to CAD (STEP)"
  action in the GenerationPanel → `stepToImportDocument` → the kernel `importStep` feature
  → an editable `CadDocument` (`apps/plastiq/src/ai/reconstruct.ts`).
- **R6.7 (done)** — server tests (real-OCCT pytest) + client↔server integration test (keyed
  on `RECONSTRUCT_URL`) + a no-mock browser E2E (`e2e/plastiq/reconstruct.spec.ts`, gated on
  the service being reachable; CORS added to `main.py` so the browser can call cross-origin).
- **R6.8 (done, local-only)** — the Dockerfile + `environment.yml` build/run locally,
  verified end-to-end in-container on 2026-07-04 (above); a hosted deploy is descoped for
  now (SPEC-7 decision D-6).
- **R6.9 (partial)** — the FR-6 surface-intersection tail: the `GeomAPI_IntSS` shared-edge
  primitive + the oblique **cut-cylinder** `auto` route shipped (`topology.py`); the fully
  general per-region analytic reconstruction, the analytic-rim sagitta case, and the
  snapped-boundary-polyline / edge–edge corner mechanisms remain open (those regions stay
  faceted — nothing is dropped). See SPEC-7 §8.

[pythonOCC]: https://github.com/tpaviot/pythonocc-core

## Freeform → NURBS delegation (U10)

When `RECONSTRUCT_NURBS_URL` is set (e.g. `http://127.0.0.1:8003`), freeform single-loop
regions are offloaded to `services/nurbs` for a B-spline fit. `just services` /
`scripts/dev-services.sh` exports this automatically for the reconstruct process so
organic freeform quality uses NURBS by default when both services are running.

Unset the env var to force local `MakeFilling` only.
