# plastiq-reconstruct — mesh → B-rep + STEP service

Turns a generated/imported triangle **mesh document** into a real OpenCASCADE **B-rep**
shape and exports it as **STEP**, so the creative path's output can become editable CAD
geometry that round-trips through `@plastiq/cad`'s `importStep`.

This is a **server** (Python + [pythonOCC]) — a deliberate departure from Plastiq's
otherwise no-server design — because OCCT surface fitting (RANSAC primitive detection,
roadmap below) is not feasible in the browser's OCCT-WASM build. It reverses two SPEC-6
decisions on purpose (see `docs/specs/SPEC-6-ai-generation.md` §13 and the no-server
identity); the parametric path stays fully client-side and unchanged.

## What it does today (R6.1–R6.4)

Reconstruction runs in two selectable methods; **`fitted` is the default**:

- **`fitted`** (R6.3/R6.4) — clean the mesh, group coplanar+adjacent triangles into
  **facets**, and collapse each planar facet into a **single trimmed OCCT planar face**
  (built from the facet's boundary loop). Facets with holes (multiple loops) or that fail
  to build, and triangles in no facet, fall back to per-triangle faces — nothing is
  dropped. All faces are sewn into a shell and a solid when watertight. This is a clean,
  compact B-rep for the flat regions of a part (e.g. a box → 6 faces, not 12 triangles).
- **`faceted`** (R6.1) — the per-triangle baseline; always produces a valid B-rep from any
  triangle soup. Useful as a fallback / comparison.

Both run after mesh cleanup (R6.2 — weld coincident vertices, drop degenerate/duplicate
faces, fix winding/normals, fill small holes) and write STEP via `STEPControl_Writer`.
**Curved-surface fitting** (cylinders/spheres/cones → single analytic faces) is the next
milestone; until then curved regions arrive as their planar sub-facets.

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
method }` — `triangles_in` = raw, `triangles_used` = after cleanup, `planar_faces` =
facets collapsed into single trimmed faces (0 for `faceted`).

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

- **R6.1 (done)** — service skeleton + faceted mesh→STEP.
- **R6.2 (done)** — mesh cleanup (weld/repair/winding/normals/fill-holes via trimesh).
- **R6.3 (done)** — planar facet segmentation (coplanar+adjacent triangles via trimesh/scipy).
- **R6.4 (done, planar)** — collapse each planar facet into a single trimmed analytic face
  (faceted fallback for holed facets + leftovers).
- **R6.4a (done)** — cylinder spike (GATE): deterministic cylinder fit (`primitives.py`) +
  analytic 3-face solid sharing the exact rim circles (`curved_faces.py`) + region detection
  (`detect.py`). Proves `is_solid` survives the analytic collapse; faceted caps regress to a
  shell (the shared-edge crux). See SPEC-7.
- **R6.4b (done)** — sphere + cone fits/solids + **auto single-primitive classification**
  (`detect.try_single_primitive`, default `method="auto"`, box-safe shape gates), and
  **surface-of-revolution** mixed parts (`revolution.py` — stepped shafts / chamfered /
  capped cylinders → one analytic revolved solid, volume-validated).
- **R6.4b-iii (done, bounded)** — non-coaxial mixed parts via **CSG booleans** (`csg.py` —
  InverseCSG paradigm): axis-aligned box − cylindrical through-holes via `BRepAlgoAPI_Cut`
  (OCCT computes the shared edges), volume-validated. General arbitrary CSG trees remain future.
- **R6.5** — BSpline freeform fallback for non-primitive regions.
- **R6.6 (done)** — client `reconstructMesh` (submit/poll) + a "Convert mesh → CAD (STEP)"
  action in the GenerationPanel → `stepToImportDocument` → the kernel `importStep` feature
  → an editable `CadDocument` (`apps/plastiq/src/ai/reconstruct.ts`).
- **R6.7** — server + client tests (unit + real-mesh integration).
- **R6.8** — deploy + docs.

[pythonOCC]: https://github.com/tpaviot/pythonocc-core
