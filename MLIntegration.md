# ML Service ↔ Canvas Integration Map (deep pass)

**Date:** 2026-07-12
**Scope:** How the ML services (`capture`, `reconstruct`, `nerf`, `nurbs`, `photogrammetry`) reach the `apps/plastiq` canvas today, traced end-to-end, and **every concrete integration point / tool integration** for wiring them *directly onto the canvas*.
**Method:** Full source reads, `file:line` at every hop. No guessing.

---

## 1. Executive Summary

Every ML service already has a package client (`@plastiq/{capture,nerf,nurbs,photogrammetry,recon}`) **and** an app wrapper (`apps/plastiq/src/ai/{capture,nerf,nurbs,photogrammetry,reconstruct}.ts`), each returning a **`MeshDoc` or `CadDocument`** that reaches the canvas through **exactly two terminal seams**:

- **`createMeshProject(doc)`** → new mesh project → `activeMeshDoc` → `Scene.tsx:130 buildMeshBody` (GLB path) — used by capture/nerf/photogrammetry.
- **`useCadStore.loadDocument(doc)`** → active parametric store rebuild (STEP `importStep` path) — used by reconstruct/nurbs.

But **every one of those calls today originates from one file — the AI `GenerationPanel` side-panel** (`apps/plastiq/src/ai/GenerationPanel.tsx`, the sole non-client caller of all five). **The canvas has no direct ML entry points.** Three findings define the integration work:

1. **One `ContextAction` fans out to three surfaces at once.** The context menu **and** the RECM radial ring both consume `CONTEXT_ACTIONS` (`three/contextmenu/recmContext.ts:12,37`), and the action registry feeds the ribbon. So a single `ContextAction`/`ActionDef` = context-menu + radial-ring + ribbon reach. This is the highest-leverage insertion point.
2. ~~**The `ContextTarget` has no mesh/point-cloud/voxel kind**~~ — **CLOSED 2026-07-12.** `ContextKind` still doesn't gain new members; instead `ContextTarget` now carries the **active-doc kind** directly — `activeMeshDoc` + `activePointCloudDoc` (`three/contextmenu/contextSelection.ts`) — so mesh/cloud actions gate on `ctx.activeMeshDoc != null` / `ctx.activePointCloudDoc != null` and stay pure over `ctx`. (This was the one real structural gap; the chosen fix was the "read the active-doc kind" option below.)
3. **A point-cloud renderer already exists** — `buildMeshBody` builds "the B-rep corners as one Points cloud with per-point vertex colours" (`viewport/buildMesh.ts:8`). Exposing photogrammetry/capture dense clouds is *parallelizing an existing primitive*, not building one from scratch.

---

## 1a. Implementation Status — SHIPPED 2026-07-12

The integration points below (§4) were implemented this pass, in order, each with typecheck + unit tests green (full `apps/plastiq` suite 1222 pass / 6 skip / 0 fail; `@plastiq/capture` 27 pass). The canvas is the **same** `three/Scene.tsx` as the rest of the app (no separate viewer). Structural gap #2 (no active-doc kind on `ContextTarget`) is **closed**: `ContextTarget` now carries `activeMeshDoc` + `activePointCloudDoc` (`three/contextmenu/contextSelection.ts`), threaded through `resolveContextTarget` and both callers (`useCanvasRightClick.ts`, `ribbon/useActionContext.ts`), so actions gate purely on `ctx` — no store reach-in from a predicate.

| # | Integration point | Status | Where |
|---|---|---|---|
| §4.1 | Context menu + RECM ring — mesh→CAD + cloud→mesh actions | ✅ SHIPPED | `three/contextmenu/mlActions.ts`, `cloudActions.ts` → spread into `CONTEXT_ACTIONS` (`config.ts`); menu mounts in the mesh + cloud `Scene` branches; `isActionVisible` (`config.ts`) doc-mode-filters so those branches show ONLY the conversions |
| §4.2 | Action registry → ribbon + command palette | ✅ SHIPPED | actions flow via `CONTEXT_DEFS` into `ACTIONS`; `MESH_SAFE_IDS`/`POINTCLOUD_SAFE_IDS` gate them enabled in their doc mode (`actions/registry.ts`); ribbon "Mesh → CAD" + "Point Cloud" panels (`ribbon/ribbonConfig.ts`); palette surfaces them via `enabled` |
| §4.3 | AI agent tools | ✅ SHIPPED | `reconstruct_brep` + `fit_nurbs` (`ai/tools/meshToCad.ts`), wired in `toolDefs.ts` (gated on `meshToCad`) + `agentTurn.ts` (`buildMeshToCadDeps`); creative prompt teaches the create_mesh→convert chain (`ai/prompt.ts`) |
| §4.4 | Live point-cloud viewer + `PointCloudDoc` | ✅ SHIPPED | `PointCloudDoc` kind (`store/types.ts`) with full persistence/open/recovery parity (`persistence/projectsStore.ts`); `viewport/buildPointCloud.ts` (THREE.Points) renders it in the same `Scene`; dense cloud now SHOWN, not discarded (`denseCloudToPointCloudDoc`, colour-preserving PLY parse in `@plastiq/capture`) |
| §4.5 | Ribbon "Capture/ML" workspace | ◑ PARTIAL (by design) | delivered as "Mesh → CAD" + "Point Cloud" **panels in the existing `design` workspace** rather than a new workspace — the mesh/cloud docs already open in `design`, so a separate workspace would fragment the flow |
| §4.6 | Drag-and-drop routing | ✅ SHIPPED | `three/canvasDrop.ts` (pure classify + route) + `CanvasDropZone.tsx` wrapping the viewport (`app/App.tsx`): photos → `solvePhotogrammetry` → cloud; `.ply`/`.xyz`/`.json` → `parseCloudFileToDoc` → `PointCloudDoc` |
| §4.7 | In-viewport gizmos / hover affordances | ▢ NOT DONE (as predicted) | the menu/ring/ribbon/palette reach suffices; left as an optional future affordance |

**The full on-canvas pipeline now chains:** drop photos/`.ply` (§4.6) → point cloud on the canvas (§4.4) → right-click "Point cloud → mesh" (§4.1/§12) → mesh → right-click "Reconstruct B-rep" / "Fit NURBS surface" (§4.1/§8) → editable CAD — or drive any step from the ribbon (§4.2), command palette, or the AI agent (§4.3).

---

## 2. Primary Execution Trace (canvas result ← ML service)

### 2.1 reconstruct / nurbs — the STEP → parametric path

```
GenerationPanel button                                   ai/GenerationPanel.tsx:412 (Convert) / :423 (Fit smooth)
  → reconstructMesh(doc.glb, {baseURL, method, signal})  ai/reconstruct.ts:90
      POST {base}/reconstruct  {glb_base64, method?}      ai/reconstruct.ts:101  ← job submit
      poll GET {base}/jobs/{id}/status  → "completed"      ai/reconstruct.ts:112-126  ← submit/poll loop
      GET {base}/jobs/{id}/result → ReconstructResult{step,report}  ai/reconstruct.ts:119-121
  → stepToImportDocument(result.step, name)               ai/reconstruct.ts:133 → CadDocument{features:[{type:"importStep",data:{step}}]}
  → useCadStore.getState().loadDocument(cadDoc)           ai/GenerationPanel.tsx:320  ← SEAM #1
  → cad store rebuilds the importStep feature → editable B-rep part on canvas
```

`fitMeshToCad(...)` (`ai/nurbs.ts:41`) lands through the **same** `stepToImportDocument` terminus (`GenerationPanel.tsx:381`, comment `:285`).

### 2.2 capture / nerf / photogrammetry — the GLB → mesh-project path

```
GenerationPanel button                                   ai/GenerationPanel.tsx:701 (capture) / :1035 (solve) / :1058 (to-surface)
  → captureFromPhotos(...) | meshFromPointCloud(...) | solvePhotogrammetry(...)   ai/nerf.ts:41 | ai/capture.ts:41 | ai/photogrammetry.ts:46
      (each: submit → poll → result; e.g. capture.ts:46 capturePointCloud(input,opts))
  → *ResultToMeshDoc(glb) | denseCloudToMeshDoc(...)      ai/capture.ts:29 | ai/nerf.ts:25 | ai/photogrammetry.ts:81 → MeshDoc{kind:"mesh",glb}
  → deps.persist(doc)  ==  createMeshProject(doc)         ai/GenerationPanel.tsx:619,937,983  ← SEAM #2 (dependency-injected)
      store.create(name, doc) → refresh() → id            persistence/projectsStore.ts:260-266
  → open(id) routes by kind: isMeshDoc → activeMeshDoc    persistence/projectsStore.ts:277-282
  → Scene builds it: meshBodies.map(buildMeshBody)        three/Scene.tsx:129-130 → viewport/buildMesh.ts (BufferGeometry + Points)
```

**Data shapes:** `glb_base64:string` → HTTP job → `{step}` or `{glb}` → `CadDocument{features}` **or** `MeshDoc{kind:"mesh",glb:string}` (`store/types.ts:58-62`) → `activeMeshDoc` / cad `features` → `THREE.Mesh`/`Points`. ~~Lossy: the dense **point cloud** is discarded once meshed~~ — **FIXED 2026-07-12:** the dense cloud is now retained as a `PointCloudDoc` and shown on the canvas (`ai/photogrammetry.ts denseCloudToPointCloudDoc` → `createPointCloudProject`); `denseCloudToMeshDoc` remains for the direct mesh hand-off.

---

## 3. The Two Seams and Two Render Paths (reuse these)

| Doc kind | Seam | Persist? | Render path |
|---|---|---|---|
| `CadDocument` (STEP/parametric) | `useCadStore.loadDocument(doc)` (`GenerationPanel.tsx:320`) | into active store (transient unless saved) | rebuild `features` → B-rep part |
| `MeshDoc` (`kind:"mesh"`, glb) | `createMeshProject(doc)` (`projectsStore.ts:260`) → `open` → `activeMeshDoc` (`:282`) | new project, persisted | `Scene.tsx:130 buildMeshBody` → GLB geometry |
| `VoxelDoc` (`kind:"voxel"`) | voxel store `open` (`projectsStore.ts:286`) | new project | voxel sculpt workspace |

A project is parametric **or** mesh **or** voxel, never mixed (`store/types.ts:54-58`, SPEC-6 decision 20). So a canvas "reconstruct this mesh" action creates a **new** CadDocument project; it does not mutate the mesh in place.

**The DI wiring template** (copy this): `meshFromPointCloud(input, deps, opts, name)` takes `deps.persist` and calls it after building the doc (`ai/capture.ts:41-49`). New canvas actions/tools inject `persist = (d)=>createMeshProject(d)` (or `loadDocument`) exactly as `GenerationPanel.tsx:619` does — no reimplementation.

---

## 4. Every Integration Point (exact anchors · exists vs missing)

### 4.1 Context menu + RECM radial ring — ONE definition, TWO surfaces — ✅ SHIPPED (§1a): `mlActions.ts` + `cloudActions.ts`

- **Interface:** `ContextAction {id, group, label(ctx), danger?, visible(ctx), enabled(ctx), active?, run(ctx)}` where `run` calls the real store fn (`three/contextmenu/config.ts:40-55`). Catalog `CONTEXT_ACTIONS` holds only parametric ops today: `new-sketch-*` (`:126`), `sketch-on-face` (`:135`), `extrude` (`:148`), `cut` (`:170`), `revolve` (`:188`), `fillet` (`:210`), etc.
- **Rendered by:** `contextOptions.ts:37 buildContextOptions(CONTEXT_ACTIONS)` → `PlastiqContextMenu.tsx` (via `useCanvasRightClick.ts`) **and** `recmContext.ts:12,37` (the RECM radial ring imports the *same* `CONTEXT_ACTIONS` + `runContextAction` + `ACTION_GROUP_ORDER`).
- **Input available:** `ContextTarget` (`contextSelection.ts:23`) carries `kind`, `picks`, `refs`, `features`, `selectedFeatureId`, mode flags — the full selection an ML op needs.
- **ADD:** new `CONTEXT_ACTIONS` entries whose `run` calls an `ai/<svc>.ts` fn then a seam — automatically appear in the context menu **and** the radial ring:
  - mesh target → **"Reconstruct B-rep"** `reconstructMesh(exportMeshGlb(sel))` → `loadDocument(stepToImportDocument(step))`.
  - mesh target → **"Fit NURBS surface"** `fitMeshToCad(...)`.
  - cloud target → **"Point cloud → mesh"** `meshFromPointCloud(...)` / **"Complete partial scan"** `meshFromPartialScan(...)`.
  - voxel target → **"Convert to CAD"** (ADR-0010 handoff, `voxel/doc.ts:31 voxelDocToMesh`).
- **BLOCKER:** `ContextKind` has no `mesh`/`pointcloud`/`voxel` member (`contextSelection.ts:12`). Either add kinds + resolve them in `contextSelection`, or gate the new actions on the **active-doc kind** (`isMeshDoc(activeMeshDoc)`), read in `visible(ctx)`.

### 4.2 Action registry → ribbon + command palette — ✅ SHIPPED (§1a)

- **Interface:** `ActionDef {id, label, enabled?, run(ctx:ContextTarget)}` — "single source of run/enabled/label logic" for ribbon + menu (`actions/registry.ts:27-33`). Already wraps `exportMeshGlb` (`:18`) and the `__plastiqExport` file seam (`:71-92`).
- **Ribbon:** `ribbon/ribbonConfig.ts:150,169` maps actions → buttons (icons/labels); widgets in `ribbon/widgets/`. **Command palette:** `ai/CommandPalette.tsx` (searchable launcher).
- **ADD:** register `reconstruct`/`fit-nurbs`/`cloud-to-mesh`/`photo-solve`/`nerf-capture` as `ActionDef`s → they surface in the ribbon **and** command palette from one definition.

### 4.3 AI tool-calling — let the agent run ML ops — ✅ SHIPPED (§1a): `create_mesh` + `reconstruct_brep` + `fit_nurbs`

- **Loop:** `agentRunner.ts` drives `handlers: Record<string, ToolHandler>` (`:26`); a `ToolHandler` gets parsed args → returns a result string (`:20`); tool-call/result events (`:15-16`); a failed tool returns its error so the model self-corrects (`:5-6`).
- **Defs:** `ai/tools/toolDefs.ts:47 toolDefs()` exposes only `plan_part` (`:50`), `build_part` (`:56`), `inspect_geometry` (`:67`), `answer_user` (`:73`), `create_mesh` (`:85`, schema `{mode,prompt,imageId,providerId,quality}`). Deps: `AgentToolDeps` (`toolDefs.ts` ~`:110`) — `buildPart`, `probe`, snapshot, `createMesh`. Persist wiring: `agentTurn.ts:57 createMeshProject`, `:86 buildCreateMeshDeps`. Schemas: `ai/tools/schema.ts`.
- **ADD tools** (mirror `create_mesh`): `reconstruct_brep`, `fit_nurbs`, `cloud_to_mesh`, `solve_photogrammetry`, `capture_from_photos` — each = a schema in `schema.ts` + a handler in `ai/tools/` (added to the `handlers` record) + a `ToolDef` in `toolDefs.ts` + deps in `agentTurn.ts` → result to a seam. Then "reconstruct the selected mesh" works from chat.

### 4.4 Live point-cloud viewer — ✅ SHIPPED (§1a): `PointCloudDoc` + `viewport/buildPointCloud.ts`

- **Exists:** `buildMeshBody` already renders "the B-rep corners as one **Points** cloud with per-point vertex colours" (`viewport/buildMesh.ts:8`); `THREE.Points` is also used for section analysis (`three/Section.tsx:36`).
- **Missing:** a `PointCloudDoc` document kind and a canvas layer that shows the **dense** photogrammetry/capture cloud. Today `parseDenseCloud` → `{points,normals}` (`ai/photogrammetry.ts:67-72`) is fed straight to `denseCloudToMeshDoc` and the raw cloud is dropped.
- **ADD:** a `PointCloudDoc` (parallel to `MeshDoc` in `store/types.ts`) + a `<PointCloud>` renderer reusing the `buildMeshBody` Points primitive (per-point normal/colour) + show it *before* meshing with an in-canvas "mesh this" affordance. This makes the pipeline visible instead of a black box.

### 4.5 Ribbon "Capture/ML" workspace — ◑ PARTIAL (§1a): panels in the `design` workspace, not a new one

- `ribbon/WorkspacePanel.tsx` + `WorkspaceSwitcher.tsx` define workspaces. **Chosen instead:** "Mesh → CAD" + "Point Cloud" panels in the existing `design` workspace's Solid tab (`ribbon/ribbonConfig.ts`), greyed-not-hidden outside their doc mode (FR-18). A mesh/cloud document already opens in `design`, so a separate workspace would fragment the flow; a dedicated "Capture/ML" workspace remains a future option if the tool set grows.

### 4.6 Drag-and-drop / import routing — ✅ SHIPPED (§1a)

- Import seam: `actions/registry.ts:102 LARGE_IMPORT_WARN_BYTES`, `:105 importStatusMessage`, `mesh/importGltf.ts`. **DONE:** `three/canvasDrop.ts` classifies a canvas drop by type and routes it — a photo folder (≥3) → `solvePhotogrammetry` → dense `PointCloudDoc`; a `.ply`/`.xyz`/`.json` → `parseCloudFileToDoc` → `PointCloudDoc`; both open on the same canvas. `CanvasDropZone.tsx` is the DOM glue (`app/App.tsx` wraps the viewport).

### 4.7 In-viewport gizmos / hover affordances — ▢ NOT DONE (optional, as predicted)

- `three/gizmos/` (e.g. `sectionAnalysis.gizmo.tsx`) shows the gizmo pattern; an ML op could hang a hover-button off a selected mesh. Left unbuilt: the menu/ring/ribbon/palette reach (§4.1/4.2/4.3) delivered the surface, exactly as this section predicted "likely suffices."

---

## 5. Per-Service Canvas Wiring Table

| Service | Canvas trigger to add | Input from canvas | App fn (exists) | Seam |
|---|---|---|---|---|
| reconstruct | ctx/ring/ribbon: "Reconstruct B-rep" | selected MeshDoc → `exportMeshGlb` | `reconstructMesh`→`stepToImportDocument` (`ai/reconstruct.ts:90,133`) | `loadDocument` |
| nurbs | ctx/ring/ribbon: "Fit NURBS" | selected MeshDoc glb | `fitMeshToCad` (`ai/nurbs.ts:41`) | `loadDocument` (STEP) |
| capture | ctx: "Cloud→mesh"/"Complete" | PointCloudDoc (§4.4) | `meshFromPointCloud`/`meshFromPartialScan` (`ai/capture.ts:41,55`) | `createMeshProject` (via `deps.persist`) |
| nerf | ribbon/drag: posed photos→mesh | photo set + poses | `captureFromPhotos`→`nerfResultToMeshDoc` (`ai/nerf.ts:41,25`) | `createMeshProject` |
| photogrammetry | drag photos onto canvas | photo folder | `solvePhotogrammetry`→`denseCloudToMeshDoc` (`ai/photogrammetry.ts:46,81`) | point-cloud viewer + `createMeshProject` |

---

## 6. Boundary Audit (client ↔ service)

| # | From → To | Mechanism | Auth | Errors | Timeout | Contract |
|---|---|---|---|---|---|---|
| 1 | `ai/reconstruct.ts` → :8000 | POST `/reconstruct` → poll `/jobs/{id}/status` → `/jobs/{id}/result` (`:101-121`) | none (localhost) | `httpError()` throws; `failed` state throws (`:123`) | `maxPolls×interval` (400×1500ms, `:99`) then throws (`:128`) | `{glb_base64,method?}` → `{step,report}` |
| 2 | `ai/capture.ts` → :8001 | `capturePointCloud` (`@plastiq/capture`), `/capture` + `/complete` | none | client throws; wrapper surfaces | client default | `CaptureInput{points,normals}` → `{glb,report}` |
| 3 | `ai/nerf.ts` → :8002 | `captureFromPhotos`, cancel via `cancelCapture` (`:60`) | `nerfApiKey` (settings `:36`) | throws; `cancelCapture(jobId)` DELETEs | client default | posed photos → `{glb}` |
| 4 | `ai/nurbs.ts` → :8003 | `fitMeshToCad`; `nurbsUnreachableMessage` (`:24`) | none | reachability message | client default | glb → STEP |
| 5 | `ai/photogrammetry.ts` → :8004 | `solvePhotogrammetry` (`onJob` → cancel via `cancelPhotogrammetry` `:57`) | none | throws; DELETE job on cancel | client default | photos → `{transforms,densePly}` |
| — | reconstruct → nurbs (server) | `nurbs_delegate.delegate_region_face` | env `NURBS_URL` | returns None → local fallback | — | freeform region delegation (`services/reconstruct/app/freeform.py:44,126-129`) |

All URLs/keys are modelled in `AiSettings` (`ai/settings.ts:25,28,32,36,39`, defaults = the localhost ports).

---

## 7. Test Coverage Map

- **Client contracts — well covered:** `reconstruct.{unit,integration}.test.ts`, `nurbs.unit.test.ts`, `nerf.unit.test.ts`, `capture.unit.test.ts`, `photogrammetry.unit.test.ts`, `tools/createMesh.{unit,integration}.test.ts`, `createMeshFlow.integration.test.ts`.
- **Panel UX — covered:** `GenerationPanel.{capture,nerf,photo,plan,imagegen,ux}.test.tsx`, `SettingsPanel.{capture,nerfkey,photogrammetry}.test.tsx`.
- **GAP:** zero **canvas-integration** tests for ML (no `CONTEXT_ACTIONS` ML-action tests, no ribbon ML-action tests, no point-cloud-viewer tests) — because those integration points don't exist yet. New actions/tools must ship with `contextOptions`/registry tests mirroring the existing parametric-action tests (`three/contextmenu/config.test.ts`, `actions/registry.test.ts`).

---

## 8. Risk Areas

1. ~~**`ContextTarget` has no mesh/cloud kind**~~ — RESOLVED (§1a): gated on active-doc kind (`activeMeshDoc`/`activePointCloudDoc` on `ContextTarget`).
2. ~~**Dense cloud is lossy**~~ — RESOLVED (§1a): retained + shown as a `PointCloudDoc` (`denseCloudToPointCloudDoc`).
3. ~~**Single-surface coupling**~~ — RESOLVED (§1a): the conversions now reach from the context menu, RECM ring, ribbon, command palette, AI agent, AND canvas drop — no longer `GenerationPanel`-only.
4. **Progress/cancel is panel-bound** — reuse `three/LoadingOverlay.tsx` + `cancelCapture` (`ai/nerf.ts:60`) / `cancelPhotogrammetry` (`ai/photogrammetry.ts:57`) for canvas triggers.
5. **Paid-job gate** — `create_mesh` routes `ConfirmPaidJob` (`tools/createMesh.ts:47`, `PaidJobConfirmModal.tsx`); any new AI ML-tool with cost must route the same gate.
6. **Validation before persist** — `createMesh` runs `validateGlb` (`tools/createMesh.ts:71`); canvas actions must validate service output (`mesh/importGltf.ts`) so a bad result can't corrupt a doc.

---

## 9. Open Questions — RESOLVED this pass (2026-07-12)

1. ~~Persist the cloud as a first-class `PointCloudDoc`?~~ → **Yes** — shipped as a full `PersistedDoc` member (§4.4).
2. ~~Agent-callable ML tools in scope?~~ → **Yes** — `reconstruct_brep` + `fit_nurbs` shipped (§4.3).
3. ~~"Directly into the canvas" = in-viewport gizmos?~~ → **No** — context-menu + radial-ring + ribbon + palette + drag-drop reach was sufficient (§4.7 left unbuilt).
4. ~~New project vs replace the active mesh doc?~~ → **New project** (decision-20 non-mixing): reconstruct/fit/cloud→mesh persist a fresh project and `open()` it; the source mesh/cloud doc is left in place until replaced by the open.

---

*Evidence: `apps/plastiq/src/{ai,ai/tools,three,three/contextmenu,three/gizmos,actions,ribbon,store,persistence,viewport,voxel,mesh}` + `services/reconstruct`, read directly. Citations `path:line` at 2026-07-12.*
