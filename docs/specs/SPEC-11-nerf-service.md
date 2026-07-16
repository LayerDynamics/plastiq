# SPEC-11 — NeRF / radiance-field service (`services/nerf/`, MLX)

**Status:** Complete (N0–N12) · **Date:** 2026-06-22 · **Reconciled:** 2026-07-04
**ADR:** [`docs/adr/0011`](../adr/0011-nerf-service-architecture.md) · **Plan:** `docs/plans/2026-06-22-nerf-service.md`
**Framework:** MLX (Apple Silicon / M4 Max) · **Source idea:** nerfstudio (Apache-2.0, architecture only)

> **2026-07-04 reconciliation.** The server, the `@plastiq/nerf` client, and the §5 wire table were
> extended **in lockstep** today (the freeze clause permits additive change when all three move
> together): two additive `/train` fields (`encoding`, `importance_samples`) + their `/result` echo,
> the 429 concurrency cap and the true `JobView` `/train` response are recorded in §5; the previously
> dangling `DELETE /jobs/{id}` now has a real client + panel consumer; auth is constant-time and
> pytest-covered; the reported PSNR is now genuinely held-out; the panel exposes the training knobs and
> pairs images to frames by filename; and a real browser E2E (`e2e/plastiq/nerf.spec.ts`) exists. This
> retires the SPEC-11 items in `docs/specs/UnfinishedFable.md` §5 (11-M1…M4, 11-L). Details inline below.

## 1. Goal

A self-hosted, **modular MLX** radiance-field service: posed images (`transforms.json` + frames) → a
trained NeRF or SDF field → an exported mesh that feeds Plastiq's existing `MeshDoc` → reconstruct
(mesh→B-rep) path. Mirrors nerfstudio's module decomposition so encodings, samplers, renderers, fields,
and models are independently testable.

## 2. Components (`services/nerf/app/`)

| Module | Responsibility |
|---|---|
| `field_components/` | `FrequencyEncoding`, `HashGridEncoding`, `MLP`, density/RGB `field_heads`, activations (`mlx.nn`) |
| `generators/` | ray samplers: `UniformSampler`, `PDFSampler` (importance) |
| `model_components/` | volumetric `renderers` (RGB / accumulation / depth), `losses` (MSE photometric, eikonal) |
| `fields/` | `NeRFField` (density+color), `SDFField` (VolSDF surface) — composed from `field_components` |
| `models/` | `VanillaNeRF` (+ hash-grid), `VolSDFModel` surface model — field + sampler + renderer + loss |
| `data_processing/` | `transforms.json` parser → `DataparserOutputs`; MLX ray generation (reimplements the capture pinhole *convention* — same `+z` forward geometry, but no import of `services/capture`) |
| `engine/` | `Trainer` (MLX Adam + `value_and_grad` loop); submit→poll `jobs` |
| `exporters/` | density/SDF grid → `marching_cubes` mesh → GLB / point cloud |
| `utils/` | config, deterministic MLX seeding, math |

## 3. Functional requirements

- **FR-1** Field/encoder/sampler/renderer/model code is **MLX** (`mlx.core`/`mlx.nn`); numpy only at I/O
  boundaries (parse, image load, marching-cubes, GLB). Deterministic via explicit MLX keys.
- **FR-2** Two models: **VanillaNeRF** (density+color, volume render) and the SDF surface model — shipped
  as **VolSDF** (`VolSDFModel`, Laplace-CDF density transform; `app/models/neus.py`), not a logistic
  s-density NeuS. The
  wire/config enum value stays `"neus"` for compatibility (the family name), but the code is VolSDF-style.
- **FR-3** `transforms.json` ingestion (nerfstudio/Blender convention); **SfM is out of scope** (COLMAP).
  > **2026-07-04 (additive — SPEC-13 FR-9 lockstep).** `parse_transforms`
  > (`app/data_processing/dataparser.py`) now converts each `transform_matrix` from the **standard
  > OpenGL/Blender camera axes** (−z forward, +y up) that real nerfstudio/COLMAP files carry into the
  > internal **+z-forward (OpenCV)** axes `rays.py` consumes, by negating the camera y/z axis columns
  > (`c2w[0:3, 1:3] *= −1` — the exact inverse of the photogrammetry emitter's flip, so it round-trips).
  > Before this, the parser applied **no** conversion, so a real external `transforms.json` trained
  > garbage (center rays pointing away from the scene, images vertically mirrored); the shipped E2E
  > masked it by using the service's own synthetic fixture. The fixture (`tests/synthetic.py` `look_at`)
  > now emits OpenGL poses (forward = −z, +y up) and renders/returns their internal form via
  > `opengl_to_internal`, so the suite exercises the standard convention end-to-end; the FR-9 regression
  > lives in `tests/test_opengl_convention.py`. Nerf suite: **65 green** (the prior 63 + 2 FR-9 tests).
  > This is the only change to the nerf service; it does not alter `rays.py`'s internal +z-forward math.
  > See SPEC-13 §1 / §6.2 / FR-9.
- **FR-4** A synthetic-pose fixture (analytic render of a known shape) drives reproducible training tests.
- **FR-5** Exporter produces a GLB consumable by the existing `MeshDoc` → reconstruct path.
- **FR-6** FastAPI **submit→poll** (`/train` → poll → mesh GLB), mirroring reconstruct/capture.
- **FR-7** Browser client is its own workspace package **`@plastiq/nerf`** (`packages/nerf`, sibling of
  `@plastiq/cad`/`@plastiq/sim`): `trainNerf()` submit→poll → `{ glb, report }`. `apps/plastiq` maps the
  GLB into a `MeshDoc` and wires it into "Convert to CAD" with a `nerfBaseURL` setting — **reachable from
  the running app** (a real browser E2E now drives it; §6). The `NerfCaptureSection` marquee input UX is
  complete: it exposes the §5 training knobs — method (`neus`/`nerf`), iters, grid_res, position
  `encoding` (NeRF-only; the NeuS select disables/resets it), and `importance_samples` — and pairs the
  selected images to `transforms.json` frames **by filename** (`framePairing.ts`: `frames[].file_path`
  basename match, case-insensitive, extension-tolerant; positional fallback with a surfaced note when no
  frame carries a path), replacing the earlier positional-only picker order.

## 4. Non-functional

- **NFR-1 Deterministic** — same seed → same field/mesh (explicit MLX keys), tests reproducible.
- **NFR-2 Real training, no stubs** — training tests assert genuine PSNR / mesh improvement from a real
  M4-Max run; full-quality configs documented, not run in CI. The served `/train` pipeline is honest
  about its own metric: `_holdout_split` (`engine/pipeline.py`) sets aside ~10% of the rays (seeded,
  capped) **before** training and the reported `psnr` is evaluated on those held-out rays only — a
  genuine held-out quality signal, not a held-in sample of the training rays. The client's
  "held-out PSNR" documentation is therefore now truthful.
- **NFR-3 Honest scope** — pose accuracy (COLMAP) and training budget bound quality; organic scenes →
  organic meshes (the NFR-4 reconstruct caveat).

## 5. Service wire contract (the API N10 implements, `@plastiq/nerf` consumes)

The browser client (`packages/nerf`, N11) was written before the server (N10); this is the frozen
contract both honor. It mirrors `services/capture` exactly (same `/jobs/{id}/…` polling, same
`glb_base64`/`vertices`/`faces` result keys) so the client reuses the established submit→poll shape.

| Method & path | Request | Response |
|---|---|---|
| `POST /train` | `{ transforms_json: string, images: string[], iters?: int, method?: "nerf"\|"neus", grid_res?: int, encoding?: "frequency"\|"hashgrid", importance_samples?: int }` | `{ id: string, state: string, error: null }` (a `JobView`; 200); **429** when `NERF_MAX_CONCURRENT_JOBS` (default 2) already running; 400 on a malformed body; 422 for `encoding: "hashgrid"` with `method` ≠ `"nerf"` |
| `GET /jobs/{id}/status` | — | `{ id, state, error? }` — `state ∈ {queued, running, completed, failed}` |
| `GET /jobs/{id}/result` | — | `{ glb_base64: string, vertices: int, faces: int, psnr: float, method: string, iters: int, encoding: string, importance_samples: int }` (200 when completed; 409 if not; 500 if failed; 404 unknown id) |
| `DELETE /jobs/{id}` | — | 204 (job record dropped — cancel/cleanup; an in-flight worker's eventual result is discarded); 404 unknown id |
| `GET /health` | — | `{ status, service }` |

**Additive `/train` fields (2026-07-04, in lockstep with the client).** `encoding` picks the NeRF
position encoding — `frequency` (classic sinusoidal, default) or `hashgrid` (instant-NGP multiresolution
hash grid). It applies to `method="nerf"` only: the `neus` SDF trunk consumes **raw** coordinates by
design (its geometric init requires them), so it has no position encoding to swap — `encoding:"hashgrid"`
with `method:"neus"` is **rejected 422** (a `TrainBody` `model_validator`), not silently ignored.
`importance_samples` (int, `0..128`, default `0`) adds a fine PDF (hierarchical) sampling pass on the
surface, supported by **both** models; `0` = coarse-only. Both echo back additively in `/result`
(`encoding`, `importance_samples`) so a caller sees the settings the served model actually trained with.
The `POST /train` 200 body is a **`JobView`** (`{id, state, error:null}`) — not a bare `{id, state}`; the
client reads only `id`, so the added `error` key is compatible. The **429** row is likewise recorded here
so N10 does not diverge from this table.

`transforms_json` is the stringified `transforms.json`; `images` are base64 PNG/JPEG parallel to its
frames. The client maps the result to `{ glb: glb_base64, report: { method, iters, psnr, vertices,
faces, encoding?, importanceSamples? } }` (the last two mapped only when the service sends them, so an
older service still parses); the app then wraps `glb` as a `MeshDoc`. **N10 must not diverge from this
table** without updating the client + this spec together (as the 2026-07-04 additions above did).

`DELETE /jobs/{id}` **now has a real consumer** (retires `UnfinishedFable.md` §5 11-M2). `@plastiq/nerf`
exports `cancelJob(id, opts)` (`packages/nerf/src/client.ts`, `DELETE {base}/jobs/{id}`, resolves on 204
**and** 404), and the panel's Cancel button calls it (via `apps/plastiq/src/ai/nerf.ts` `cancelCapture`
→ `cancelJob`): the training call captures the job id through `trainNerf`'s `onJob` callback, and Cancel
aborts client-side polling and then best-effort DELETEs the server job so it stops training for nobody.

**Auth.** When the service is deployed with `NERF_API_KEY` set, `POST /train` and `DELETE /jobs/{id}`
require `Authorization: Bearer <key>` and reply 401 without it; unset ⇒ open (the dev default,
matching the self-hosted capture/reconstruct siblings). The key is read **per-request** (`_api_key()`
reads the environment inside `require_auth`, not at import), so it can be set/rotated without
re-importing the app, and the header is compared with `secrets.compare_digest` (constant-time, byte
form — no timing side-channel, non-ASCII input can't raise). This is now covered by pytest
(`services/nerf/tests/test_auth.py`, over the real ASGI app: 401 on missing/wrong/scheme-less bearer,
200/204 with the correct one, open when unset — and the 401 path proves auth runs *before* any job
work). The client sends the header on **every** request when a key is configured (`NerfOptions.apiKey`,
sourced app-side from the persisted `nerfApiKey` setting — Settings panel field `settings-nerf-key`), so
the read endpoints stay compatible if they are ever guarded too.

## 6. Status

N0–N12 shipped. The full MLX core (encoder/field/sampler/renderer/VanillaNeRF + VolSDF surface, real
M4-Max train-on-synthetic, hash-grid), the exporters (marching-cubes → GLB), the FastAPI submit→poll
`/train` service (§5 contract; real submit→poll→GLB API test), and the TS side end to end: the
`@plastiq/nerf` package (`trainNerf` client) **wired into the app** — `apps/plastiq/src/ai/nerf.ts`
imports it, `NerfCaptureSection` (GenerationPanel) drives it, the produced `MeshDoc` (`mode:
"photos3d"`) flows into the existing "Convert to CAD" reconstruct path.

**A real browser E2E now exists** (`e2e/plastiq/nerf.spec.ts`, 2026-07-04 — retires
`UnfinishedFable.md` §5 11-M1). It is **service-gated exactly like `reconstruct.spec.ts`**: a
`/health` reachability probe `test.skip`s it when the nerf service is down (CI stays green without the
service), and when the service is up it drives the *whole* un-mocked stack — browser → `NerfCaptureSection`
→ `@plastiq/nerf` → HTTP → the running MLX service (real training + marching-cubes) → GLB → `MeshDoc` →
the mesh renders in the viewport (`meshBodyCount() > 0`) and the panel switches to Convert-to-CAD. The
reachable train→mesh→render path was **run green against a live service on the M4 Max on 2026-07-04**
(`plastiq-nerf` uvicorn on `:8002`; `NERF_URL=http://127.0.0.1:8002 pnpm exec playwright test
e2e/plastiq/nerf.spec.ts` → 1 passed, real MLX train at the plan's smallest fast knobs: few iters, 32³
grid); the earlier "reachability is structural / tested island"
wording is **superseded** — there is now a browser E2E, not only the import chain and the `trainNerf`-mocking
unit test.

Additive since N12 (all in lockstep with the client + the §5 table, 2026-07-04): the two `/train`
`encoding`/`importance_samples` fields (surfacing the hash-grid and PDF-importance paths in the served
product), genuine held-out PSNR (`_holdout_split`), constant-time pytest-covered auth, the real
`DELETE`/Cancel consumer, the full `NerfCaptureSection` knob set, and filename-based image↔frame pairing.

The documented `plastiq-nerf` conda env (from `environment.yml`) is created and the full suite —
**63 tests incl. the real submit→poll→GLB FastAPI test and the new auth tests — passes there** (63 as of
2026-07-04; 53 at 2026-07-03; 43 at N12). N0–N12 complete.
