# Plan — SPEC-7 R6: Mesh → B-rep (STEP) reconstruction service

**Date:** 2026-06-20
**Spec:** `docs/specs/SPEC-7-mesh-reconstruction.md` → milestone **R6**
**Execution:** inline sequential · **test-first** · server tests run against a live pythonOCC
conda env (`plastiq-reconstruct`); the keyed client↔server test self-skips in CI
**Commit:** conventional commits, one per sub-milestone at green (ask before committing)

## Goal

Turn a generated/imported triangle **mesh** into a watertight, editable **B-rep STEP solid**
so the SPEC-6 creative path's mesh documents become real CAD (`importStep` → `CadDocument`).
Deterministic (NFR-2); never drops geometry (faceted fallback, NFR-1).

## Grounding (verified)

- Service: `services/reconstruct/app/*` (FastAPI submit→poll, `main.py`/`jobs.py`); STEP I/O
  matches the kernel (`occ_step.py` ↔ `packages/cad/src/io/index.ts:20`).
- Curved-fitting extension point: `app/fitted.py:96` (`leftover` = non-planar triangles).
- Client: `apps/plastiq/src/ai/reconstruct.ts` → `stepToImportDocument` → kernel `importStep`
  feature (`apps/plastiq/src/worker/rebuild.ts:430`, `data.step`).
- Env: `pythonocc-core` + `trimesh` + `numpy` + `scipy`/`networkx` (conda-forge; pythonOCC is
  conda-only). All analytic/boolean OCCT constructors verified building valid solids in-env.
- The decisive design fact (SPEC-7 §D-3): fit-then-sew-by-tolerance regresses a solid to a
  shell (an analytic rim deviates from a faceted neighbor by the sagitta ≈ 86× the sew tol) —
  so curved solids are built either from all-analytic coincident edges, OCCT revolution, or
  OCCT booleans, never naive sewing of mismatched boundaries.

## Tasks

### R6.1 — Service skeleton + faceted baseline — ✅ shipped
- `app/{meshio,faceted,occ_step,pipeline,jobs,main}.py` + tests. GLB → per-triangle sewn
  shell/solid → STEP; submit→poll API. (`commit e3e0797`)

### R6.2 — Mesh cleanup — ✅ shipped
- `app/cleanup.py` (trimesh repair: weld / drop degenerate+duplicate / fix winding+normals /
  fill holes). Report exposes `triangles_in` vs `triangles_used`. (`commit 7055005`)

### R6.3 / R6.4 — Planar facet fitting — ✅ shipped
- `app/segment.py` (`trimesh.facets`) + `app/fitted.py` (each planar facet → one trimmed face;
  faceted fallback for holed facets + leftovers). `method="fitted"`. (`commit cdcad9e`)

### R6.4a — Cylinder spike (GATE) — ✅ shipped
- `app/primitives.fit_cylinder` (Gauss-map axis + Kåsa circle, deterministic) +
  `app/curved_faces.cylinder_solid` (lateral + 2 analytic circle caps sharing exact rim
  circles → watertight) + `app/detect` (dominant normal-cluster axis). Gate proven: `is_solid`
  survives the analytic collapse; polygon caps → shell (`tests/test_cylinder.py`). (`7712244`)

### R6.4b-i — Sphere + cone + auto single-primitive — ✅ shipped
- `fit_sphere`/`fit_cone` + `sphere_solid`/`cone_solid` (BRepPrimAPI). `detect.try_single_primitive`
  (default `method="auto"`) with SHAPE gates (angular coverage / distinct-normal count) so a box
  isn't misread as a primitive. (`tests/test_sphere.py`,`test_cone.py`,`test_auto.py`; `516b589`)

### R6.4b-ii — Surface-of-revolution mixed parts — ✅ shipped
- `app/revolution.py`: section through the axis → ordered r≥0 profile → `BRepPrimAPI_MakeRevol`
  (shared circle edges automatic); volume-self-validated. Stepped shafts / chamfered / capped
  cylinders. (`tests/test_revolution.py`; `8b2ff8a`)

### R6.4b-iii — CSG/boolean (box with cylindrical holes) — ✅ shipped (bounded)
- `app/csg.py`: AABB box − cylindrical through-holes via `BRepAlgoAPI_Cut` (InverseCSG
  paradigm; OCCT computes shared edges). Hole vs boss from wall-normal direction; volume-
  validated. (`tests/test_csg.py`; `c811601`)

### R6.6 — Browser client — ✅ shipped
- `apps/plastiq/src/ai/reconstruct.ts` (submit/poll) + `stepToImportDocument`; "Convert to CAD"
  in `GenerationPanel`. (`63eb313`)

### R6.7 — Client↔server integration E2E — ✅ shipped (browser E2E pending, see R6.7b)
- `apps/plastiq/src/ai/reconstruct.integration.test.ts` (keyed `RECONSTRUCT_URL`, skips in CI):
  real client → real HTTP → live service → STEP, verified this session. (`7bcb2f7`)

---

### R6.5 — Freeform (BSpline / filling) for smooth non-primitive regions — planned
- **Files (new):** `services/reconstruct/app/freeform.py`, `tests/test_freeform.py`.
- **Test-first:** a smooth bounded region's points + boundary → a valid `TopoDS_Face`;
  assert the face is valid and within tolerance of the sample points. Red first.
- **Implement:** `BRepOffsetAPI_MakeFilling` (boundary edges + interior `gp_Pnt` constraints,
  no grid) as the primary; `GeomPlate_BuildPlateSurface`+`GeomPlate_MakeApprox` for scattered
  energy-min; `GeomAPI_PointsToBSplineSurface` only when a structured grid is resamplable.
- **Integration caveat (state honestly in the plan + code):** a freeform face only joins a
  solid where its boundary coincides with neighbors — i.e. it needs the general topology tail
  (R6.4b-iv) to be useful inside a solid. Until then `freeform.py` is exercised standalone +
  as a per-region upgrade where boundaries already coincide; closed organic blobs keep the
  faceted solid (already valid).
- **Done when:** freeform faces build + validate; no regression; honest scope noted.

### R6.4b-iv — General CSG (additive bosses, multi-primitive) — ✅ shipped (bosses)
- Done: `app/csg.py` now does box (∪ bosses) (− holes) — base box from the dominant planar
  faces (boss top doesn't inflate it), bosses `Fuse` then holes `Cut`, volume-validated. A
  box-with-boss → 9-face solid (`tests/test_csg.py`). Remaining future: non-axis-aligned
  bases, non-cylindrical features, nested/repeated trees.
- (original task, for the remaining future scope:)
- **Test-first:** a box-with-cylindrical-boss GLB → `BRepAlgoAPI_Fuse(box, cylinder)` → valid
  solid, volume = box + boss; then a part with both a hole and a boss; assert volume match.
  Red first.
- **Implement:** (1) **bosses** — a curved region whose wall normals point OUTWARD and whose
  base sits ON a planar face → `Fuse`; derive the base box from the planar-face *planes* (not
  the AABB, so the boss height doesn't inflate the base). (2) **boolean tree order** — apply
  fuses, then cuts, validating volume after each. (3) **non-axis-aligned base** — build the
  base prism from the planar half-spaces (intersection of the 6 face planes) instead of the
  AABB. Volume-self-validated; reject (→ fitted) when the result doesn't match the mesh.
- **Risk:** OCCT booleans can fail on tangent/coincident inputs — check `IsDone()` + validity
  per op, reject on failure (no fragile output). Full arbitrary InverseCSG (nested/repeated
  features, program synthesis) stays out of scope.
- **Done when:** box+boss and box+hole+boss reconstruct to valid volume-matching solids;
  out-of-scope parts fall back cleanly.

### R6.7b — Browser reconstruction E2E (Playwright) — planned
- **Files:** `e2e/plastiq/reconstruct.spec.ts`; a small run note (service must be up).
- **Test-first:** with the service running (gate the spec on `RECONSTRUCT_URL` reachability so
  CI without it skips), drive the real app: open a mesh document → "Convert to CAD (STEP)" →
  the viewport renders a B-rep part (assert `__plastiqViewport.builtPart` / `faceCount()>0`).
  A true no-mock E2E (browser → client → service → STEP → kernel `importStep` → render).
- **Implement:** any test seam needed on the convert action; reuse the `__plastiqViewport`
  seam. Honest label: this is the model-free reconstruction E2E; it is NOT the AI E2E.
- **Done when:** green locally with the service up; skips cleanly without it.

### R6.8 — Deploy — deferred (decision D-6, local-only for now)
- Dockerfile + `environment.yml` exist. When deploying: prebuild the conda image, push to a
  registry, run on Railway (≈2–3 GB image, under the ~4 GB cap), set the app's
  `reconstructBaseURL`. `/health` exists (`main.py:50`). Cloudflare Workers can't host it.

## Milestone exit criteria

- Per sub-milestone: its tests green in the conda env (`python -m pytest -q`), zero regression
  in the existing service suite (currently **42 passing**) + the plastiq suite; STEP round-trips
  through the kernel `importStep`.
- R6 "analytic reconstruction" goal: cylinders, spheres, cones, turned parts, and drilled
  plates reconstruct to clean analytic/boolean solids; everything else to a valid faceted
  solid (no data loss). Remaining: R6.5 freeform, R6.4b-iv general CSG, R6.7b browser E2E.

## Risks specific to R6

- **Shared-edge topology** is the crux (R-1): build curved solids via all-analytic coincident
  edges / revolution / booleans, never naive sewing. The faceted fallback (R6.5/§D-5) bounds
  every failure to "valid but dense", never invalid.
- **Determinism (NFR-2):** all fits are closed-form / fixed-order; no RANSAC. Keep it that way.
- **OCCT boolean fragility:** verify `IsDone()` + closure + volume after each op; reject on
  failure rather than emit a bad solid.
- **Organic-mesh quality (R-3):** few primitives + tangential joins → faceted/freeform; the
  honest caveat stands. Mechanical/turned/drilled parts are the sweet spot.

## Commit

One conventional commit per sub-milestone at green (e.g. `feat(reconstruct): R6.5 — freeform
faces via MakeFilling`); ask before committing.
