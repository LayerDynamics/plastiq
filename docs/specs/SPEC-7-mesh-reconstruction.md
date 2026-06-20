# SPEC-7 — Mesh → B-rep (STEP) Reconstruction Service

**Status:** Draft (R6.1–R6.4 planar + R6.6 client SHIPPED; curved/freeform milestones planned)
**Date:** 2026-06-20
**Owner:** LayerDynamics
**Depends on:** SPEC-6 (AI generation — the creative path that produces mesh documents), `@plastiq/cad` (STEP I/O, `importStep`)
**Supersedes / relates to:** reverses two SPEC-6 decisions by explicit user direction — §13 "Mesh→B-rep reconstruction = out of scope" and the no-server identity (see memory `mesh-to-brep-server-decision`).
**Grounded in (this session, all verified):** `docs/research/2026-06-20-mesh-to-brep-reconstruction/Report-Final.md` + `Agent{1..4}Findings.md`; `docs/investigations/2026-06-20-r6-curved-reconstruction-and-tail.md`; the shipped `services/reconstruct/**` (verified against a live `pythonocc-core` conda env, 16 pytest passing) and `apps/plastiq/src/ai/reconstruct.ts`.

---

## Revision history

- **2026-06-20 (r1):** Initial spec, formalizing the deep investigation + web research. Encodes
  R6.1–R6.4 (planar, shipped) + R6.6 (client, shipped) as built, and specifies R6.4-curved,
  R6.5, R6.7, R6.8. User decisions this session: **vendor/fork Point2CAD** as the curved
  fitting/topology dependency (decision D-7); **phased** curved scope — cylinder spike →
  sphere/cone → freeform (decision D-8); deploy **deferred / local-only** (decision D-6).

---

## 0. One-sentence thesis

A local Python + OpenCASCADE (`pythonocc-core`) service that reconstructs a generated/imported
triangle **mesh** into a watertight, editable **B-rep STEP solid** — collapsing flat and curved
regions into real analytic faces — so the SPEC-6 creative path's mesh documents can become true,
editable CAD parts (`importStep` → `CadDocument`), with an honest faceted fallback that never
drops geometry.

## 1. Problem & context

SPEC-6 added a creative path: text/image → a **mesh document** (triangle soup, stored as an inline
base64 GLB; `apps/plastiq/src/store/types.ts` `MeshDoc`). A mesh document renders and exports as a
mesh, but is an **interchange + editing dead-end** — `@plastiq/cad`'s STEP export
(`packages/cad/src/io/index.ts:20`) only accepts a B-rep `Solid`. Turning the mesh into a clean,
editable solid requires surface fitting (RANSAC/region-growing + analytic surfaces) that is **not
feasible in the browser's OCCT-WASM build** → a server. This reverses SPEC-6's no-server identity
and its "reconstruction out of scope" — both by explicit user decision.

**Already shipped (this milestone family R6):**
- R6.1 faceted baseline · R6.2 mesh cleanup · R6.3/R6.4 **planar** facet fitting → trimmed
  analytic planar faces (`services/reconstruct/app/{meshio,cleanup,segment,faceted,fitted,occ_step,pipeline,jobs,main}.py`; 16 pytest vs live OCCT).
- R6.6 browser client: `apps/plastiq/src/ai/reconstruct.ts` (submit/poll) + `stepToImportDocument`
  → kernel `importStep` feature (`worker/rebuild.ts:430`, `data.step`); "Convert to CAD" action in
  `GenerationPanel.tsx`.

**The gap:** curved regions (cylinder/sphere/cone) and freeform regions still arrive **faceted**
(`fitted.py:96`, where `leftover` triangles fall back to per-triangle faces).

## 2. Locked decisions

| # | Decision | Rationale / consequence |
|---|---|---|
| D-1 | **Server: Python + `pythonocc-core` (OCCT), FastAPI submit→poll** | OCCT surface fitting can't run in OCCT-WASM; FastAPI mirrors the fal queue the client already speaks. Shipped. |
| D-2 | **Architecture: classical segment-then-fit, 5 stages** | segment → per-region fit → edge recovery (surface intersection) → corner recovery → trim+sew+heal→solid. Every mature tool shares it (Agent4); stages 3–5 are classical and map 1:1 onto OCCT. |
| D-3 | **Topology is EXPLICIT (shared edges), not sew-by-tolerance** | An analytic face's ideal rim deviates from a faceted neighbor by the sagitta (≈86× the 1e-6 sew tol at r=10mm) → free edges → shell, not solid. Must intersect adjacent surfaces for the shared edge (sharp) or snap the boundary polyline (tangential). THE crux (Agent1). |
| D-4 | **STEP unit convention matches `@plastiq/cad`** | raw SI-metre coordinates, OCCT default unit, `STEPControl_AsIs` — so output round-trips through the kernel `importStep` (`occ_step.py`, `packages/cad/src/io/index.ts`). Shipped. |
| D-5 | **Faceted fallback never drops geometry** | any region that fails fitting/topology stays per-triangle (`fitted.py:80`). Correctness over compactness. Shipped for planar; extends to curved. |
| D-6 | **Deploy DEFERRED — local-only for now** | Dockerfile + `environment.yml` exist for later; no Railway/Cloudflare work now. Cloudflare Workers can't host a native container regardless. |
| D-7 | **Vendor/fork Point2CAD (arXiv 2312.04962, Apache-2.0) for curved fitting + topology** | User decision. Reuses its classical segment→fit→extend→intersect→trim tail. **Consequences the spec must manage (§4.4, R-2):** it pulls heavy deps (torch + an INR for freeform), its fitting is **randomized** (tension with NFR-2 → seed-pinning required), and its analytic-STEP export is deferred → **we still own the OCCT STEP tail**. The shipped deterministic planar path (R6.3/R6.4) stays as the fast path + fallback; Point2CAD augments, not replaces. |
| D-8 | **Phased curved scope** | R6.4a cylinder spike (gate) → R6.4b sphere + cone → R6.5 freeform. De-risks the topology tail before fanning out. |
| D-9 | **Reuse — own split** | OWN: the OCCT analytic-STEP export + the shell→solid topology/heal tail on real `Geom_*` surfaces (Point2CAD defers true B-rep STEP). REUSE: Point2CAD's segmentation + primitive/freeform fitting (vendored, seed-pinned). |

## 3. Functional requirements

- **FR-1** A `POST /reconstruct { glb_base64, file_type? }` submits a job; `GET /jobs/{id}/status`
  and `GET /jobs/{id}/result` poll it (shipped: `app/main.py`). Result = `{ step, report }`.
- **FR-2** The mesh is cleaned before fitting (weld, drop degenerate/duplicate, fix winding/normals,
  fill small holes) — shipped `app/cleanup.py` (R6.2).
- **FR-3** Planar regions collapse to single trimmed analytic faces (shipped `app/fitted.py`, R6.3/R6.4).
- **FR-4** Curved regions (cylinder/sphere/cone) are detected and collapsed to single trimmed
  analytic faces; **R6.4a** ships the cylinder path first.
- **FR-5** Freeform regions (no analytic fit) collapse to a BSpline/filled face (`BRepOffsetAPI_MakeFilling`
  / `GeomPlate`), or fall back to faceted (FR-8). (R6.5)
- **FR-6** Adjacent fitted faces SHARE exact edges: sharp joins via surface–surface intersection
  (`GeomAPI_IntSS` / `BRepAlgoAPI_Section`), tangential joins via snapped boundary polylines; corners
  via edge–edge intersection (D-3).
- **FR-7** The result is assembled shell→solid with healing (`ShapeFix_Face/Shell/Solid` →
  `BRepBuilderAPI_Sewing` → `BRepBuilderAPI_MakeSolid`) and **closure is verified, never assumed**
  (`NbFreeEdges()==0`, `BRepCheck_Analyzer`, `ShapeAnalysis_FreeBounds`, positive volume).
- **FR-8** Any region or join that fails fitting/topology falls back to faceted faces; the service
  always returns a valid B-rep STEP (D-5).
- **FR-9** The `report` exposes `{ triangles_in, triangles_used, faces_built, planar_faces,
  curved_faces, freeform_faces, faceted_faces, is_solid, is_valid, method }` so the client/UX can
  show fidelity (extends the shipped report; `method` ∈ `faceted|fitted`).
- **FR-10** The browser client (`reconstruct.ts`, shipped) submits a mesh document's GLB, polls, and
  wraps the STEP as a `CadDocument` (`stepToImportDocument` → `importStep`) → an editable B-rep part.
- **FR-11** A `method` request param selects `fitted` (default; analytic+curved+freeform) or
  `faceted` (per-triangle baseline) (shipped param in `pipeline.reconstruct`).

## 4. Architecture

### 4.1 Pipeline (5 stages + cleanup)

```text
GLB bytes
  → meshio.load_mesh            (trimesh; scenes concatenated)            [shipped]
  → cleanup.clean_mesh          (weld/repair/winding/normals/fill)        [shipped R6.2]
  → SEGMENT                     planar facets (trimesh.facets) +          [planar shipped R6.3]
                                deterministic/seeded region-growing for   [curved: R6.4+]
                                curved regions (Point2CAD, seed-pinned)
  → PER-REGION FIT              plane (shipped) · cylinder/sphere/cone    [R6.4] · freeform [R6.5]
  → EDGE RECOVERY               intersect adjacent surfaces (sharp) /     [R6.4 topology tail]
                                snap boundary polyline (tangential)
  → CORNER RECOVERY             intersect adjacent edges → vertices       [R6.4]
  → TRIM + SEW + HEAL → SOLID   ShapeFix_* → Sewing → MakeSolid + verify  [R6.4]
  → occ_step.shape_to_step      STEP text (AsIs, raw coords)              [shipped]
```

Stages 3–5 (edge/corner/trim+sew+heal) are classical and OWN-ed in OCCT (D-9). Point2CAD supplies
stage-1 curved segmentation + stage-2 fitting (vendored, D-7).

### 4.2 Modules (`services/reconstruct/app/`)
- Shipped: `meshio.py`, `cleanup.py`, `segment.py` (planar facets + `leftover`), `faceted.py`,
  `fitted.py` (planar trimmed faces + faceted fallback; **extension point: `fitted.py:96`**),
  `occ_step.py`, `pipeline.py`, `jobs.py`, `main.py`.
- New: `detect.py` (deterministic Gauss-map classification + Point2CAD adapter, seed-pinned),
  `primitives.py` (closed-form Eberly fits → `gp_Cylinder/Sphere/Cone`), `curved_faces.py`
  (trimmed analytic faces with p-curves + seam rule), `freeform.py` (MakeFilling/GeomPlate),
  `topology.py` (adjacency graph → intersect/snap → shared edges → corners → trim → heal/sew/solid).

### 4.3 Face construction (verified APIs)
- Trimmed analytic faces: build a wire of edges carrying **p-curves**
  (`BRepBuilderAPI_MakeEdge(Geom2d_Curve, surf)` → `breplib.BuildCurves3d` → `MakeWire` →
  `BRepBuilderAPI_MakeFace(surf, wire, True)`). Non-planar faces REQUIRE p-curves (OCCT auto-projects
  only for planar). Heal with `ShapeFix_Face` (`FixAddNaturalBound` before `FixMissingSeam`) +
  `breplib.SameParameter` (Agent3, verified against the SWIG wrappers).
- Point→UV: `elslib.Parameters(...)` (closed-form, returns `(U,V)`) for analytic surfaces;
  `GeomAPI_ProjectPointOnSurf.LowerDistanceParameters()` for BSpline.
- **Periodic-seam straddling** (the #1 footgun): u from `ElSLib` is in [0,2π); use the
  **largest-angular-gap** rule (region = complement of the biggest gap; unwrap by +2π) before trimming.
- Freeform: `BRepOffsetAPI_MakeFilling` (boundary edges + interior `gp_Pnt` constraints, no grid) is
  the default; `GeomPlate_BuildPlateSurface`+`GeomPlate_MakeApprox` for energy-min; `GeomAPI_PointsToBSplineSurface`
  ONLY when a structured grid is resamplable.

### 4.4 Point2CAD integration (D-7) + determinism reconciliation
Vendor/fork the Point2CAD repo under `services/reconstruct/vendor/point2cad/` (Apache-2.0; retain
LICENSE). Use its segmentation + classical primitive fits + extend/intersect/trim topology helpers.
**Because Point2CAD is randomized and pulls torch/INR, the spec REQUIRES (R-2, NFR-2):** pin all RNG
seeds (`PYTHONHASHSEED`, `numpy`, `torch`, single-thread where order-sensitive) so a given mesh
reconstructs reproducibly; prefer the shipped deterministic planar path where it already wins; and
keep the freeform INR optional behind the faceted/MakeFilling fallback. We do NOT adopt Point2CAD's
STEP/discretized output — the OCCT analytic-STEP tail (occ_step + topology) is ours (D-9).

## 5. Non-functional requirements

- **NFR-1 (no data loss):** every input mesh yields a valid B-rep STEP; unfittable regions/joins
  fall back to faceted (FR-8). Verified by closure checks (FR-7).
- **NFR-2 (reproducibility):** the same mesh + same code + **same pinned seeds** → the same STEP.
  The shipped planar path is fully deterministic (closed-form). The vendored Point2CAD curved path is
  randomized → reproducibility depends on seed-pinning (R-2); this is a known, accepted weakening of
  the original "fully deterministic" goal, a direct consequence of decision D-7.
- **NFR-3 (local-first):** runs locally via the conda env / Docker; no network egress; no telemetry.
- **NFR-4 (honest UX):** the report's face-type counts + an organic-mesh caveat communicate fidelity;
  the client labels a faceted result as such.

## 6. Data contracts

```text
POST /reconstruct      { glb_base64: string, file_type?: "glb" }      → { id, state }
GET  /jobs/{id}/status                                                → { id, state, error? }
GET  /jobs/{id}/result  (when completed)                             → { step, report }
report = { triangles_in, triangles_used, faces_built, planar_faces,
           curved_faces, freeform_faces, faceted_faces,
           is_solid, is_valid, method }
```
Client (`apps/plastiq/src/ai/reconstruct.ts`): `reconstructMesh(glbBase64, { baseURL })` →
`{ step, report }`; `stepToImportDocument(step)` → `CadDocument { features:[{type:"importStep",
data:{ step }}], params:{} }`.

## 7. Boundaries & failure modes

| From | To | Mechanism | Failure handling |
|---|---|---|---|
| browser `reconstruct.ts` | service | HTTPS submit+poll (base URL, self-host) | HTTP/4xx/5xx detail surfaced; timeout after maxPolls; failed job → message |
| service | pythonOCC / Point2CAD | in-proc (thread via `asyncio.to_thread`) | OCCT/fit exceptions → job `failed`, no partial STEP; region failure → faceted fallback |
| service STEP | kernel `importStep` | STEP text via `data.step` | invalid STEP → rebuild error flagged on the feature |

## 8. Milestones

| Milestone | Scope | Status |
|---|---|---|
| **R6.1** | Service skeleton + faceted mesh→STEP | ✅ shipped |
| **R6.2** | Mesh cleanup (trimesh repair) | ✅ shipped |
| **R6.3/R6.4** | Planar facet fitting → trimmed analytic faces | ✅ shipped |
| **R6.6** | Browser client (submit/poll + importStep) | ✅ shipped |
| **R6.4a** | **Cylinder spike (GATE) — ✅ shipped.** Deterministic cylinder fit (`app/primitives.py` — Gauss-map axis via face-normal SVD + Kåsa circle from vertices) + analytic 3-face solid (`app/curved_faces.py` — lateral + two circle caps sharing the exact rim circles) + region detection (`app/detect.py` — dominant normal-cluster axis). **Gate passes:** `is_solid` survives the analytic collapse (`test_cylinder.py`: watertight, free_edges=0, exact volume); a contrast test documents the crux (polygon caps → shell). | ✅ shipped |
| **R6.4b-i** | **✅ shipped** — sphere + cone deterministic fits + analytic solids (`primitives.py`/`curved_faces.py`); **auto single-primitive classification** wired into the pipeline (`detect.try_single_primitive`, default `method="auto"`) with shape gates (angular coverage / distinct normals) so a box isn't misread as a primitive. A whole-mesh cylinder/sphere/cone → its analytic solid; everything else → fitted/faceted. | ✅ shipped |
| **R6.4b-ii** | **✅ shipped (route a) — surface-of-revolution mixed parts.** `app/revolution.py`: section the mesh through the axis → ordered r≥0 profile → `BRepPrimAPI_MakeRevol` (shared circle edges created automatically); SELF-VALIDATED by volume match (rejects non-revolutions). Wired into `auto` (single-primitive → revolution → fitted). Handles stepped shafts, chamfered/capped cylinders — a stepped shaft → one analytic solid (5 faces), a box is rejected → fitted. | ✅ shipped |
| **R6.4b-iii/iv** | **✅ shipped (CSG booleans — holes + bosses)** — non-coaxial mixed parts via the InverseCSG paradigm (MIT): build primitive solids, combine with OCCT booleans (`BRepAlgoAPI_Cut`/`Fuse`) so the engine computes shared-edge topology — no fragile manual surface intersection. `app/csg.py`: box base (from the dominant planar faces, so a boss top doesn't inflate it) with cylindrical through-**holes** (`Cut`) and protruding **bosses** (`Fuse`), hole-vs-boss decided by wall-normal direction; bosses fused then holes cut; volume-self-validated; wired into `auto`. A box-with-hole → 7-face solid, a box-with-boss → 9-face solid (`test_csg.py`). Remaining future: non-axis-aligned bases, non-cylindrical features, nested/repeated CSG trees; faceted fallback keeps those valid. | ✅ shipped |
| **R6.5** | **✅ shipped (standalone builder)** — `app/freeform.py`: `freeform_face` (boundary loop as C0 edge constraints + interior point constraints → `BRepOffsetAPI_MakeFilling`) and `freeform_region_face` (a connected mesh region's outer loop + subsampled interior). Builds a smooth face approximating a curved patch (`test_freeform.py`). **Not wired into the fitted sewing path:** MakeFilling respects the boundary only within ~1e-4, below the 1e-6 sew gate, so it can't join a solid without per-region tolerance / the topology tail — it's a building block for that future work. Closed organic blobs keep the (valid) faceted solid. | ✅ shipped (standalone) |
| **R6.7** | **✅ shipped (client↔server E2E)** — `apps/plastiq/src/ai/reconstruct.integration.test.ts` (keyed on `RECONSTRUCT_URL`, skips in CI) drives the REAL browser client (`reconstructMesh`) over real HTTP against a running pythonOCC service with real GLB fixtures: a cylinder → `cylinder` solid, a stepped shaft → `revolution` solid, both valid STEP wrapping into an `importStep` CadDocument. Verified live this session. The existing live-OCCT pytest (38) covers the server. Remaining: the browser Playwright reconstruction E2E (app UI → service → rendered part). | ✅ shipped (browser E2E pending) |
| **R6.8** | Deploy (Railway/Docker, prebuilt image) | deferred (D-6) |

**Exit criteria:** a watertight analytic STEP **solid** for a representative mechanical mesh
(box-with-hole / bracket / cylinder), verified by closure checks; the cylinder spike gate passes;
real E2E green locally; faceted fallback keeps organic meshes valid (if not compact); zero regressions
in the existing 16 pytest + the plastiq suite.

## 9. Risks

| # | Risk | Mitigation |
|---|---|---|
| R-1 | **Topology tail (shared edges)** is the make-or-break; tangential/organic joins can't be intersected. | Cylinder spike gate first (R6.4a); sharp=intersect, tangent=snap polyline; faceted fallback (FR-8). |
| R-2 | **Point2CAD non-determinism + heavy deps** (torch/INR) conflict with NFR-2 and image size. | Seed-pin all RNG; prefer shipped deterministic planar path; keep INR freeform optional behind fallback; image weight is a deploy concern (deferred D-6). |
| R-3 | **Organic meshes reconstruct poorly** (no primitives, tangential joins). | Honest caveat (NFR-4); faceted/freeform fallback; mechanical meshes are the sweet spot (mirrors Fusion's tiered behavior). |
| R-4 | `MakeSolid` doesn't validate closure → silent shells. | Explicit closure verification (FR-7). |
| R-5 | p-curve / periodic-seam bugs produce wrong faces. | p-curve construction + largest-gap seam rule + ShapeFix (§4.3); per-face validity checks. |

## 10. Out of scope (v1)
- Deploy / hosting (R6.8 deferred, D-6).
- Assemblies / multi-solid reconstruction from one mesh.
- Editable parametric *feature tree* recovery (we emit an `importStep` base body, not a feature history).
- Torus / general swept-surface primitives (cylinder/sphere/cone + freeform only in v1).

## 11. References
- Report-Final.md + Agent{1..4}Findings.md (this session); investigation 2026-06-20.
- Point2CAD arXiv 2312.04962 (Apache-2.0). Eberly "Least Squares Fitting…"; Lukács/Marshall/Martin
  (Springer BFb0055697). CGAL Shape_detection + cgal-swig issue #150 (no Python RG). OCCT refs:
  BRepBuilderAPI_Sewing/MakeFace/MakeEdge, ShapeFix_*, ShapeAnalysis_FreeBounds, GeomAPI_IntSS,
  BRepAlgoAPI_Section, BRepOffsetAPI_MakeFilling, GeomPlate_*, ElSLib, breplib BuildCurves3d/SameParameter.
