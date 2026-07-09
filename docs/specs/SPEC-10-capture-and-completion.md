# SPEC-10 — Capture & completion (MLX on Apple Silicon)

**Status:** In progress (M7+M8 shipped; browser client added 2026-07-03; reconciled to code 2026-07-04) · **Date:** 2026-06-22
**Plan:** `docs/plans/2026-06-21-expanse-ref-integrations.md` §M7/§M8 · **Framework:** MLX (Apple Silicon / M4 Max)

Two optional self-hosted Python services that turn raw 3D input into a mesh Plastiq can reconstruct to
B-rep. Both are written in **MLX** — the upstream repos (nerfstudio/sdfstudio for M7, DLR-RM
shape-completion for M8) are **CUDA-only** and do not run on Apple Silicon, so these are self-contained
MLX implementations trainable on the user's M4 Max (memory `mlx-m4max-ml-milestones`), not ports.

**Reconciliation (2026-07-04):** re-verified against the current code and updated for three additions
that shipped after M7/M8 first landed — the capture service now exposes a synchronous
`POST /points-from-depth` depth-scan front-end (making `app/geometry.py`/M6 live; ADR 0006), a real
completion trainer (`python -m app.train_completion`; §completion), and job-store hardening
(`DELETE /jobs/{id}` plus a `CAPTURE_MAX_CONCURRENT_JOBS` 429 cap). All 43 capture-service tests pass
(`services/capture`, `pytest`).

**Scope reversal (2026-07-04):** the **photos → posed point cloud (SfM/MVS) front-end**, twice
declared below as "COLMAP's job, not built here", is now planned **first-party** as
`services/photogrammetry` — [SPEC-13](SPEC-13-photogrammetry-service.md) (user decision 2026-07-04;
the same dated-reversal treatment the §browser-client decision got). The "COLMAP's job" statements
below stand as this spec's own honest scope — the capture service still does not build SfM — and
remain factually true of the code until SPEC-13's milestones land (nothing is built there yet as of
this note).

## §capture — MLX neural-SDF surface reconstruction (M7 · shipped)

**ADR:** [`docs/adr/0007-photogrammetry-capture.md`](../adr/0007-photogrammetry-capture.md) · **Service:** `services/capture/`

Turns an **oriented point cloud** (points + per-pixel normals, produced from a depth scan by the
service's `POST /points-from-depth` endpoint — `app/geometry.py` (M6) — or by an external SfM/MVS
like COLMAP) into a **watertight mesh**.

- **`app/sdf_mlx.py`** — an IGR-style Softplus SDF MLP (geometric init → correct inside/outside sign at
  init), fit to the points with surface (`f≈0`), normal-alignment (`∇f ≈ n`), and eikonal (`|∇f|≈1`,
  via `mx.grad`) losses; **`extract_mesh`** marching-cubes the zero level-set. **Real MLX training on
  the M4 Max** — `tests/test_sdf_mlx.py` fits a sphere point cloud and asserts a real surface was
  extracted (`faces > 100`) at roughly the trained radius (mean vertex radius in `0.7 … 1.3`), plus
  correct inside/outside sign. Deterministic by seed.
- **`app/pipeline.py`** — `reconstruct_surface(points, normals) → mesh` (+ GLB export).
- **`app/main.py`** — FastAPI **submit→poll** (`POST /capture {points, normals}` → poll →
  `{glb_base64, vertices, faces}`), mirroring `services/reconstruct`. Alongside it: a synchronous
  `POST /points-from-depth {depth, fx, fy, cx, cy} → {points, normals}` depth-scan front-end (M6 —
  see §capture intro), `DELETE /jobs/{id}` (204 / 404, client cancel-and-cleanup), and a
  `CAPTURE_MAX_CONCURRENT_JOBS` cap (default 2) that 429s submits beyond the in-flight limit so an
  unauthenticated caller can't start unbounded MLX fits. The submit→poll job contract is tested live
  (`tests/test_jobs.py`); the full HTTP path — including the depth front-end (end-to-end into
  `/capture`), DELETE, and the 429 cap — is covered by `tests/test_api.py`, which gates on
  `fastapi`+`mlx`.
- **Import path:** the produced GLB is a standard mesh → imported via Plastiq's existing `MeshDoc`
  path → the existing **"Convert to CAD"** reconstruct (mesh→B-rep). The upstream half is still
  **external capture** (phone/LiDAR/COLMAP → point cloud), but the point cloud → GLB → `MeshDoc` leg
  now runs **in the browser** via `@plastiq/capture` (see §browser client below — this reverses the
  spec's original "no new browser code" positioning).
- **Env:** `services/capture/environment.yml` (conda-forge + `pip: mlx`).

**Honest scope:** this is the *surface-reconstruction* half (points → mesh). The **photos → posed point
cloud** step (SfM/MVS) is COLMAP's / a depth sensor's job, not built here (ADR 0007) — and a full
multi-view *radiance* field is unnecessary for a points/depth → surface path. (Per the 2026-07-04
scope-reversal note above, that upstream step is now specced first-party — SPEC-13 — but stays
outside the capture service.)

## §completion — shape completion ("Complete Scan / Fill Gaps") (M8 · shipped)

**ADR:** [`docs/adr/0008-shape-completion-service.md`](../adr/0008-shape-completion-service.md) · **Service:** `services/capture/` (`/complete`)

Completes a **partial** point cloud (a scan with holes) into a full watertight mesh.

- **`app/completion_mlx.py`** — a conditional occupancy network (PointNet encoder + occupancy decoder),
  trained with logits-BCE on (partial, query, full-occupancy) triples; `complete` marching-cubes the
  predicted occupancy. **Real MLX training on the M4 Max** — `tests/test_completion_mlx.py` feeds a
  top-hemisphere-only partial scan and asserts the completion covers the missing bottom hemisphere it
  never saw (extracted vertices reach `z < −0.4`), forming a real surface (`faces > 100`) at roughly
  the inferred ball radius (mean vertex radius in `0.5 … 1.1`). Deterministic by seed; checkpoints via
  `CompletionNet.load_weights`.
- **`/complete` endpoint** (submit→poll) on the capture service; a lazily-trained-or-loaded cached
  model (`CAPTURE_COMPLETION_CHECKPOINT` for a real-dataset checkpoint, else the synthetic demo).
- **Lives in the capture service, not reconstruct** — it is ML/non-deterministic and must stay out of
  the deterministic mesh→B-rep path (NFR-2). Output GLB → existing `MeshDoc` → reconstruct.

**Honest scope:** the demo completes only the family it trained on (spheres) unless you point it at a
real dataset. For general objects the service now ships a real trainer — run
`python -m app.train_completion <mesh-dir> --checkpoint <path>` (`app/train_completion.py`): it builds
(partial-scan, query, occupancy) triples from a directory of watertight meshes (area-weighted trimesh
surface sampling + random-view-direction culling for the partial view; `mesh.contains` for true
occupancy), trains `CompletionNet` with `fit_completion`'s exact loss machinery (`save_weights`,
`--resume`), and writes a `CAPTURE_COMPLETION_CHECKPOINT`-loadable checkpoint — the serving branch
that loads it is test-covered (`tests/test_train_completion.py`). You still supply the mesh dataset
(the upstream repo ships no weights either), and completion quality stays class-dependent.

## §browser client — `@plastiq/capture` + the Scan-to-mesh panel (added 2026-07-03)

**Decision reversal (2026-07-03):** this spec originally positioned the capture service as
*"no new browser code"* — the user would run the service and import the GLB by hand. On 2026-07-03
the user made the product decision to reverse that: the capture/completion service gets a **real
browser client and panel**, mirroring the proven `@plastiq/nerf` pattern (SPEC-11 N11), so a scan
file goes point cloud → mesh → CAD without leaving Plastiq.

- **`packages/capture` (`@plastiq/capture`)** — the browser client, sharing the submit→poll wire
  contract of the nerf/reconstruct clients:
  - `capturePointCloud({points, normals, iters?, gridRes?})` → `POST /capture` → poll
    `GET /jobs/{id}/status` → `GET /jobs/{id}/result` → `{glb, report: {vertices, faces}}`.
  - `completePartialScan({points, gridRes?})` → `POST /complete` (same poll/result shape).
  - Abortable (`signal`), poll-capped (`pollIntervalMs` default 1000 ms, `maxPolls` default 600 ≈
    10 min), injectable `fetchImpl`/`delay` for tests. Errors surface the server's `detail` (its
    400 validation messages, the 409 not-complete, the 500 failed-job relay) plus `failed`-job and
    poll-timeout throws. **No API-key option** — the service exposes no auth (`app/main.py`), so
    unlike `@plastiq/nerf` there is deliberately no key plumbing.
  - **Point-cloud parsers** (`src/pointcloud.ts`): ASCII PLY (`x/y/z` + optional `nx/ny/nz` read
    by header property position; colors/faces skipped; binary PLY rejected with an actionable
    message), plain XYZ (3-column points or 6-column points+normals; `#`/`//` comments), and JSON
    (the wire shape `{points, normals?}` or a bare `[[x,y,z], …]`). Strictly validated: finite
    Nx3 only, errors carry line numbers. The server's 16-point floor is exported as `MIN_POINTS = 16`
    from `src/types.ts` (re-exported at the package root, `src/index.ts`) for callers to pre-check.
- **App wiring (`apps/plastiq`)** — mirrors the NeRF capture path exactly:
  - `captureBaseURL` setting (`src/ai/settings.ts`, default `http://localhost:8001`) + a
    "Capture service URL" field in the Settings panel (`settings-capture-url`).
  - `src/ai/capture.ts` adapter: `meshFromPointCloud` / `meshFromPartialScan` map the returned GLB
    into a `MeshDoc` (`source: {mode: "photos3d", providerId: "capture" | "capture:complete"}`)
    and persist via `createMeshProject`; the panel then opens the new project.
  - **`CaptureScanSection`** in the Generation panel (testid `capture-scan`): a `.ply`/`.xyz`/
    `.json` scan file input parsed client-side, a Capture (oriented) / Complete (partial) mode
    toggle (auto-selects Complete for normals-less files), client-side validation (the 16-point
    server floor, a 200 000-point browser cap, `/capture` requires normals), a `GET /health`
    pre-check with the "start it with …" hint (`serviceUnreachableMessage("capture", …)`), and an
    abortable submit→poll with in-panel status/error. Success lands the mesh in
    `MeshConvertSection` — the existing **"Convert to CAD"** (mesh → B-rep) path.
