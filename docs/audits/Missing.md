# Missing / Under-implemented / Incorrect — SPEC-6 + SPEC-7 audit

**Date:** 2026-06-21
**Method:** `/lore:deep-code-investigation` — read the docs (SPEC-6, SPEC-7, the two
investigations, the SPEC-6/7 milestone plans, the mesh→B-rep research dir), then verified
every "shipped" claim against the actual code with `file:line` evidence, and **ran the test
suites** rather than trusting wiring alone.
**Output location:** repo root (`/Users/ryanoboyle/cad-studio/Missing.md`) — the plain reading
of "root of the folder structure." (The alternative reading, `docs/`, was not chosen.)
*(Moved to `docs/audits/Missing.md` on 2026-07-03 in the documentation-reconciliation pass.)*

---

## ✅ Resolution log (2026-06-21, follow-up session)

Every finding below was acted on. Final verification (all run this session):
**reconstruct pytest 67 passed** (was 59 mid-session / 57 at audit time), **plastiq `tsc` clean**,
**full vitest 1051 passed / 3 skipped** (was 1037) — **zero regressions**.

| # | Finding | Status | What was done |
|---|---|---|---|
| 1.3 | report missing `curved_faces`/`faceted_faces` | ✅ Fixed | Added both to server `ReconstructionReport` + populated across all methods via `curved_faces.classify_faces` (OCCT surface-type classification); extended client `ReconstructReport`; 2 new pytest. |
| 1.1 | D-7 Point2CAD doc divergence | ✅ Reconciled | SPEC-7 D-7/D-9/§4.2/§4.4/NFR-2/R-2 + diagram updated to record the deterministic supersession (no code change — deterministic is correct). |
| 1.2 | FR-6 surface-intersection tail / `topology.py` | 🟡 Partial (real, tested) | New `app/topology.py`: `GeomAPI_IntSS` shared-edge primitive + `reconstruct_cut_cylinder` (oblique-capped cylinders) wired into `auto`, self-validated, faceted fallback; 8 new pytest. Also fixed a latent bug: `try_single_primitive` now volume-validates, so a partial cylinder isn't mis-rebuilt as a full one. General per-region analytic + sagitta case still open (R6.9, documented). |
| 1.4 | NFR-2 seed-pinning absent | ✅ Reconciled | Documented as moot (deterministic by construction). |
| 1.5 | FR-7 `ShapeFix_*` not used | ✅ Reconciled | §4.3/FR-7 annotated (closure verified via `BRepCheck_Analyzer`/`NbFreeEdges`/volume). |
| 1.6 | FR-11 default + stale test counts | ✅ Reconciled | FR-11 = `auto` (full chain incl. cut-cylinder); test counts updated to 67. |
| 2.1 | Settings UI (FR-4/FR-5a/FR-5b) | ✅ Built | New `ai/SettingsPanel.tsx`: curated model picker + free-text override + base-URL/proxy + reconstruct/meshGen URLs + key + **surfaced preflight tool warning**; wired into the panel + first-run; 6 new tests. |
| 2.2 | FR-18 mesh GLB export | ✅ Built | New `mesh/exportGlb.ts` + "Export GLB" button; 4 new tests. |
| 2.3 | FR-18 mesh-mode UI gating | ✅ Built | `actions/registry.ts` `meshMode()` allowlist gate (ribbon + command palette grey B-rep ops); 4 new tests. |
| 2.4 | SPEC-6 doc drift (R4.1, §6.1 cap) | ✅ Reconciled | R4.1 location + §6.1 step-cap=12 corrected; new modules added to §5.1. |
| 3 | stale plan statuses | ✅ Fixed | `canvas-context-menu` + `fusion-workspaces` headers → SHIPPED with evidence. |

The original audit findings are preserved verbatim below (each header now carries its status); they
remain the record of what was found, with the resolution noted inline.

---

## 0. Headline

> *(Audit-time framing — see the ✅ Resolution log above for what changed.)*

Both specs are **substantially implemented and green**. SPEC-6 (AI generation) is near-complete;
SPEC-7 (reconstruction) achieved its curved/freeform milestones **deterministically**. The one
**functional** SPEC-7 hole was the **surface-intersection topology tail (FR-6 / `topology.py`)**,
which the spec calls "THE crux" and which was unbuilt at audit time (now **partially built** — the
`GeomAPI_IntSS` primitive + an oblique-cut-cylinder route ship; the fully general per-region case
remains open). The deterministic curved fitting was delivered without vendoring Point2CAD, so
locked decision **D-7 is a decision/doc divergence** (spec described a dependency that doesn't
exist) **whose only functional consequence is that same topology tail** — i.e. one capability gap,
not two. The audit-time gaps clustered in: (a) SPEC-7's topology tail + report contract, (b) SPEC-6's
Settings UI and mesh-document export, and (c) a handful of stale docs — all now addressed.

**Scope note:** SPEC-6, SPEC-7, the two investigations, and the SPEC-6/7 milestone plans were
verified against code. The four older plans (`plastiq-independent-app`, `r3f-viewport-rewrite`,
`canvas-context-menu`, `fusion-workspaces`) are SPEC-4/5-era — checked for shipped/stale status
(§3), not re-audited feature-by-feature. The `docs/research/2026-06-20-mesh-to-brep-reconstruction/`
dir (Agent1–4 findings, Report-Final) was read as **background context** for the algorithm choices,
not as a verification target.

### Verification status (at audit time — post-fix numbers are in the Resolution log above)

| Suite | Command | Result (audit) |
|---|---|---|
| Reconstruct server (live OCCT) | `…/plastiq-reconstruct/bin/python -m pytest -q` | **57 passed** in 4.7 s (→ **67** after fixes) |
| Plastiq typecheck | `pnpm --filter @plastiq/app run typecheck` (`tsc --noEmit`) | **clean, exit 0** (still clean) |
| Full JS suite | `pnpm test` (vitest) | **1037 passed, 3 skipped** (→ **1051 passed, 3 skipped** after fixes) — the skips are the opt-in keyed integration tests (anthropic / openai-compatible / fal-`createMesh` / reconstruct) which gate on a key or a running service |

So nothing below was "a test is red." The findings were genuine **unbuilt** features, **partial**
features, **contract mismatches**, and **stale documentation** — all now resolved (see Resolution log).

---

## 1. SPEC-7 (mesh → B-rep reconstruction) — substantive gaps

### 1.1 Decision D-7 (Vendor/fork Point2CAD) — UNIMPLEMENTED; spec describes a dependency that doesn't exist  · ✅ RESOLVED (doc reconciled)
**Severity: Medium (decision/doc divergence — the *functional* consequence is §1.2, not a second independent gap)**

> D-7's purpose was "curved fitting **+** topology." The curved fitting half **was** delivered
> deterministically (FR-4/FR-5, tests green). So the only functional hole D-7 leaves is the
> topology tail in **§1.2**. Treat this item as the documentation/unfollowed-decision issue;
> the capability gap is counted once, under §1.2.

- `services/reconstruct/vendor/` **does not exist** (`find services/reconstruct/vendor` → exit 1).
- No `point2cad`, `torch`, `INR`, or implicit-neural anything anywhere in `app/` or `tests/`
  (grep: zero hits).
- `app/detect.py:1-8` header states it is **"Deterministic primitive-region detection … (SVD +
  fixed threshold), per NFR-2"** — i.e. the curved fitting is closed-form numpy/OCCT, **not** the
  Point2CAD adapter §4.2 promises.

This is arguably the *better* engineering choice (it matches the **investigation's own
recommendation** — `2026-06-20-r6-curved-reconstruction-and-tail.md` §4/§5, which rejects RANSAC
and Point2CAD on determinism). But the spec was never reconciled, so these sections now describe
code that does not exist:
- **D-7** ("Vendor/fork Point2CAD … for curved fitting + topology")
- **§4.2** (`detect.py` = "deterministic Gauss-map classification **+ Point2CAD adapter,
  seed-pinned**")
- **§4.4** (the entire "Point2CAD integration (D-7) + determinism reconciliation" subsection)
- **NFR-2** (reproducibility "depends on seed-pinning" of Point2CAD's randomization)
- **R-2** risk ("Point2CAD non-determinism + heavy deps (torch/INR)")

**Action:** either implement D-7, or update SPEC-7 to record that the deterministic path
superseded Point2CAD (and downgrade NFR-2/R-2 accordingly).

### 1.2 `topology.py` + the surface-intersection edge-recovery tail (FR-6, D-3) — NOT built  · 🟡 PARTIAL (real, tested — `topology.py` built; general case still open)
**Severity: High (the spec's stated "crux")**

- `app/topology.py` **does not exist** (it is listed in §4.2 as a "New" module owning "adjacency
  graph → intersect/snap → shared edges → corners → trim → heal/sew/solid").
- `GeomAPI_IntSS` / `BRepAlgoAPI_Section` (FR-6's "sharp joins via surface–surface intersection",
  the §4.3-verified APIs) appear **nowhere** in `app/` (grep: zero hits).
- The "analytic-rim sagitta case" (D-3, the spec's explicitly-stated make-or-break) is **unsolved**
  — acknowledged in-spec in the **R6.5 milestone row** ("the analytic-rim sagitta case … still
  needs the surface-intersection tail") and in the investigation **§8 open question**.

How shared-edge topology is *actually* achieved instead (all real, all tested):
- `app/csg.py` — OCCT booleans (`BRepAlgoAPI_Cut/Fuse`) let the kernel compute shared edges
  (box + holes/bosses).
- `app/revolution.py` — `BRepPrimAPI_MakeRevol` creates shared circle edges automatically.
- `app/fitted.py` / `app/freeform.py` — neighbours share the **same mesh-polyline boundary**, so
  `Sewing` at 1e-6 merges them.

Net: a smooth **fitted arc** replacing a faceted-polyline neighbour (deviation ≫ the sew gate) is
**not** handled — those regions fall back to faceted. NFR-1 (no geometry dropped) still holds via
the faceted fallback, but FR-6's general mechanism is absent. **This is the single biggest
functional gap in SPEC-7.**

### 1.3 FR-9 / §6 report contract — missing fields (server **and** client)  · ✅ RESOLVED (fields added + tested)
**Severity: Medium (data-contract mismatch; undermines the NFR-4 "honest UX")**

FR-9 + §6 require `report = { triangles_in, triangles_used, faces_built, planar_faces,
**curved_faces**, freeform_faces, **faceted_faces**, is_solid, is_valid, method }`.

- Server `ReconstructionReport` (`app/pipeline.py:25-35`) has: `triangles_in, triangles_used,
  faces_built, planar_faces, is_solid, is_valid, method, freeform_faces` + an **undocumented**
  `primitive`. **Missing `curved_faces` and `faceted_faces`.**
- For analytic results (`method="auto"` → cylinder/sphere/cone/revolution/csg), the report hard-codes
  `planar_faces=0, freeform_faces=0` (`pipeline.py:71,85,99`) and **never counts the analytic faces
  as curved** — so the per-type breakdown FR-9 promises (for the NFR-4 fidelity UX) is **not
  produced for the common analytic cases**.
- Client type `ReconstructReport` (`apps/plastiq/src/ai/reconstruct.ts:11-19`) omits
  `curved_faces`, `faceted_faces`, **and** `freeform_faces` (which the server *does* emit). The UI
  (`GenerationPanel.tsx:142`) only reads `faces_built` + `is_solid`, so the richer report is unused.

### 1.4 NFR-2 seed-pinning machinery — absent (moot, but spec describes it)  · ✅ RESOLVED (doc reconciled — moot)
**Severity: Low**

No `PYTHONHASHSEED` / `numpy.random.seed` / torch seed pinning exists (grep: only a comment in
`detect.py`). This is **harmless in practice** — with no RANSAC/Point2CAD the pipeline is
deterministic by construction — but NFR-2/§4.4 describe seed-pinning that isn't there (follows
from 1.1).

### 1.5 FR-7 healing chain (`ShapeFix_*`) — not used (implemented differently)  · ✅ RESOLVED (doc reconciled)
**Severity: Low**

FR-7/§4.3 name `ShapeFix_Face/Shell/Solid` + `breplib.SameParameter` + `FixAddNaturalBound`.
`ShapeFix` appears **nowhere** in `app/` (grep: zero hits). Closure *is* verified — the substance
of FR-7 — via `BRepCheck_Analyzer.IsValid()` (`csg.py:244`, `freeform.py:186`, `revolution.py:83`),
`NbFreeEdges()==0` (`freeform.py:179`), `OrientClosedSolid` (`freeform.py:185`), and volume checks.
Faces are built valid by construction rather than healed. Note the spec's named API as not-used.

### 1.6 FR-11 default drift + stale test counts  · ✅ RESOLVED (doc reconciled)
**Severity: Low (documentation)**

- FR-11 says `method` selects **"fitted (default)"**; the actual default is **`"auto"`**
  (`pipeline.py:52`). The milestone rows acknowledge `auto`, but FR-11 itself was not updated.
- Test-count claims are stale undercounts: spec header "16 pytest passing", R6.7 "47 live-OCCT
  pytest", exit criteria "16 pytest" — **actual is 57 passing** (this session). (Tests are green;
  the numbers are just out of date.)
- CORS (R6.7c) defaults to `allow_origins=["*"]` (`app/main.py:32-36`, overridable via
  `RECONSTRUCT_CORS_ORIGINS`) — fine for the local-only posture (D-6), noted for when it deploys.

---

## 2. SPEC-6 (AI generation) — gaps

### 2.1 Settings UI (FR-4, FR-5a, FR-5b) — under-implemented at the UI layer  · ✅ RESOLVED (SettingsPanel built + tested)
**Severity: High (user-facing capability gap)**

The data/logic layer is complete (`ai/providers/models.ts` curated `MODEL_CATALOG` + `preflightModel`;
`ai/settings.ts` carries `baseURL`, `reconstructBaseURL`, `meshGenBaseURL`, `apiKeys`). But the
**only** provider/model UI is `FirstRunChooser` (`GenerationPanel.tsx:53-108`): two **hardcoded**
buttons (Ollama `qwen2.5` / Anthropic `claude-opus-4-8`) + a fal-key field (`CreativeKeyField`,
`:195-236`). Missing vs FR-4 / FR-5a / FR-5b / §6.8:

- **No curated model picker.** `MODEL_CATALOG` (Appendix A) is referenced only by `registry.ts`
  (for `defaultBaseURL`) and `settings.ts` (for a type) — **no UI renders the list** (verified by
  grep across all `.tsx`).
- **No free-text model override input** (FR-5b).
- **No base-URL field and no proxy-URL field** (FR-4 / FR-5). `meshGenBaseURL` and
  `reconstructBaseURL` are **read** (`GenerationPanel.tsx:128`, `meshGenDeps.ts:33`) but have **no
  setter UI** — a user cannot point the app at a deployed reconstruction service or an AI proxy
  from within the app.
- **No OpenAI / other-OpenAI-compatible option** in first-run (only Ollama or Anthropic), despite
  FR-1/Appendix A listing it.
- **The preflight tool-capability warning is never surfaced (FR-5b "warns if not").**
  `preflightModel` is called at `registry.ts:26` but `buildProvider` consumes only
  `caps.supportsVision` (`:39`); `caps.warning` / `caps.supportsTools` are **dead**, so a
  non-tool-calling model is accepted silently (it would just fail `build_part`).

### 2.2 FR-18 — mesh-document export NOT implemented  · ✅ RESOLVED (GLB export built + tested)
**Severity: Medium**

FR-18: "Mesh documents are export-capable (GLB at least)." The export actions
(`export-gltf/step/iges`, `actions/registry.ts:214-232`) all call
`client.exportFile(useCadStore.getState().toDocument(), …)` via `__plastiqExport`
(`three/Viewport.tsx:153-155`) — i.e. the **parametric** document, through the OCCT worker. There
is **no path to export a mesh document's inline GLB**. When a mesh doc is open these actions would
export the (empty/stale) parametric store doc, not the mesh.

### 2.3 FR-18 — "UI reflects B-rep ops unavailable" is partial  · ✅ RESOLVED (mesh-mode action gate + tested)
**Severity: Medium**

`activeMeshDoc` is referenced only in `three/Viewport.tsx` (rendering) and
`ai/GenerationPanel.tsx` (the convert section). The main app shell does **not** gate on mesh mode
(`grep activeMeshDoc app/App.tsx` → nothing). So the FeatureTree, ribbon/toolbar, and the
export/sketch command actions remain offered when a mesh document is open — contrary to FR-18's
"the UI reflects this rather than offering a no-op." Only the GenerationPanel swaps to the convert
view.

### 2.4 Minor SPEC-6 documentation drift  · ✅ RESOLVED (doc reconciled)
**Severity: Low**

- **R4.1 milestone** says "`MeshBody` + `importGltf` in `@plastiq/cad`," but they live in
  `apps/plastiq/src/mesh/` (`meshBody.ts`, `importGltf.ts`). The **r3 reconciliation note**
  correctly records the move, so the R4.1 row is the stale half (already superseded in-doc).
- **§6.1** says the validation-retry "cap: default 4"; the actual agent step cap is **12**
  (`agentRunner.ts:52`) and there is no separate validation-retry counter — corrections are fed
  back as tool results and bounded by the single step cap.

---

## 3. Documentation accuracy (per CLAUDE.md "docs must be 100% accurate")  · ✅ RESOLVED (both plan statuses corrected to SHIPPED)

- **`docs/plans/2026-06-07-canvas-context-menu.md`** header: *"Status: Planned — awaiting
  execution."* **Shipped:** `apps/plastiq/src/three/contextmenu/{contextSelection,contextOptions,
  contextMenuProvider}.ts` + `ContextMenuView.tsx`, `e2e/plastiq/context-menu.spec.ts`. Status is
  stale.
- **`docs/plans/2026-06-07-fusion-workspaces.md`** header: *"Status: Planned — awaiting
  execution."* **Shipped:** `apps/plastiq/src/ribbon/{ribbonConfig,WorkspacePanel,WorkspaceSwitcher,
  TopBar,ActionButton}.tsx`, `store.ts` workspace state (`:80-81,:160-162`),
  `e2e/plastiq/workspaces.spec.ts`. Status is stale.
- (The other two listed plans — `2026-06-05-plastiq-independent-app.md`,
  `2026-06-06-r3f-viewport-rewrite.md` — are SPEC-4/5-era foundations and are clearly shipped:
  the r3f `Viewport.tsx` + `three/*` exist and the full suite is green. Treated as **out of scope**
  for this SPEC-6/7 gap audit. One unchecked checkbox remains at `independent-app.md:86` (R1.4 "API
  contract surface"), but `packages/cad/src/index.ts` exists — the checkbox is unmaintained, not a
  real gap.)

---

## 4. Implemented-differently (NOT gaps — recorded so they aren't mis-flagged)

- **FR-1 "proxy adapter":** there is no separate `proxy.ts`; the proxy is the
  `OpenAICompatAdapter` pointed at a proxy `baseURL` (decision 3 / §5.2). By design.
- **FR-12 index→ref mapping:** `inspect_geometry` returns index-aligned `FaceRef[]`/`EdgeRef[]`
  (`tools/inspectGeometry.ts`), and the model authors `normal+centroid` refs (a `FaceRef`) directly
  into `build_part` (`tools/toolDefs.ts:49`), rather than a separate index-resolution round-trip.
  Functionally covers FR-11/FR-12; `rebuild.ts:127-136` resolves them.
- **FR-16 MeshBody location:** in `apps/plastiq/src/mesh/` (not the kernel) — correct per the r3
  note + decision 24 (`three` is an app dep). `store/types.ts:55-69` defines `MeshDoc`
  (`kind:"mesh"`, inline base64 `glb`) + `isMeshDoc`; viewport renders it main-thread
  (`three/Viewport.tsx:441-460` → `importGltf` → `buildMeshBody`). FR-16/FR-16a met.
- **SPEC-6 selector predicates (FR-13/14):** all eight kinds present and resolved
  (`packages/cad/src/select/predicates.ts:18-26,82`; `worker/rebuild.ts:31-32,127-136`).

### Verified-correct highlights (so this report is balanced)
- R0 deps present (`zod ^4.4.3`, `@anthropic-ai/sdk ^0.105.0`, `openai ^6.44.0`).
- Anthropic adapter: adaptive thinking (`thinking:{type:"adaptive"}`, `anthropic.ts:191`), vision
  (`supportsVision=true`, image blocks `:30-40`), streaming + tool assembly. FR-2.
- `agentRunner` step cap + cancel + error-as-tool-result self-correction (`agentRunner.ts:50-126`).
  FR-7/FR-18a/FR-21.
- `create_mesh` all three modes (text2img3d chains image-gen→3D-gen) + paid-job confirm
  (`tools/createMesh.ts`, `PaidJobConfirmModal.tsx`, `agentTurn.ts`). FR-15/FR-18a.
- fal providers: Tripo/Meshy/Hunyuan + FLUX-schnell image-gen (`meshgen/fal.ts`). FR-15.
- Vision routing toggle + disable-on-incapable (`visionRoute.ts`, `GenerationPanel.tsx:317-331`).
  FR-10a/10b.
- Per-param unit display in `PropertiesPanel.tsx:111` via `featureUnits.ts`. FR-9a / R2.6.
- Per-project conversation/trace persistence wired (`projectsStore.ts:142,172,252,268`
  ↔ `aiStore`/`conversation.ts`). FR-20 / R5.1.
- Command palette mounted + ⌘/Ctrl-K (`app/App.tsx:14,191`); test seam installed
  (`main.tsx:35`). FR-19 / R2.6.
- SPEC-7 reconstruction client + "Convert to CAD" (`reconstruct.ts`, `GenerationPanel.tsx:113-189`)
  → `importStep` (`worker/rebuild.ts`). FR-10.

---

## 5. Open questions / could not verify in this environment

- **Creative cloud path is unverified against the live provider.** `meshgen/fal.ts:22-23` states it
  "has **not** been executed against the live fal API in this environment," and the `createMesh`
  integration test is opt-in/keyed (among the skipped suite). End-to-end fal correctness is
  unverified (honest, per Risk R-1 / §10).
- **Two real-service E2Es skip here.** `e2e/plastiq/ai-ollama.spec.ts` (needs a reachable Ollama)
  and `e2e/plastiq/reconstruct.spec.ts` (needs the running service) are genuine + properly gated,
  but were **not executed live** this session (no Ollama / no running service). The always-on
  model-free `ai-deterministic.spec.ts` *is* CI-safe (drives real handlers via `__plastiqAi`).
- **Docker (R6.8)** was not built/run here; the spec's "≈4.7 GB image" and "exceeds the ~4 GB hosted
  cap" claims are unverified in this session.
- **Reconstruction quality on real organic meshes** (the NFR-4 caveat) needs runtime data, not code
  reading.
