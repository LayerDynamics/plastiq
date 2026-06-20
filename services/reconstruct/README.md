# plastiq-reconstruct — mesh → B-rep + STEP service

Turns a generated/imported triangle **mesh document** into a real OpenCASCADE **B-rep**
shape and exports it as **STEP**, so the creative path's output can become editable CAD
geometry that round-trips through `@plastiq/cad`'s `importStep`.

This is a **server** (Python + [pythonOCC]) — a deliberate departure from Plastiq's
otherwise no-server design — because OCCT surface fitting (RANSAC primitive detection,
roadmap below) is not feasible in the browser's OCCT-WASM build. It reverses two SPEC-6
decisions on purpose (see `docs/specs/SPEC-6-ai-generation.md` §13 and the no-server
identity); the parametric path stays fully client-side and unchanged.

## What it does today (R6.1)

A complete, working **faceted** reconstruction: every mesh triangle becomes a planar OCCT
face, sewn (`BRepBuilderAPI_Sewing`) into a shell and — when the mesh is watertight — a
solid, then written to STEP (`STEPControl_Writer`). It always yields a valid B-rep STEP
from any triangle soup. It is **not yet** a clean parametric reconstruction: a faceted
solid has one B-rep face per triangle (dense, large STEP, not nicely editable). Collapsing
fitted regions into single analytic surfaces is the next milestones (see Roadmap).

Coordinates are passed through unscaled (SI metres), matching `@plastiq/cad`'s STEP I/O
(`packages/cad/src/io/index.ts`), so the output imports back with consistent units.

## API (submit → poll, mirrors the fal mesh-gen queue the client already speaks)

| Method | Path | Body / result |
|---|---|---|
| `GET`  | `/health` | `{ status, service }` |
| `POST` | `/reconstruct` | `{ glb_base64, file_type? }` → `{ id, state }` |
| `GET`  | `/jobs/{id}/status` | `{ id, state, error? }` — `queued`/`running`/`completed`/`failed` |
| `GET`  | `/jobs/{id}/result` | `{ step, report }` when completed (409 while running, 500 if failed) |

`report` = `{ triangles_in, faces_built, is_solid, is_valid, method }`.

## Run locally

```bash
mamba env create -f environment.yml          # one-time (pythonocc-core is conda-forge only)
mamba run -n plastiq-reconstruct uvicorn app.main:app --port 8000
```

## Test (real OCCT, no mocks)

```bash
mamba run -n plastiq-reconstruct python -m pytest -q
```

Covers: a watertight cube → valid STEP **solid**; an open mesh → valid **shell**;
degenerate triangles skipped; and the full `POST /reconstruct` → poll → `result` flow over
the ASGI app with a real GLB.

## Docker / deploy

```bash
docker build -t plastiq-reconstruct services/reconstruct
docker run -p 8000:8000 plastiq-reconstruct
```

The image builds the conda env from `environment.yml` on `condaforge/miniforge3`. Deploy
target is self-hosted Docker (Railway / Cloudflare tooling is available in this repo when
chosen). The browser reaches it by base URL — same BYO/self-host spirit as the AI proxy
seam, so no provider key leaves the user's control.

## Honest caveat

The creative path generates **organic** meshes, which are the **hardest** case for
mesh→B-rep: smooth blobs have no clean primitives to fit, so even after the fitting
milestones they reconstruct mostly as dense freeform/faceted faces. Mechanical-looking
meshes (flats, holes, fillets) reconstruct far better. This is a fundamental limit of
automatic reconstruction, not an implementation gap.

## Roadmap (milestone R6)

- **R6.1 (done)** — service skeleton + faceted mesh→STEP (this).
- **R6.2** — mesh ingest/cleanup (Open3D: repair, normals, decimation).
- **R6.3** — RANSAC primitive segmentation (planes / cylinders / cones / spheres).
- **R6.4** — replace fitted regions with single analytic trimmed faces (the clean,
  editable reconstruction; collapses thousands of triangles per region).
- **R6.5** — BSpline freeform fallback for non-primitive regions.
- **R6.6** — client `ReconstructionProvider` + "Convert mesh → CAD (STEP)" action →
  `importStep` → a normal `CadDocument`.
- **R6.7** — server + client tests (unit + real-mesh integration).
- **R6.8** — deploy + docs.

[pythonOCC]: https://github.com/tpaviot/pythonocc-core
