# SPEC-7 — Mesh → B-rep (STEP) Reconstruction Service

**Status:** Draft (R6.1–R6.5 SHIPPED — planar + curved (cylinder/sphere/cone) + revolution + CSG +
freeform, all deterministic; R6.6/R6.7 client + E2E SHIPPED; R6.8 local-Docker only. The FR-6
surface-intersection topology tail for the analytic-rim sagitta case remains future work — see §1.2.)
**Date:** 2026-06-20 (reconciled 2026-06-21)
**Owner:** LayerDynamics
**Depends on:** SPEC-6 (AI generation — the creative path that produces mesh documents), `@plastiq/cad` (STEP I/O, `importStep`)
**Supersedes / relates to:** reverses two SPEC-6 decisions by explicit user direction — §13 "Mesh→B-rep reconstruction = out of scope" and the no-server identity (see memory `mesh-to-brep-server-decision`).
**Grounded in (this session, all verified):** `docs/research/2026-06-20-mesh-to-brep-reconstruction/Report-Final.md` + `Agent{1..4}Findings.md`; `docs/investigations/2026-06-20-r6-curved-reconstruction-and-tail.md`; the shipped `services/reconstruct/**` (verified against a live `pythonocc-core` conda env, **67 pytest passing** as of the 2026-06-21 reconciliation) and `apps/plastiq/src/ai/reconstruct.ts`.

---

## Revision history

- **2026-06-21 (r2, implementation reconciliation — verified against the shipped code):** The
  curved/freeform milestones (R6.4a/b, R6.5) shipped **fully deterministically** (numpy SVD/Kåsa/
  Eberly fits + OCCT analytic faces + OCCT booleans/`MakeRevol`), which is the approach the
  grounding investigation actually recommended. Four decisions/requirements are corrected here to
  match the code:
  (1) **Decision D-7 (vendor/fork Point2CAD) was NOT carried out and is superseded.** `services/
  reconstruct/vendor/` does not exist; there is no `torch`/INR/Point2CAD dependency. The
  deterministic path wins on NFR-2 and dependency weight, so Point2CAD is dropped, not deferred.
  §4.2/§4.4/R-2 below are annotated accordingly; D-9's "OWN vs REUSE" split collapses to **all-OWN**.
  (2) **NFR-2 seed-pinning is moot** — with no RANSAC/Point2CAD the pipeline is deterministic *by
  construction* (closed-form fits + fixed traversal), so no `PYTHONHASHSEED`/RNG-seed machinery is
  needed or present.
  (3) **FR-7's `ShapeFix_*` healing chain is not used.** Faces are built valid by construction and
  closure is verified (never assumed) via `BRepCheck_Analyzer.IsValid()` + `NbFreeEdges()==0` +
  `OrientClosedSolid` + positive-volume checks — the substance of FR-7.
  (4) **FR-11's default `method` is `"auto"`, not `"fitted"`** (single-primitive → revolution → CSG
  → cut-cylinder → fitted → faceted).
  Also: the **`report` now emits the full FR-9 face-type breakdown** (`curved_faces`, `faceted_faces`
  added alongside `planar_faces`/`freeform_faces`, plus a `primitive` tag) — §6 updated. The FR-6
  surface-intersection mechanism is now **partially built** (R6.9): `app/topology.py` adds the
  `GeomAPI_IntSS` shared-edge primitive + a `reconstruct_cut_cylinder` route (oblique-capped
  cylinders). **Still open:** the fully general per-region analytic reconstruction + the analytic-rim
  sagitta case; those regions stay faceted (FR-8). Shared edges otherwise come from OCCT booleans
  (CSG), `MakeRevol`, coincident boundaries, and now `topology.py`. Tracked in §8 (R6.9) and Risk R-1.
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
  analytic planar faces (`services/reconstruct/app/{meshio,cleanup,segment,faceted,fitted,occ_step,pipeline,jobs,main}.py`; covered by the live-OCCT pytest suite — 67 as of r2).
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
| D-7 | ~~**Vendor/fork Point2CAD (arXiv 2312.04962, Apache-2.0) for curved fitting + topology**~~ **SUPERSEDED (r2, 2026-06-21): NOT done.** The curved/freeform path shipped fully deterministically (numpy SVD/Kåsa/Eberly + OCCT); no Point2CAD/torch/INR was vendored. The deterministic approach wins on NFR-2 + dependency weight, so Point2CAD is dropped. (Original rationale, now historical: reuse Point2CAD's classical segment→fit→extend→intersect→trim tail; managed via §4.4/R-2/seed-pinning.) |
| D-8 | **Phased curved scope** | R6.4a cylinder spike (gate) → R6.4b sphere + cone → R6.5 freeform. De-risks the topology tail before fanning out. (Shipped — all deterministic.) |
| D-9 | **Reuse — own split** → **collapses to ALL-OWN (r2):** with Point2CAD dropped (D-7), the entire pipeline is ours — OCCT analytic-STEP export, the deterministic fits, and the shell→solid/heal tail on real `Geom_*` surfaces. (Nothing is vendored/reused.) |

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
- **FR-7** The result is assembled shell→solid (`BRepBuilderAPI_Sewing` → `BRepBuilderAPI_MakeSolid`
  → `OrientClosedSolid`) and **closure is verified, never assumed** (`NbFreeEdges()==0`,
  `BRepCheck_Analyzer.IsValid()`, positive volume). *(r2: the `ShapeFix_Face/Shell/Solid` healing
  chain is **not** used — analytic faces are built valid by construction; the verification above is
  what ships.)*
- **FR-8** Any region or join that fails fitting/topology falls back to faceted faces; the service
  always returns a valid B-rep STEP (D-5).
- **FR-9** The `report` exposes `{ triangles_in, triangles_used, faces_built, planar_faces,
  curved_faces, freeform_faces, faceted_faces, surface_deviation, fidelity_tol, tangent_regions,
  is_solid, is_valid, method, primitive? }` so the client/UX can show fidelity. *(r2: shipped — `curved_faces`/`faceted_faces`
  added; `method` ∈ `auto|fitted|faceted` with `primitive` ∈ `cylinder|sphere|cone|revolution|csg` when
  `auto` collapses the whole mesh. M1: `surface_deviation` (Scaled Chamfer Distance of the built B-rep
  vs the input mesh — a pose/scale-robust SURFACE fidelity score, ported Apache-2.0 from StepForge) +
  its advisory `fidelity_tol` added; report-only, complements the volume gate — see
  `docs/adr/0001-scd-fidelity-metric.md`.)*
- **FR-10** The browser client (`reconstruct.ts`, shipped) submits a mesh document's GLB, polls, and
  wraps the STEP as a `CadDocument` (`stepToImportDocument` → `importStep`) → an editable B-rep part.
- **FR-11** A `method` request param selects `auto` (**default** — single-primitive → revolution →
  CSG → cut-cylinder → fitted → faceted), `fitted` (planar facets → trimmed faces + freeform/faceted),
  or `faceted` (per-triangle baseline). *(r2: default is `auto`, not `fitted`.)* (Shipped in
  `pipeline.reconstruct`.)

## 4. Architecture

### 4.1 Pipeline (5 stages + cleanup)

```text
GLB bytes
  → meshio.load_mesh            (trimesh; scenes concatenated)            [shipped]
  → cleanup.clean_mesh          (weld/repair/winding/normals/fill)        [shipped R6.2]
  → DETECT / SEGMENT            whole-mesh primitive (Gauss map) OR        [shipped R6.4: deterministic,
                                planar facets (trimesh.facets) + leftover   numpy SVD — NO Point2CAD]
  → PER-REGION FIT              plane · cylinder/sphere/cone (Eberly) ·    [R6.4] · freeform MakeFilling [R6.5]
                                revolution (MakeRevol) · CSG (box±cyl) ·   [R6.4b] · cut-cylinder [R6.9]
  → EDGE RECOVERY               shared edges via OCCT booleans (CSG) /     [shipped for those topologies]
                                MakeRevol / coincident analytic+polyline /  [GeomAPI_IntSS cut-cylinder: shipped]
                                GeomAPI_IntSS (cut-cylinder)                [general per-region: OPEN, R6.9]
  → TRIM + SEW → SOLID          Sewing → MakeSolid → OrientClosedSolid +   [shipped]
                                verify (BRepCheck + NbFreeEdges + volume)
  → occ_step.shape_to_step      STEP text (AsIs, raw coords)              [shipped]
```

Stages are classical and **entirely OWN-ed in OCCT** (D-9 → all-OWN after D-7 was superseded). The
detection + fitting are deterministic numpy (no Point2CAD); shared-edge topology comes from OCCT
booleans / `MakeRevol` / coincident boundaries / `GeomAPI_IntSS` (the cut-cylinder route,
`topology.py`). The **general** per-region surface–surface-intersection tail (and `ShapeFix_*`
healing) is **not** built (R6.9, §8); `GeomAPI_IntSS` ships as the reusable primitive for it.

### 4.2 Modules (`services/reconstruct/app/`)
- Shipped: `meshio.py`, `cleanup.py`, `segment.py` (planar facets + `leftover`), `faceted.py`,
  `fitted.py` (planar trimmed faces + faceted fallback; **extension point: `fitted.py:96`**),
  `occ_step.py`, `pipeline.py`, `jobs.py`, `main.py`.
- New (shipped, all deterministic — r2): `detect.py` (deterministic Gauss-map classification +
  `try_single_primitive`; **no Point2CAD adapter** — D-7 superseded), `primitives.py` (closed-form
  Eberly fits → `gp_Cylinder/Sphere/Cone`), `curved_faces.py` (trimmed analytic faces by natural UV
  bounds + `classify_faces` report helper), `freeform.py` (`MakeFilling`), `revolution.py`
  (`BRepPrimAPI_MakeRevol` for stepped/mixed solids of revolution), `csg.py` (box ± cylinder via
  OCCT booleans — the shared-edge mechanism in lieu of manual surface intersection).
- `topology.py` (R6.9, **partially shipped**): the FR-6 surface–surface intersection primitive
  `shared_edge_by_intersection` (`GeomAPI_IntSS` → exact circle/ellipse/line shared edges) and
  `reconstruct_cut_cylinder`, a route for a cylinder trimmed by non-perpendicular / axis-parallel
  planes (an obliquely-capped cylinder) — a mixed analytic part `revolution`/`csg` can't fit. It
  fits the cylinder + cutting planes deterministically, confirms each plane crosses the cylinder via
  `GeomAPI_IntSS`, builds the solid with exact shared edges (the boolean engine), and self-validates
  by volume (faceted fallback otherwise). **Still open:** the fully general per-region analytic
  reconstruction with ideal trimmed rims (the analytic-rim sagitta case) — §8 (R6.9).
  Other shared-edge topology continues to come from OCCT booleans (`csg.py`), `MakeRevol`
  (`revolution.py`), and coincident analytic/mesh-polyline boundaries (`curved_faces.py`/`fitted.py`/
  `freeform.py`).

### 4.3 Face construction (verified APIs)
> **r2 (what actually shipped):** analytic faces are built by **natural UV bounds**
> (`BRepBuilderAPI_MakeFace(gp_Cylinder|Sphere|Cone, umin,umax,vmin,vmax)`; sphere/cone via
> `BRepPrimAPI_MakeSphere/MakeCone`), which sidesteps the p-curve/`ShapeFix` requirement below — see
> `app/curved_faces.py`. The p-curve + `ShapeFix_Face` route documented next was the researched
> alternative; it is **not** used by the shipped deterministic path.
- Trimmed analytic faces (alternative, not shipped): build a wire of edges carrying **p-curves**
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

### 4.4 ~~Point2CAD integration (D-7)~~ — NOT adopted (r2, 2026-06-21)
**This section is historical.** Point2CAD was never vendored (no `services/reconstruct/vendor/`,
no `torch`/INR). The curved/freeform path is fully deterministic and entirely OWN-ed (D-9 →
all-OWN), so the determinism-reconciliation burden this section described (seed-pinning a randomized
dependency) does not arise — the pipeline is reproducible by construction (NFR-2). Kept for the
decision trail. *(Original plan: vendor/fork the Point2CAD repo under `…/vendor/point2cad/`
(Apache-2.0), reuse its segmentation + primitive/freeform fits, seed-pin all RNG, keep its STEP
output out and own the OCCT analytic-STEP tail.)*

## 5. Non-functional requirements

- **NFR-1 (no data loss):** every input mesh yields a valid B-rep STEP; unfittable regions/joins
  fall back to faceted (FR-8). Verified by closure checks (FR-7).
- **NFR-2 (reproducibility):** the same mesh + same code → the same STEP. **(r2: fully achieved.)**
  With Point2CAD dropped (D-7 superseded), the entire path is deterministic *by construction* —
  closed-form fits (SVD/Kåsa/Eberly) + fixed traversal order, no RANSAC/RNG — so no seed-pinning is
  needed (the "accepted weakening" the r1 text described no longer applies).
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
           is_solid, is_valid, method, primitive? }
# r2: curved_faces + faceted_faces now emitted; `primitive` tags the auto-method hit
# ("cylinder"|"sphere"|"cone"|"revolution"|"csg"). curved_faces are classified from the
# built shape's OCCT surface types (app/curved_faces.py classify_faces).
```
Client (`apps/plastiq/src/ai/reconstruct.ts`): `reconstructMesh(glbBase64, { baseURL })` →
`{ step, report }`; `stepToImportDocument(step)` → `CadDocument { features:[{type:"importStep",
data:{ step }}], params:{} }`.

## 7. Boundaries & failure modes

| From | To | Mechanism | Failure handling |
|---|---|---|---|
| browser `reconstruct.ts` | service | HTTPS submit+poll (base URL, self-host) | HTTP/4xx/5xx detail surfaced; timeout after maxPolls; failed job → message |
| service | pythonOCC (deterministic numpy fits; no Point2CAD) | in-proc (thread via `asyncio.to_thread`) | OCCT/fit exceptions → job `failed`, no partial STEP; region failure → faceted fallback |
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
| **R6.4b-ii** | **✅ shipped (route a) — surface-of-revolution mixed parts.** `app/revolution.py`: section the mesh through the axis → ordered r≥0 profile → `BRepPrimAPI_MakeRevol` (shared circle edges created automatically); SELF-VALIDATED by volume match (rejects non-revolutions). Wired into `auto` (after single-primitive; full chain now single-primitive → revolution → CSG → cut-cylinder → fitted). Handles stepped shafts, chamfered/capped cylinders — a stepped shaft → one analytic solid (5 faces), a box is rejected → fitted. | ✅ shipped |
| **R6.4b-iii/iv** | **✅ shipped (CSG booleans — holes + bosses)** — non-coaxial mixed parts via the InverseCSG paradigm (MIT): build primitive solids, combine with OCCT booleans (`BRepAlgoAPI_Cut`/`Fuse`) so the engine computes shared-edge topology — no fragile manual surface intersection. `app/csg.py`: box base (from the dominant planar faces, so a boss top doesn't inflate it) with cylindrical through-**holes** (`Cut`) and protruding **bosses** (`Fuse`), hole-vs-boss decided by wall-normal direction; bosses fused then holes cut; volume-self-validated; wired into `auto`. A box-with-hole → 7-face solid, a box-with-boss → 9-face solid (`test_csg.py`). The base box may be axis-aligned **or arbitrarily rotated** — an oriented frame is derived from the part's own dominant planar-face normals (`_oriented_frame`), so a 33°-rotated box-with-hole reconstructs to a volume-matching `csg` solid — and **multiple features** are supported (e.g. a box with two through-holes). Remaining future: non-cylindrical features, nested/repeated CSG trees; faceted fallback keeps those valid. | ✅ shipped |
| **R6.5** | **✅ shipped — builders + pipeline integration** — `app/freeform.py`: `freeform_face` + `freeform_region_face` build a smooth face (`BRepOffsetAPI_MakeFilling`) from a region's boundary loop + interior constraints; the interior uses a count **ladder** (richest first, step down on a MakeFilling failure) — on a sphere cap ~2.6 mm error at the old fixed 10 points → ~0.35 mm. `freeform_capped_solid` proves a freeform face joins a watertight solid when boundaries coincide (sews at 1e-6 → `MakeSolid` → `OrientClosedSolid`). **WIRED into `fitted` (and so `auto`):** `fitted_shape` now collapses each connected non-planar region that has a single boundary loop into ONE freeform face (sharing the same mesh-polyline boundary as its planar/faceted neighbours), guarded by a per-region accuracy gate **and** a post-assembly volume check that rebuilds faceted-only if freeform breaks closure/volume. A domed box → 5 planar + freeform-capped solid (`report.freeform_faces>0`, valid, ~10× fewer faces than faceted; `test_freeform.py`). **Honest remaining limits:** a CLOSED region (no boundary loop — e.g. a whole organic blob) can't be one filled patch → stays faceted (a fundamental limit of single-patch filling, not a bug); and the **analytic-rim sagitta case** (a smooth fitted *arc* replacing a faceted polyline neighbour, deviating ≫ the sew gate — §D-3) still needs the surface-intersection tail. Nothing is dropped. | ✅ shipped |
| **R6.7** | **✅ shipped — integration + browser E2E.** (a) `apps/plastiq/src/ai/reconstruct.integration.test.ts` (keyed `RECONSTRUCT_URL`): real client → HTTP → live service → STEP (cylinder→`cylinder`, stepped shaft→`revolution`). (b) `e2e/plastiq/reconstruct.spec.ts`: full browser E2E — open a mesh doc → "Convert to CAD" → service → STEP → kernel `importStep` (real OCCT) → rendered B-rep part (faceCount>0), verified live; skips when the service is unreachable. (c) Service CORS added (`main.py`) so the browser can call it cross-origin. Server covered by **67 live-OCCT pytest** (r2). | ✅ shipped |
| **R6.8** | **✅ local Docker verified** — `docker build` + `docker run` → `/health` ok + a real GLB reconstructs end-to-end through the container (cylinder→`cylinder`, solid). Image ≈4.7 GB (exceeds the ~4 GB hosted cap → needs slimming before a hosted deploy). Hosted deploy still deferred (D-6); local Docker is the supported mode. | ✅ local-only |
| **R6.9** | **🟡 PARTIAL — the FR-6 surface-intersection tail.** ✅ Shipped (`app/topology.py`, `test_topology.py`, 7 live-OCCT pytest): the `GeomAPI_IntSS` shared-edge **primitive** (`shared_edge_by_intersection` → exact circle/ellipse/line junctions, the FR-6 "intersect adjacent surfaces" mechanism that previously appeared nowhere) and `reconstruct_cut_cylinder`, an `auto` route for a cylinder trimmed by non-perpendicular / axis-parallel planes (oblique-capped cylinder) — a mixed analytic part the `revolution`/`csg` routes can't fit — built with exact shared edges and volume-self-validated (faceted fallback otherwise). ⏳ **Still open:** the fully general per-region analytic reconstruction (arbitrary fitted curved faces with ideal trimmed rims) and the **analytic-rim sagitta case** (a smooth fitted arc replacing a faceted-polyline neighbour, deviating ≫ the 1e-6 sew gate — §D-3). Those regions stay faceted (FR-8 fallback, nothing dropped); the `GeomAPI_IntSS` primitive is the reusable foundation for them. | 🟡 partial |

**Exit criteria:** a watertight analytic STEP **solid** for a representative mechanical mesh
(box-with-hole / bracket / cylinder), verified by closure checks; the cylinder spike gate passes;
real E2E green locally; faceted fallback keeps organic meshes valid (if not compact); zero regressions
in the existing pytest suite (67 as of r2) + the plastiq suite.

## 9. Risks

| # | Risk | Mitigation |
|---|---|---|
| R-1 | **Topology tail (shared edges)** is the make-or-break; tangential/organic joins can't be intersected. | Cylinder spike gate first (R6.4a); sharp=intersect, tangent=snap polyline; faceted fallback (FR-8). |
| R-2 | ~~**Point2CAD non-determinism + heavy deps** (torch/INR) conflict with NFR-2 and image size.~~ **RESOLVED (r2): Point2CAD dropped (D-7 superseded)** — the deterministic numpy path carries the whole curved/freeform scope, so this risk no longer exists (no torch/INR, no RNG, smaller image). |
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
