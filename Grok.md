# Grok.md — Deep Code Analysis: Plastiq CAD + ML (working tree)

**Date:** 2026-07-16  
**Branch:** `code-review-fixes` (working tree at analysis time)  
**Method:** Full read of production modules under `apps/plastiq`, `packages/{cad,sim,capture,nerf,nurbs,photogrammetry,recon,recm,ml}`, and all five `services/*`, plus bring-up (`scripts/dev-services.sh`). Claims are verified at `path` / symbol; prior audit checklists are re-checked against **this** tree, not treated as truth.  
**Product rule applied:** **local services never use API keys.** Optional Bearer keys if an env var is set are a deployment option, not a completeness gap and not a user setup step for local studio.

---

## 1. Product thesis

**Plastiq** is two product surfaces sharing one canvas:

1. **Parametric solid modeling** — The user authors a feature tree (sketch profiles → extrude/cut/revolve/loft/sweep/dress-ups/booleans/patterns). A web worker rebuilds the tree with **Open CASCADE WASM** (`@plastiq/cad`) into a solid that is tessellated and shown in a Three.js viewport. Assembly mates lower into `@plastiq/sim`. This is the marquee “CAD studio” path.

2. **Scan / generative → editable CAD** — Unposed photos, oriented point clouds, or triangle meshes enter via the AI/canvas panel and local **HTTP services** on ports 8000–8004. The output is a mesh and/or STEP that imports into the same document model. Services are separate processes (Python + MLX/OCCT), not in-process libraries.

**What the product is *not*:** a single monorepo of equal maturity. The **kernel** is largely complete. The **authoring UI** and **long-job UX** still mix real selection flows with **demo injectors** and **abort-only cancel**. Prior “T01–T40 complete” claims overstated product readiness where only rebuild APIs or unit tests existed.

---

## 2. How the marquee paths work

### 2.1 Parametric path (sketch → solid → viewport)

```
User action (ribbon / context menu / AI tools)
  → apps/plastiq store (features[], placement, sketches)
  → geometry worker: rebuildDocument(oc, document)
  → packages/cad actions (extrude, revolve, loft, sweep, fillet, boolean, …)
  → OCCT solid → tessellateTagged → Part mesh in Three.js viewport
```

| Layer | Role | Where |
|-------|------|--------|
| Document model | `CadDocument` features + params; default seed is a box | `apps/plastiq/src/store/types.ts`, `seed.ts` |
| Sketcher | Draw → planegcs solve → `extractProfile` → feature with `model`/`profile`/`plane` | `sketch/*`, `editFeature.ts` |
| Rebuild | Single solid accumulator; feature switch evaluates OCCT ops | `apps/plastiq/src/worker/rebuild.ts` |
| Kernel | OCCT WASM wrappers, STEP I/O, tagged mesh | `packages/cad` |
| Selection dress-ups | Edge/Face picks → persistent refs → rebuild re-resolves | `viewport/dressup.ts`, `three/contextmenu/config.ts` |
| Desktop shell | Tauri host of the same web app | `apps/desktop` |

**Join policy (extrude / revolve):** When a solid already exists and `data.op !== "new"`, rebuild **unions** the new pad/revolve onto the body (`rebuild.ts` extrude ~281–310, revolve ~343–356). Explicit `op: "new"` replaces. Context/ribbon extrude typically sets `op: "join"`.

**Loft / sweep:** Always `replace(...)` — prior solid is destroyed (`rebuild.ts` loft ~394, sweep ~446). No join option.

**Transform feature:** Comment claims “rotate then translate”; code **translates first**, then rotates about **world origin** `[0,0,0]` (`rebuild.ts` ~580–595). Ribbon “Move body” opens the **placement gizmo** (scene pose), not a transform feature (`registry.ts` transform id).

**Holes:** Loop sketches can carry `profile.holes` (non-construction circles). Rebuild cuts them only on **extrude** and **cut** via `cutProfileHoles` — not revolve/loft/sweep. Containment is not tested (`profile.ts` interior circles).

### 2.2 Capture / ML path (photos / cloud / mesh → CAD)

```
Photos ──:8004 photogrammetry──► transforms.json + sparse/dense PLY
                                  │                    │
                                  ▼                    ▼
                               :8002 nerf          :8001 capture
                            (posed images→mesh)   (oriented cloud→mesh)
                                  │                    │
                                  └────────┬───────────┘
                                           ▼
                                    MeshDoc in app
                                           │
                    ┌──────────────────────┼──────────────────────┐
                    ▼                      ▼                      ▼
              :8000 reconstruct      :8003 nurbs fit         (optional)
              mesh→STEP B-rep        freeform patches
                    │                      │
                    └──────────┬───────────┘
                               ▼
                     importStep → CadDocument
```

| Port | Service | Job |
|------|---------|-----|
| 8000 | reconstruct | Mesh GLB → STEP B-rep (`auto` analytic chain + fitted/faceted) |
| 8001 | capture | Oriented cloud → mesh; partial scan `/complete` |
| 8002 | nerf | Posed photos → NeuS/NeRF surface mesh |
| 8003 | nurbs | Mesh regions → B-spline STEP (open + closed cube-map) |
| 8004 | photogrammetry | Unposed photos → poses + PLYs |

Bring-up: `scripts/dev-services.sh` starts all five; for reconstruct it exports  
`RECONSTRUCT_NURBS_URL=http://127.0.0.1:8003` so freeform/closed organic can delegate to NURBS.

Browser clients: `@plastiq/{capture,nerf,nurbs,photogrammetry,recon}` under `packages/*`. App wrappers in `apps/plastiq/src/ai/{capture,nerf,nurbs,photogrammetry,reconstruct}.ts`. Panel: `GenerationPanel.tsx`. Agent tools: `ai/tools/*` including `cloud_to_mesh` / `complete_scan`.

**Local auth:** Services may implement optional `*_API_KEY`. Product rule: **local studio does not require or productize keys.** Open-by-default when env unset is correct.

### 2.3 Reconstruct `auto` chain (how mesh becomes B-rep)

Order in `services/reconstruct/app/pipeline.py`:

1. **single_primitive** — whole mesh is cylinder / sphere / cone  
2. **cut_sphere** — sphere ∩ plane (hemisphere / spherical cap) — `topology.reconstruct_cut_sphere`  
3. **revolution** — solid of revolution  
4. **csg** — box ± cylinders  
5. **cut_cylinder** — cylinder ∩ planes (oblique caps)  
6. **fitted** — planar facets + freeform; if `RECONSTRUCT_NURBS_URL` and whole mesh is closed genus-0 non-planar, try `delegate_closed_solid` first (`fitted.py`)  
7. **faceted** — per-triangle baseline (never drops the job)

---

## 3. Package / service inventory (honest)

| Path | State |
|------|--------|
| `packages/cad` | Production kernel (actions, sketch, mesh, I/O, assembly lower) |
| `packages/sim` | Production physics backends (Rapier/Cannon/Ammo/MuJoCo) |
| `packages/capture`, `nerf`, `nurbs`, `photogrammetry`, `recon` | Real submit→poll clients |
| `packages/recm` | Radial context-menu UI package (used by app) |
| `packages/ml` | **Empty** — README only; no `submitPollJob` implementation |
| `packages/data`, `segment`, `rl`, `embed` | Scaffold / empty — not product surface |
| `services/*` (five) | Real FastAPI services with pytest |
| `apps/plastiq` | Product editor + AI panel |
| `apps/desktop` | Tauri shell |

`@plastiq/recon` is real (`packages/recon/src/client.ts`); app re-exports it from `apps/plastiq/src/ai/reconstruct.ts`.

---

## 4. CAD evaluation — intended vs actual

For each gap: **how it fails for the user**, **how the code behaves now**, **how it should work**.

### C1 — Extrude join-by-default

| | |
|--|--|
| **Fails** | Second pad used to destroy the body (historical). Partially fixed. |
| **Now** | Rebuild joins unless `op === "new"`. Properties can set join/new. UI often sets `op: "join"`. |
| **Should** | First solid on empty doc = new body; subsequent pads join unless user chooses new body. Seed box + join still confuses sketch-to-solid E2E (face counts). |

### C2 — Revolve join + axis-from-edge

| | |
|--|--|
| **Fails** | World-Y revolve by default can miss intent; axis edge was missing. |
| **Now** | Join parity with extrude; `data.axisEdge` → `resolveEdgeAxis`. Context “revolve about edge” exists. Default ribbon revolve still world-Y if no edge. |
| **Should** | Selection-required axis or clear default; Properties rebind of axis edge. |

### C3 — Sketch binding via deps

| | |
|--|--|
| **Fails** | Last sketch wins; user cannot re-point a feature. |
| **Now** | `sketchForFeature` uses `deps` / `sketchId` / last sketch. Create paths set `lastSketchDeps()`. Properties has **no** deps rebind UI. |
| **Should** | Properties sketch picker; re-pick after multi-sketch workflows. |

### C4 — Loft / sweep authoring

| | |
|--|--|
| **Fails** | User clicks Loft/Sweep expecting their sketches/path; gets **demo frustum/pipe** or silent last-two-sketches / hardcoded path; **prior body vanishes** (replace). |
| **Now** | Kernel loft/sweep real. Ribbon: last ≥2 sketches or demo loft; last sketch + **hardcoded polyline** or demo sweep (`registry.ts` loft/sweep). Rebuild always `replace`. |
| **Should** | Multi-section pick + path pick; join-by-default; **remove demo injectors** from product ribbon. |

### C5 — Boolean authoring

| | |
|--|--|
| **Fails** | “Subtract” punches a fixed rectangle/box, not the second body the user meant. |
| **Now** | Rebuild supports `toolFeatures` recursive rebuild. Ribbon `booleanBody` uses `DEFAULT_RECT` tool; “Demo boolean (box)” is explicit demo. |
| **Should** | Select tool body/feature; remove demo as primary. |

### C6 — Mirror / pattern

| | |
|--|--|
| **Fails** | Instant wrong plane/axis; patterns whole part; no feature-scope UI. |
| **Now** | Hardcoded ribbon params. Rebuild linear pattern can use `toolFeatures`; circular has no toolFeatures branch. |
| **Should** | Face plane, edge direction, count/spacing UI; circular feature-scope parity. |

### C7 — Transform

| | |
|--|--|
| **Fails** | Move does not bake intended R-then-T about body COM; feature transform is wrong; gizmo only changes placement. |
| **Now** | Feature: translate then rotate about origin. Placement gizmo separate. `demo-transform` injects `tx: 0.02`. |
| **Should** | One clear model (placement vs feature); feature = rotate about COM/pivot then translate; delete demo. |

### C8 — Variable fillet / two-distance chamfer

| | |
|--|--|
| **Fails** | User cannot author variable fillet or asymmetric chamfer from UI. |
| **Now** | Kernel + rebuild read `radius2` / `distance2`+face. UI only constant radius/distance. AI schema single value. |
| **Should** | Properties + create UI + schema + units. |

### C9 — Profile holes quality

| | |
|--|--|
| **Fails** | Exterior circles become “holes”; revolve ignores holes. |
| **Now** | Any non-construction circle on a loop sketch is a hole; cut only on extrude/cut. |
| **Should** | Point-in-outer-loop; support or clear error on revolve. |

### C10 — Properties / gizmo secondaries

| | |
|--|--|
| **Fails** | Most feature `data` is uneditable; secondary gizmo params dead. |
| **Now** | Properties: numerics + op/shell/sweep mode-transition. Ref counts read-only. `FEATURE_SECONDARY_PARAMS` defined, not fully wired into gizmo UI. |
| **Should** | Full data surface + gizmo secondaries. |

### C11 — AI prompt contradicts join

| | |
|--|--|
| **Fails** | Agent teaches replace-body extrude and unnecessary booleans for bosses. |
| **Now** | `apps/plastiq/src/ai/prompt.ts` still says extrude/revolve **REPLACE** and bosses need boolean union (~40–44). Rebuild joins. |
| **Should** | Prompt = join-by-default; toFace encouraged when known; align with schema. |

### What CAD already does well

- Selection dress-ups (fillet, chamfer, shell, draft, to-face, along-edge) are real pick→ref→rebuild.  
- Sketch → extrude/cut/revolve consumer Finish is a real authoring loop.  
- Join-by-default for extrude/revolve is real and tested in `rebuild.test.ts`.  
- Kernel coverage under `packages/cad/src/action/*` is dense and production-grade.

---

## 5. ML evaluation — intended vs actual

### M1 — `RECONSTRUCT_NURBS_URL` in dev-services

| | |
|--|--|
| **Fails** | Without URL, freeform/organic stays MakeFilling/faceted. |
| **Now** | `scripts/dev-services.sh` exports URL for reconstruct when fleet starts. Manual uvicorn without env still offline. |
| **Should** | Document both paths; fleet default is correct. |

### M2 — Complete-scan demo weights honesty

| | |
|--|--|
| **Fails** | Main panel “Complete scan” can look like real completion with synthetic weights. |
| **Now** | Server sets `demo_weights`; client maps `demoWeights`; agent + `cloudActions` surface it. **GenerationPanel CaptureScanSection** opens mesh and clears status without reading the flag. |
| **Should** | Panel refuses or banners demo; separate “Demo complete” or require checkpoint. |

### M3 — NeRF production quality defaults

| | |
|--|--|
| **Fails** | Hard scenes still lag research stacks. |
| **Now** | For `neus`: `learnable_beta=True`, grad clip, warmup, white bg, `importance_samples=32` hierarchical PDF (`engine/pipeline.py`). **WeightNorm** exists but **default off** and not pipeline-wired (`sdf_field.py`). **ProposalSampler** is a helper name for uniform+PDF; **not** a separate proposal MLP; training path uses hierarchical PDF, not the class in production model code. |
| **Should** | Honest docs: hierarchical PDF ≠ ProposalNetwork; WN on only when tests stable; don’t claim “full sdfstudio parity.” |

### M4 — Cancel across services

| Service | Server | Client `cancelJob` | Client `onJob` | Panel Cancel |
|---------|--------|--------------------|----------------|--------------|
| capture | **Process kill** on cancel (`jobs.py` cancel + `submit_process`) | yes | **no** | **Abort only** |
| nerf | Drop record (thread work may continue) | yes | yes | Abort + DELETE |
| photogrammetry | Drop record | yes | yes | Abort + DELETE |
| reconstruct | Drop record only | **no** | **no** | Abort only |
| nurbs | Drop record | **no** | **no** | Abort only |

| | |
|--|--|
| **Fails** | Capture Cancel looks like stop but never DELETEs — server **can** kill if DELETE is called, but panel never gets a job id. Recon/nurbs keep running after UI cancel. |
| **Now** | Capture server is the strongest cancel (force-kill spawn child). Client/panel lag. |
| **Should** | `onJob` on capture/recon/nurbs; panel DELETE like nerf; recon/nurbs process isolation if true resource free is required. |

### M5 — Agent cloud tools

| | |
|--|--|
| **Fails** | Agent cannot drive photo solve end-to-end as fully as cloud→mesh. |
| **Now** | `cloud_to_mesh` / `complete_scan` wired + unit-tested. No full photogrammetry agent tool suite. |
| **Should** | Photo + capture chain tools with real wiring tests. |

### M6 — `@plastiq/recon`

| | |
|--|--|
| **Fails** | N/A as “missing package” — it exists. |
| **Now** | Real package; missing cancel/onJob parity. |
| **Should** | Add cancel/onJob. |

### M7 — Topology FR-6 general case

| | |
|--|--|
| **Fails** | Arbitrary mixed curved regions still faceted; analytic-rim sagitta general case open. |
| **Now** | `cut_cylinder` + `cut_sphere` families real and in auto chain. Not general per-region analytic graph. |
| **Should** | Keep honest “family routes”; general FR-6 is long-horizon. |

### M8 — Closed organic NURBS via reconstruct

| | |
|--|--|
| **Fails** | Without live nurbs + URL, organic blob stays faceted. Concave shapes may chart-degrade to faceted solid. |
| **Now** | `delegate_closed_solid` + `fitted_shape` hook; nurbs `pipeline_closed` cube-map real; live open-region tests exist; closed path heavily unit/fake-HTTP tested. |
| **Should** | Live closed blob E2E when services up; surface `charting_degraded` in UI. |

### M9 — Photogrammetry dual resolution

| | |
|--|--|
| **Fails** | Full-res sparse can collapse registration (pixel-absolute thresholds). |
| **Now** | Server `sparse_max_dim` + dense full frames; client `sparseMaxDim`. **App never passes it.** Default `None` = native both stages. |
| **Should** | Panel default ~640–1600; always dual-res for large images. |

### M10 — `packages/ml`

| | |
|--|--|
| **Fails** | Five clients drift (exactly: onJob/cancel inconsistency). |
| **Now** | Empty reserved README; still claims reconstruct “until extracted” — **stale** (recon is extracted). |
| **Should** | Implement shared poll/cancel **or** delete the package claim. |

### Local API keys

| | |
|--|--|
| **Product rule** | Local services never use API keys. |
| **Code** | Optional `*_API_KEY` on services; Settings has fields for some services. |
| **Verdict** | Not a defect. Do not treat missing key UX as a gap for local studio. |

---

## 6. Stub / demo / deceptive inventory (still in code)

These are **present in the working tree** and must not be marked product-complete:

| Item | Location | Deception |
|------|----------|-----------|
| Demo loft fallback | `registry.ts` loft | Frustum without two real sketches |
| Demo sweep path | hardcoded polyline + demo pipe | Not user path |
| Demo boolean / DEFAULT_RECT subtract | `registry.ts` | Not second-body subtract |
| Hardcoded mirror/pattern | fixed normals/spacing/count | Not selection-driven |
| demo-transform | `tx: 0.02` feature | Not Move body |
| AI prompt replace-body | `prompt.ts` | Contradicts rebuild join |
| Transform order/pivot | `rebuild.ts` | Comment lies; origin pivot |
| Capture panel cancel | Abort only | Server can kill; UI never DELETEs |
| Complete panel silent demo | no `demoWeights` UI | Looks trained |
| NeRF “proposal” naming | hierarchical PDF | Not proposal MLP |
| WeightNorm default off | `sdf_field.py` | Not production-on |
| packages/ml empty | README only | Promised infra missing |
| packages/ml README reconstruct claim | “until extracted” | recon already extracted |

---

## 7. Architecture diagram (logical)

```
┌──────────────────────── apps/plastiq ─────────────────────────┐
│  Ribbon / Context / Properties / Sketcher / AI GenerationPanel │
│  store (CadDocument | MeshDoc | PointCloudDoc | Voxel)         │
│  worker/rebuild ──► @plastiq/cad (OCCT WASM) ──► viewport      │
│  @plastiq/sim (assembly / playback)                            │
└─────────────┬───────────────┬───────────────┬─────────────────┘
              │ HTTP          │               │
    ┌─────────▼────┐  ┌───────▼──────┐  ┌─────▼──────┐
    │ reconstruct  │  │ capture      │  │ nerf       │
    │ :8000 OCCT   │  │ :8001 MLX    │  │ :8002 MLX  │
    └──────┬───────┘  └──────────────┘  └────────────┘
           │ RECONSTRUCT_NURBS_URL
    ┌──────▼───────┐  ┌──────────────┐
    │ nurbs :8003  │  │ photo :8004  │
    │ MLX + OCCT   │  │ SfM + MVS    │
    └──────────────┘  └──────────────┘
```

---

## 8. Severity-ranked remediation (product outcomes, not ticket theater)

### Critical (user-facing wrong or deceptive)

1. **AI prompt join/replace lie** — rewrite `prompt.ts` to match rebuild.  
2. **Loft/sweep replace body** — join-by-default or explicit new; stop destroying prior solid silently.  
3. **Demo loft/sweep/boolean as product ribbon paths** — selection wizards only; remove demos from primary UI.  
4. **Transform feature order + pivot** — R then T about COM; fix comment; separate placement UX.  
5. **Capture Complete silent demo weights** — banner or hard-fail without checkpoint.  
6. **Capture cancel abort-only** — `onJob` + DELETE (server already force-kills).

### High

7. Boolean / mirror / pattern selection authoring.  
8. Recon + nurbs `cancelJob`/`onJob` + panel DELETE.  
9. Photo `sparseMaxDim` default in app.  
10. Properties deps/refs/loft/pattern/boolean data editors.  
11. Variable fillet / 2-dist chamfer UI + schema.

### Medium

12. Hole containment + revolve holes policy.  
13. NeRF doc honesty (PDF vs proposal MLP; WN default).  
14. Live closed-organic reconstruct↔nurbs gate when services up.  
15. `packages/ml` implement or remove claim.  
16. Seed/join E2E face-count honesty.

### Long-horizon (honest open engineering)

- General FR-6 per-region analytic sagitta graph.  
- Full NeuS/sdfstudio parity (true proposal net, WN default-on quality).  
- Multi-body part document model (beyond assembly instances).  
- Trained capture completion weights as default (not synthetic demo).

---

## 9. Status tables — corrected for this working tree

Do **not** treat a prior “T01–T40 ✅” checklist as product-complete. Snapshot:

| Area | Kernel / server | Authoring / UX | Honest status |
|------|-----------------|----------------|---------------|
| Extrude/revolve join | Real | Properties op; AI prompt wrong | **Partial** (prompt lag) |
| Loft/sweep | Real | Demo / last-N / replace | **Not product-complete** |
| Boolean | toolFeatures real | Demo/hardcoded tools | **Not product-complete** |
| Mirror/pattern | Linear tools real | Hardcoded ribbon | **Not product-complete** |
| Dress-ups selection | Real | Real context menu | **Working** |
| Transform feature | Exists | Wrong order/pivot; gizmo=placement | **Broken product semantics** |
| Capture process cancel | Real kill | Panel no DELETE | **Server ahead of UI** |
| Complete demo honesty | Wire flag | Panel silent | **Partial** |
| NeRF neus defaults | learnable β + PDF | WN off; “proposal” naming | **Improved, not research-parity** |
| Reconstruct topology | cut_sphere + cut_cylinder | N/A | **Family routes working** |
| Closed NURBS path | Real when URL set | Live E2E weak | **Partial** |
| Photo dual-res | Server+client | App unused | **Plumbing only** |
| `@plastiq/recon` | Real package | No cancel | **Partial client** |
| `packages/ml` | Empty | N/A | **Scaffold** |
| Local API keys | Optional | Not required | **By design open** |

---

## 10. Bottom line

| Layer | Verdict |
|-------|---------|
| **CAD kernel** | Feature-complete for the intended solid ops; well tested |
| **Rebuild** | Join for pad/revolve is real; loft/sweep/transform policies still hurt multi-feature designs |
| **CAD authoring** | Strong for sketch + pad/pocket/revolve + selection dress-ups; **weak/demo for loft, sweep, boolean, pattern, mirror** |
| **ML services** | Five real pipelines; fleet wiring improved (`RECONSTRUCT_NURBS_URL`, cut_sphere, dual-res plumbing, capture force-cancel) |
| **ML product UX** | Cancel and demo honesty **inconsistent** across panels; photo quality knobs not exposed |
| **Docs / prior Grok checklists** | Often overclaimed “complete” where only unit wires or kernel APIs existed |

**Making CAD feel finished** is primarily **authoring contract + join policy + killing demos**, against an already-capable kernel.  
**Making ML feel finished** is primarily **cancel parity, complete honesty, photo dual-res defaults, and honest NeRF quality claims**, against already-running services.

**Local services never use API keys** — do not treat key UI as a product gap for this studio.

---

## 11. Evidence anchors (quick index)

| Claim | Source |
|-------|--------|
| Extrude join | `apps/plastiq/src/worker/rebuild.ts` ~281–310 |
| Loft/sweep replace | same file ~394, ~446 |
| Transform order/pivot | same file ~580–595 |
| Demo loft/sweep/boolean | `apps/plastiq/src/actions/registry.ts` loft/sweep/boolean* |
| AI replace prompt | `apps/plastiq/src/ai/prompt.ts` ~40–44 |
| Seed box | `apps/plastiq/src/store/seed.ts` |
| Capture process cancel | `services/capture/app/jobs.py` `cancel` / `submit_process` |
| Capture panel abort-only | `GenerationPanel.tsx` CaptureScanSection cancel ~1188 |
| Complete demo flag | `services/capture/app/pipeline.py` `complete_partial_job`; panel silence ~1170–1178 |
| NeRF neus defaults | `services/nerf/app/engine/pipeline.py` ~107–118 |
| WeightNorm default off | `services/nerf/app/fields/sdf_field.py` `use_weight_norm=False` |
| ProposalSampler | `services/nerf/app/generators/ray_samplers.py` — helper; hierarchical PDF in model |
| Reconstruct auto chain | `services/reconstruct/app/pipeline.py` header + routes |
| Closed nurbs delegate | `services/reconstruct/app/nurbs_delegate.py` `delegate_closed_solid`; `fitted.py` |
| RECONSTRUCT_NURBS_URL | `scripts/dev-services.sh` ~126–129 |
| sparse_max_dim | `services/photogrammetry/app/main.py` SolveBody; app unused |
| @plastiq/recon | `packages/recon/src/client.ts` |
| packages/ml empty | `packages/ml/README.md` only |

---

*This document is the analysis deliverable for the current working tree. It supersedes prior Grok resolution tables that marked productization items complete without user-path proof.*
