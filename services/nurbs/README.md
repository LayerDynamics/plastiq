# plastiq-nurbs — modular MLX NURBS

A self-hosted **MLX** NURBS **surface-fitting** service: a triangle mesh's smooth/organic regions →
real B-spline surfaces via deterministic least-squares fitting + differentiable (gradient)
refinement → validated NURBS-surface JSON + a B-rep **STEP** the app imports as editable CAD. It
closes the gap the reconstruct service documents as fundamental — a closed organic region "can't be
one filled patch" (`services/reconstruct/app/freeform.py`). Fitting, not generation (SPEC-6 owns
text→CAD); smooth/organic meshes, not mechanical parts (reconstruct owns those). See
[SPEC-12](../../docs/specs/SPEC-12-nurbs-service.md),
[ADR-0012](../../docs/adr/0012-nurbs-service-architecture.md), and the plan
[`docs/plans/2026-07-04-nurbs-service.md`](../../docs/plans/2026-07-04-nurbs-service.md).

**Status: implemented (SPEC-12 U0–U9 shipped).** The service is real: `app.main` serves the
SPEC-12 §6.1 contract on port **:8003**, the U7 watertight-blob gate passed (a genus-0 blob → a
sewn watertight all-NURBS STEP solid: `is_solid`, `is_valid`, `free_edges == 0`), and the
`plastiq-nurbs` pytest suite is green (**356 tests**). Reconstruct delegation (U10) is deferred.
The wire contract below is the SPEC-12 §6.1 contract `app.main` implements; the module map is the
shipped SPEC-12 §5.2 layout.

## Architecture (SPEC-12 §5.2)

```text
app/core/basis.py      FindSpan / BasisFuns / DersBasisFuns (Piegl & Tiller A2.1–A2.3), pure mlx.core
app/core/eval.py       tensor-product surface eval (A3.5/A4.3), derivatives, design-matrix builder
app/core/knots.py      clamped knot vectors, averaging placement, insertion/refinement, compact↔flat
app/core/params.py     chord-length/centripetal parameterization, Newton point projection (§6.1)
app/core/fit_lsq.py    scattered-data LSQ with fairness + rim constraints (float64, CPU stream)
app/core/fit_grad.py   mx.value_and_grad control-point refinement (Chamfer + fairness, no RNG)
app/core/losses.py     chunked bidirectional Chamfer, RMS/max deviation, SCD
app/param.py           harmonic disk map (open) / cube-map 6-chart layout (closed genus-0)
app/boundary.py        closed-mode shared boundary-curve fitting (fit_shared_curves / pin_chart_rims)
app/meshio.py          GLB loading (trimesh), boundary-loop/genus analysis, mode auto-detect
app/schema.py          NURBS-surface JSON model + knot-law invariant validation (SPEC-12 §6.2)
app/occ_step.py        JSON → Geom_BSplineSurface → faces → sew → solid → verify → STEP (isolated OCCT)
app/occ_pool.py        spawn-context crash-isolated worker runner (run_isolated) — OCCT never kills the service
app/faceted.py         FR-5 faceted fallback: per-triangle faces + mixed NURBS/faceted solid assembly
app/pipeline.py        open-mode orchestration: GLB → single-patch STEP + FR-9 report
app/pipeline_closed.py closed-mode orchestration: 6-patch cube-map → watertight solid (the U7 gate)
app/jobs.py            in-memory JobStore: {queued, running, completed, failed}, TTL + cap eviction
app/main.py            FastAPI submit→poll (§6.1), bearer auth, CORS, input caps
app/logging_setup.py   NURBS_LOG_LEVEL logger setup (nerf pattern)
```

Determinism by construction: no RNG anywhere (LSQ init, fixed iteration budgets — SPEC-12 D-10);
float32 GPU for the gradient loop, float64 CPU for LSQ solves and validation (D-9).

## API (submit → poll — the SPEC-12 §6.1 contract, served by `app.main` on :8003)

| Method | Path | Body / result |
| --- | --- | --- |
| `GET` | `/health` | `{ status, service }` |
| `POST` | `/fit` | `{ glb_base64, mode? ("auto" \| "open" \| "closed"), degree? (default 3, 2..8), grid? (control points per direction, default 16, 4..64), iters? (default 200, 0..2000; 0 ⇒ LSQ only), fidelity_tol? }` → `{ id, state }` |
| `GET` | `/jobs/{id}/status` | `{ id, state, error? }` — `state ∈ {queued, running, completed, failed}` |
| `GET` | `/jobs/{id}/result` | `{ step, surfaces, report }` — 200 when completed; 409 if not; 500 if failed; 404 unknown id |
| `DELETE` | `/jobs/{id}` | 204 (job dropped); 404 unknown id |

`NURBS_API_KEY` set ⇒ `POST /fit` + `DELETE /jobs/{id}` require `Authorization: Bearer <key>`
(unset ⇒ open dev default); `NURBS_CORS_ORIGINS` and `NURBS_MAX_CONCURRENT_JOBS` mirror the other
services. The browser client is `@plastiq/nurbs` (`packages/nurbs`) — `fitNurbs()` submit→poll →
the STEP flows into the app's existing `stepToImportDocument` → `importStep` path (wired in
`apps/plastiq/src/ai/nurbs.ts`).

## Run locally (Apple Silicon)

```bash
mamba env create -f environment.yml          # conda-forge (incl. pythonocc-core) + pip mlx, geomdl
mamba run -n plastiq-nurbs uvicorn app.main:app --port 8003
```

`app.main` serves the §6.1 contract on :8003. The env is created and proven (mlx + geomdl + OCCT
importable together) per milestone U0.3, which also registers the service in
`scripts/dev-services.sh` / `just services` alongside reconstruct :8000, capture :8001,
nerf :8002, and photogrammetry :8004. `pnpm dev` owns that five-service supervisor together
with the editor; app shutdown stops only supervisor-owned processes.

## Test

```bash
mamba run -n plastiq-nurbs python -m pytest -q
```

Strict TDD throughout: geomdl/scipy/OCCT oracle-parity tests for the MLX core, real M4-Max fitting
asserts, and real `httpx.ASGITransport` submit→poll→result API tests (no mocks). The suite is
green at **356 tests**.

## Scope (honest limits — SPEC-12 NFR-5)

- **Smooth/organic meshes only.** NURBS smooths: sharp-edged mechanical parts belong to
  reconstruct's analytic path; the report's `max_deviation` exposes any rounding of sharp features.
- **Genus ≥ 1 inputs (torus-like) are rejected** with a clear error — v1 handles disk-topology
  (open) and closed genus-0 meshes only.
- **Per-patch accuracy gate with faceted fallback**: a patch that misses `fidelity_tol` falls back
  to faceted faces so the service always returns a valid STEP; the report counts
  `fitted_patches` / `faceted_patches` truthfully.
- **Local-only** (MLX is Apple-Silicon-only) — no deploy/Docker in v1, matching capture/nerf.
