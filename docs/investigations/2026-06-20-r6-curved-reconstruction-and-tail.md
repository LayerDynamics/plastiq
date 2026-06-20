# Investigation — R6.4-curved/R6.5 reconstruction, R6.7/R6.8, and the SPEC-6 tail

**Date:** 2026-06-20 · **Method:** deep-code-investigation (code + `ref/**` + web research, all verified)
**Question:** the *right* technical solution for the remaining reconstruction milestones + SPEC-6 tail.

---

## 1. Executive summary

The `services/reconstruct` backend already does clean **planar** reconstruction (facets →
trimmed planar faces); the gap is **curved** surfaces (cylinder/sphere/cone) and **freeform**
regions, which still arrive faceted. The right approach is **normal-based (Gauss-map) region
classification + algebraic least-squares fitting in numpy**, feeding OCCT analytic faces
built by **UV bounds** — NOT pyRANSAC-3D (its cylinder fit is unreliable by its own docs)
and NOT CGAL Efficient-RANSAC (its Shape_detection is C++-only; not in the Python SWIG
bindings). All required OCCT constructors (cylinder/sphere/cone trimmed faces, BSpline,
MakeFilling) are verified working in our conda env. The SPEC-6 tail is small, well-scoped UI
+ test wiring on top of code that already exists.

## 1a. Live verification addendum (2026-06-20)

Run against the actual environment, not assumed:
- **OCCT analytic + freeform constructors all build valid faces** in our conda env (cylinder/
  sphere/cone by UV bounds; `GeomAPI_PointsToBSplineSurface`; `BRepOffsetAPI_MakeFilling`;
  `GeomPlate`). So once detection gives params, face construction is solid.
- **Real model-in-the-loop E2E is feasible NOW.** Local Ollama is up with two tool-capable
  models. `qwen3.6:35b` returned a **valid** `build_part` document for "make a 20mm cube"
  (`{features:[{id:"f1",type:"box",params:{dx:20,dy:20,dz:20}}],params:{}}`); `lfm2.5:8.5B`
  tool-calls but emits a weak doc → **use qwen3.6 (≥14B) for the E2E**. A gated Ollama
  integration test already exists (`openaiCompatible.integration.test.ts:34`).
- **Deploy (R6.8) descoped per user — local-only.** The Dockerfile/env stay for later; no
  Railway work now. R6.7 targets a locally-running service.
- **E2E are required (user):** the model-in-the-loop run (Ollama) is the *true* E2E; the
  deterministic-pipeline browser test is additional (CI-safe), never a substitute.

## 2. Current pipeline (execution trace + extension point)

```
POST /reconstruct (app/main.py:55) → JobStore.submit (app/jobs.py:33)
  → reconstruct() (app/pipeline.py:40)
     → load_mesh (app/meshio.py:18)              GLB bytes → (vertices, faces)
     → clean_mesh (app/cleanup.py:22)            weld/repair/winding/normals/fill (R6.2)
     → fitted_shape (app/fitted.py:72)           DEFAULT (method="fitted")
        → planar_segments (app/segment.py:15)    → (mesh, facets, leftover)
        → per facet: _planar_face_from_loop      coplanar region → 1 trimmed planar face
        → _add_triangles(leftover) (fitted.py:96) ← **CURVED REGIONS DIE HERE (faceted)**
        → BRepBuilderAPI_Sewing → shell/solid
     → shape_to_step (app/occ_step.py:21)        STEP text (matches packages/cad/src/io/index.ts:20)
GET /jobs/{id}/result (app/main.py:80) → { step, report }
```

**The extension point is `fitted.py:96`**: `leftover` (triangles in no planar facet) is exactly
the curved-surface input. Today it's faceted; R6.4-curved/R6.5 replace that branch with
primitive/freeform fitting before the faceted fallback.

Client side (R6.6, shipped): `apps/plastiq/src/ai/reconstruct.ts` `reconstructMesh` (submit/
poll) + `stepToImportDocument` → kernel `importStep` feature (`worker/rebuild.ts:430`,
`data.step`) → editable `CadDocument`. Wired in `GenerationPanel.tsx` `MeshConvertSection`.

## 3. `ref/**` finding

`ref/` contains **only `ref/CADAM`** — a TypeScript/React OpenSCAD text-to-CAD app. It has
**no mesh→B-rep reconstruction tech** (a generation app, not a reconstruction one). Not useful
for the algorithm choice. (Verified: no ransac/fit/surface/nurbs/bspline source under `ref/`.)

## 4. External research (verified)

**Deciding criterion = determinism (NFR-2).** Plastiq's whole pipeline is reproducible
(time/RNG-free document path). RANSAC is *randomized* → non-deterministic output → the same
mesh could reconstruct to a different STEP each run. That single fact rejects **both** RANSAC
libraries below, independent of language bindings, and is the verified reason (not the
CGAL-bindings question, which I did not confirm).

| Option | Primitives | Deterministic? | Verdict |
|---|---|---|---|
| **CGAL Efficient-RANSAC** (Schnabel) | plane/sphere/cyl/cone/torus | **No (randomized)** | gold-standard quality, but non-deterministic ⇒ rejected on NFR-2 (its Python-binding availability is therefore moot and left unverified). |
| **pyRANSAC-3D** (pip, numpy) | plane/sphere/cyl/cuboid… | **No (randomized)** + cylinder unreliable per its own docs | rejected on NFR-2 *and* quality. |
| **Open3D** | plane only (`segment_plane`, RANSAC) | No | we already do planes via facets ⇒ adds nothing. |
| **Normal-based (Gauss map) + numpy SVD/lstsq** | plane/cyl/cone/sphere | **Yes (SVD + least-squares, fixed traversal order)** | **recommended** — deterministic, dependency-light, uses our normals + adjacency. |

OCCT constructors — **all verified building valid faces in our env**:
- `BRepBuilderAPI_MakeFace(gp_Cylinder|gp_Sphere|gp_Cone, umin,umax,vmin,vmax)` → trimmed
  analytic face by **UV bounds** (sidesteps the p-curve requirement for non-planar wires).
- `GeomAPI_PointsToBSplineSurface(Array2OfPnt, …)` → BSpline face — **needs a structured grid**.
- `BRepOffsetAPI_MakeFilling` / `GeomPlate_BuildPlateSurface` → freeform from boundary +
  scattered interior constraints (**no grid needed**) — the right tool for irregular regions.

## 5. Recommended solution

### Workstream 1 — R6.4-curved + R6.5 (the research-grade core)

> **⚠ The decisive constraint — shared edges, or you regress solids to shells.** The planar
> pipeline produces *solids* only because adjacent faces share byte-identical mesh-vertex
> boundary loops, so `Sewing` at 1e-6 merges them. An analytic face built by UV-bbox passes
> through the *ideal* smooth boundary, **not** the mesh vertices — so its rim no longer
> coincides with its faceted/planar neighbors and sewing leaves free edges → **shell, not
> solid**. Concrete: collapsing the cylinder's 24 side quads into one cylindrical face gives a
> smooth top rim while the cap stays a 24-gon; they deviate by the sagitta
> r·(1−cos(π/24)) ≈ 8.6e-5 m at r=10mm — ~86× the 1e-6 sew tolerance, so they will **not**
> sew. The naive "collapse + sew-by-tolerance" therefore *regresses*
> `test_cylinder_caps_and_side_quads` from solid to shell. Real reconstruction needs
> **consistent topology with shared edges**: when a region collapses to an analytic face,
> rebuild its *neighbors'* shared boundary to the same ideal edge (e.g. the cap becomes a
> circle-bounded face sharing the cylinder's rim edge), or raise the sew tolerance per-region
> to swallow the sagitta (cruder). **First implementation step: a single-cylinder mesh; assert
> `is_solid` SURVIVES the collapse.** If it drops to shell, shared-edge handling is required
> before any sphere/cone work. This is the crux that makes reconstruction hard, not the fitting.

**Detection: deterministic normal-based SEEDED REGION-GROWING + algebraic fitting (numpy).**
Not "one primitive per connected component" — a single component routinely spans several
primitives (cylinder → fillet → sphere) and would fit none. Seed from a triangle, grow while
the candidate-surface residual stays under tolerance, split when it doesn't (this growing/
splitting is the real work). On the Gauss map (unit normals): a **plane** is a point, a
**sphere** has normals through one center, a **cylinder** is a great circle (pole = axis), a
**cone** is a small circle. Fit (all deterministic):
- **Cylinder:** axis = smallest right-singular vector of mean-centered normals (SVD);
  project inliers to the plane ⊥ axis; Kåsa algebraic circle fit → center + radius. Accept if
  max point-to-surface residual < tol (e.g. cleanup deflection × k).
- **Sphere:** least-squares center = solve the linear system minimizing distance to all
  normal lines (or the algebraic |p|²+D·p+… fit); radius = mean ‖p−c‖.
- **Cone:** apex = least-squares intersection of normal planes; half-angle from the apex.
- Classify by trying cylinder/sphere/cone and picking the lowest-residual acceptable fit;
  else → freeform.

**Construction:** project the region's inliers to the fitted surface's (u,v); take the UV
bounding box; `BRepBuilderAPI_MakeFace(surface, umin,umax,vmin,vmax, tol)` → one analytic
trimmed face. (Verified working for cyl/sphere/cone.) Two UV-bbox gotchas to handle (or
document like the planar-hole fallback): **periodic-seam straddling** (a strip across the 0/2π
seam yields umin≈0,umax≈2π = the whole cylinder — detect the wrap and offset the parameter
range), and **non-rectangular UV regions** (an L-shaped/notched patch over-covers its bbox —
either accept for v1 or fall back to a wire-trimmed face / freeform).

**R6.5 freeform:** regions that fit no primitive AND are smooth → **`BRepOffsetAPI_MakeFilling`**
seeded with the region boundary edges + interior point constraints (no grid resampling).
Reserve `GeomAPI_PointsToBSplineSurface` for regions with a natural grid. Anything that still
fails → existing faceted fallback (never drop geometry — current `fitted.py:80` `_add_triangles`).

**Why this is "right" not "easy":** it reuses our reliable normals + adjacency, avoids the one
library whose cylinder is broken (pyRANSAC-3D) and the one with no Python path (CGAL), keeps the
honest fallback, and produces *exact* analytic OCCT surfaces (editable, compact STEP). Wire it
between `fitted.py:95` (facet loop) and `:96` (`leftover`): group leftover triangles into
connected components, try primitive→freeform→faceted per component. Report gains a
`curved_faces`/`bspline_faces` count. **Honest caveat stands:** organic blobs have no
primitives and irregular freeform → most still land in MakeFilling/faceted; mechanical meshes
win big.

### Workstream 2 — R6.7 (keyed integration test) + R6.8 (deploy)

- **R6.7 server↔real-OCCT** is already covered (16 pytest against live pythonOCC). The missing
  piece is a **client↔server HTTP round-trip**: a keyed vitest (`reconstruct.integration.test.ts`,
  skips without `RECONSTRUCT_URL`) that POSTs a real GLB to a running service and asserts a valid
  STEP comes back — mirrors `createMesh.integration.test.ts`'s opt-in/skip pattern. Optionally a
  pytest that boots uvicorn in a subprocess + a real cube GLB for a self-contained server E2E.
- **R6.8 deploy:** Railway, Docker source. Our conda image (miniforge + pythonOCC + open3d +
  trimesh + scipy) is ~2–3 GB — under Railway's ~4 GB limit but tight; **prebuild and push to a
  registry**, add a `/health` healthcheck (exists, `main.py:50`) and `PORT` env. Cloudflare
  Workers can't host this (native container, not a Worker). Set the app's `reconstructBaseURL`
  (`settings.ts`) to the deployed URL.

### Workstream 3 — SPEC-6 tail (small, well-scoped)

| Item | State (verified) | Approach / files |
|---|---|---|
| CommandPalette | absent | new `ai/CommandPalette.tsx` — a modal that focuses the same `GenerationPanel` run path; register a global shortcut in `app/App.tsx` (next to `useEditorShortcuts`). |
| `create_mesh` in-app | handler exists (`tools/createMesh.ts`), **not offered** (`buildAgentTools` only wires it when `createMesh` deps passed) | pass `createMesh` deps in `GenerationPanel.run` (confirm dialog state, `falMeshProviders` from settings, `fetchGlb`=fetch, `validateGlb`=importGltf, `persist`=projectsStore.create+open). |
| confirm dialog + route toggle | none | a confirm modal bound to `ConfirmPaidJob`; an image attach + `planAttachmentRoute` (already built, `ai/visionRoute.ts`) toggle in the panel. |
| conversation lifecycle | `aiStore.openConversation/deleteConversation` exist, **not called** | call from the app layer on `projectsStore.currentId` change + delete (keep persistence→ai dependency direction). |
| R5.2 deterministic pipeline test | no AI e2e specs; only `__plastiqBuild`+`__aiStore` seams | add a `__plastiqAi` seam exposing `buildAgentTools(realDeps)`; e2e drives the real handlers with fixed inputs (no model). **Label it "deterministic pipeline", not E2E** (model replaced — per spec honesty note). |
| R5.3 Ollama E2E | none | gated `e2e/plastiq/llm.spec.ts`, skips without a reachable Ollama; the only true model-in-the-loop E2E. |
| R5.4 docs | no AI section in root README | README "AI generation" + "mesh→CAD reconstruction" sections; in-product help (OLLAMA_ORIGINS, BYO-key, external-service disclosure); keep SPEC-6 synced. |

## 6. Boundaries

| From | To | Mechanism | Auth | Failure |
|---|---|---|---|---|
| browser `reconstruct.ts` | reconstruct service | HTTPS submit+poll | base URL (self-host) | HTTP/4xx/5xx detail surfaced; timeout after maxPolls; failed job → message |
| service | pythonOCC | in-proc (thread) | n/a | OCCT exceptions → job `failed`, no doc corruption |
| service STEP | kernel `importStep` | STEP text via `data.step` | n/a | invalid STEP → rebuild error on the offending feature |

## 7. Risks

- **Quality on organic meshes** is fundamentally limited (no primitives) — set expectations;
  MakeFilling/faceted fallback keeps it correct if not compact.
- **Image size** near Railway's limit → prebuild + registry; watch open3d's footprint.
- **Fitting tolerances** are the tuning surface; expose them in the report + as request params.
- **Non-determinism**: keep RANSAC-free (the normal-based fits are deterministic) so server
  output is reproducible (matches the project's NFR-2 spirit).

## 8. Open questions

- **Shared-edge strategy (the real design decision):** rebuild neighbor boundaries to the
  ideal shared edge (correct, more work) vs. per-region sew-tolerance widened to swallow the
  sagitta (cruder, faster). Decide on the single-cylinder spike before fanning out.
- Deploy target confirmation (Railway vs other). No GPU needed for OCCT reconstruction (only
  fal's image/3D-gen used GPUs).
- (Moot) CGAL Python bindings — not pursued; RANSAC is rejected on determinism regardless.
