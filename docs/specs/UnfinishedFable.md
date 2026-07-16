# UnfinishedFable — deep investigation: unfinished, under-implemented, and deceptive/simulated work in SPEC-6 … SPEC-11

**Date:** 2026-07-04
**Scope:** `docs/specs/SPEC-6-ai-generation.md`, `SPEC-7-mesh-reconstruction.md`, `SPEC-8-feature-recognition.md`, `SPEC-9-authoring-extensions.md`, `SPEC-10-capture-and-completion.md`, `SPEC-11-nerf-service.md` — each compared line-by-line against the shipped code.
**Method:** six parallel deep-code investigations (one per spec), every load-bearing finding independently re-verified against the source before inclusion. Three service test suites were executed live during the investigation: `services/reconstruct` **93/93 pass**, `services/nerf` **53/53 pass (0 skips)**, `services/capture` **28/28 pass**, plus 76/76 SPEC-9-related and 25/25 nerf-related vitest tests. Every claim below carries a `file:line` citation that was actually read.

---

## 1. Executive summary

Plastiq is a browser-native, prompt-to-part parametric CAD editor — an AI authors real, editable B-rep feature history in an in-browser OCCT kernel — surrounded by a family of optional self-hosted Python/MLX services (reconstruct, capture, nerf) that carry generated meshes back into editable CAD. The single most important finding of this investigation is a **negative** one: **no simulated core functionality exists anywhere in the six specs' scope.** The OCCT solids are real, the MLX training genuinely learns (missing-hemisphere completion, held-out PSNR gains), the fal/Anthropic/Ollama clients speak the real wire protocols, and the no-mock E2E tests are honestly labeled. Nothing returns hardcoded geometry where math belongs.

What the investigation did find is a consistent second-order problem: **the specs overstate integration and verification at the edges.** Three patterns repeat across all six specs:

1. **"Green in CI" theater at the service boundary.** Tests that require a live model or service (`ai-ollama.spec.ts`, `reconstruct.spec.ts`, and the entirely-absent nerf E2E) structurally *always skip* in CI, while the specs claim them as CI-verified acceptance criteria.
2. **Dead seams — features that are built, tested, and unreachable.** `.assy` import has no caller; `plan_part`'s `onPlan` sink is never injected; `DELETE /jobs/{id}` has zero consumers; hash-grid and importance sampling never run in the served product; `tangent_regions` reaches the client type and stops.
3. **Spec staleness in both directions.** SPEC-7 claims a verified Docker image that a later dependency broke; SPEC-8 names an algorithm (scipy) the code doesn't use; SPEC-9's "honest scope" deferral is stale because the deferred voxel UI actually **shipped**.

Severity legend: **HIGH** = a spec acceptance claim is materially untrue or a marquee workflow is unreachable · **MEDIUM** = a real capability/verification gap the spec does not admit · **LOW** = drift, missing coverage, or edge-semantics.

---

## 2. Cross-cutting patterns (the frame for everything below)

### P1 — CI-claimed E2E that can never run in CI

| Path | The test itself | Why it never runs in CI |
| --- | --- | --- |
| `e2e/plastiq/ai-ollama.spec.ts:53` | Genuine no-mock, model-in-the-loop E2E (live Ollama → agent loop → OCCT → render) | `test.skip(!model, …)` and `.github/workflows/ci.yml:59-96` never installs/starts Ollama |
| `e2e/plastiq/reconstruct.spec.ts:47` | Genuine no-mock browser→service→STEP→kernel E2E | `test.skip(!(await serviceReachable()), …)`; the CI Playwright job never boots `services/reconstruct` |
| nerf browser path | — | No nerf/photos3d E2E exists at all in `e2e/plastiq/` (35 specs, zero hits) |

The tests are honest; the *spec claims* ("green in CI", SPEC-6 §14.8; "verified live", SPEC-7 R6.7b; "matching the reconstruct precedent", SPEC-11 §6) are not. The real always-on CI E2E for the AI path is `ai-deterministic.spec.ts`, which is correctly self-labeled "NOT the AI E2E" (`ai-deterministic.spec.ts:8-9`).

### P2 — Built-and-tested but unreachable (dead seams)

| Seam | Built at | Never used by |
| --- | --- | --- |
| `.assy` import (`parseAssy`, `realizeAssembly`) | `apps/plastiq/src/assembly/assy.ts` | any production code — zero non-test callers (repo-wide grep); only `assemblyToAssy` (export direction) is wired via `app/BomSection.tsx:9` |
| `plan_part` plan sink `onPlan` | `apps/plastiq/src/ai/tools/toolDefs.ts:111,164` | either runner — `agentTurn.ts:77-82` and `headless/nodeBuild.ts:180-184` both omit it; validated `PlanGraph`s are discarded |
| `DELETE /jobs/{id}` (nerf) | `services/nerf/app/main.py:183-189` (tested) | `packages/nerf/src/client.ts` (POST/GET only); panel Cancel aborts polling while the M4 Max keeps training (`GenerationPanel.tsx:377`) |
| `JobStore.remove()` / `running_count()` (capture + reconstruct) | `services/capture/app/jobs.py:91-101`, `services/reconstruct/app/jobs.py:92-102` | any endpoint or caller — tests only; `running_count`'s docstring promises a concurrency bound no caller implements |
| Hash-grid encoding + PDF importance sampler (nerf) | `app/field_components/encodings.py:42-93`, `app/generators/ray_samplers.py:31-54` (train-tested) | the served product — `engine/pipeline.py:63-68` hardcodes `FieldConfig(hidden=64, layers=4)` + coarse-only sampling; no wire field exposes them |
| `tangent_regions` in the UI | typed at `apps/plastiq/src/ai/reconstruct.ts:29` | the only report consumer — `GenerationPanel.tsx:196-211` renders `faces_built`/`is_solid`/`surface_deviation`, never `tangent_regions` |
| `recognize()`'s `curved_regions` | `services/reconstruct/app/recognition.py:117` | the pipeline — `pipeline.py:97` reads only `tangent_regions`; per-region MLX work computed and discarded |
| `app/geometry.py` depth-scan math (capture, M6) | real, 6 passing tests | any endpoint/CLI — referenced only in docstrings (`sdf_mlx.py:10`, `pipeline.py:5`) |
| `geometryClientProbe`, `proxyKeyResolver`, `isFirstRun` (SPEC-6) | `ai/tools/buildPart.ts:99-108`, `ai/settings.ts:88-103` | production imports — the seam probe and direct checks are used instead (`agentTurn.ts:65-73`, `GenerationPanel.tsx:902`) |

### P3 — Undeclared or empty scope

- **`services/photogrammetry/`** — entirely untracked in git, absent from every spec/plan/ADR/README/CI file, and **completely empty**: `pyproject.toml`, `README.md`, `.dockerignore`, `.gitignore` are all 0 bytes; `app/` and `tests/` contain nothing (created 2026-07-03 23:23). SPEC-10 twice declares the photos→point-cloud half "COLMAP's job, not built here" — a service by this name is an unrecorded scope reversal in embryo. (**Resolved 2026-07-04, later same day:** user decision = **build**; specced as `docs/specs/SPEC-13-photogrammetry-service.md`, and SPEC-10 / ADR-0007 / ADR-0006 / README now carry the dated reversal notes — so "absent from every spec" above describes the audit-time state. The scaffold itself is still empty; implementation is P0-pending under SPEC-13.)
- **`services/nurbs/`** — same shape: a one-line README ("`# plastiq-nurbs — modular MLX Nurbs`"), `.dockerignore`/`.gitignore`, empty `app/` and `tests/`. Declared by name only; no spec covers it.
- **MLX became a hard runtime dependency of the "deterministic" reconstruct service** (`fidelity.py:30`, `recognition.py:19`, both in the import chain of every request via `pipeline.py:29,33` → `main.py:27`) and **SPEC-7 never mentions the word MLX**. This is what breaks the Docker claim (finding 7-H1).
- Empty package scaffolds (intentional, per project convention — recorded, not flagged for removal): `packages/ml`, `packages/recon`, `packages/rl`, `packages/segment`, `packages/embed` are file-less; `packages/data` is an empty directory tree (`src/{classification,types,embedding,chunking,processors,workers,pool,loaders}`, zero files).

---

## 3. SPEC-7 — Mesh→B-rep reconstruction (the most overstated spec)

### 7-H1 · HIGH · R6.8 "✅ local Docker verified" is stale — the image cannot start

- **Spec claim:** §8 R6.8 "✅ local Docker verified — `docker build` + `docker run` → `/health` ok + a real GLB reconstructs end-to-end through the container."
- **Reality:** `services/reconstruct/environment.yml:21-24` pip-installs **bare `mlx`**; the repo's own CI documents that "PyPI's bare `mlx` has NO backend on Linux" and must install `mlx[cpu]` explicitly (`.github/workflows/ci.yml:103-106,146-151`). The Dockerfile (`services/reconstruct/Dockerfile:9`) builds the Linux env from `environment.yml` with no `mlx[cpu]` step, and `app/main.py:27 → pipeline.py:29 → fidelity.py:30` imports `mlx.core` at import time — uvicorn cannot start in the container. Git shows the Docker-verify commit (`2161e32`, 2026-06-21) **predates** the MLX commits (`55ecb5c`/`98ec081`, 2026-06-22); the Dockerfile is unchanged since R6.1. The only supported deploy mode (D-6 "local Docker") is currently non-functional, and both the spec and the service README ("Verified locally") present it as verified.
- **Category:** doc-vs-code drift → effectively deceptive today.

### 7-H2 · HIGH · FR-11's `method` "request param" does not exist on the API

- **Spec claim:** FR-11 "A `method` **request param** selects `auto` … `fitted` … or `faceted` … (Shipped in `pipeline.reconstruct`)."
- **Reality:** `SubmitBody` has only `glb_base64` + `file_type` (`services/reconstruct/app/main.py:52-56`); `main.py:85` calls `reconstruct(data, file_type)` with no method. `method` is a Python-kwarg-only knob (`pipeline.py:74`); the browser client never sends one (`apps/plastiq/src/ai/reconstruct.ts:80-85`). No HTTP client can select `fitted`/`faceted`.

### 7-M1 · MEDIUM · The §6 report contract and FR-9 enums are stale

- `method` is **never** `"auto"` — it is the route taken: `"cylinder"|"sphere"|"cone"` (`pipeline.py:122`), `"revolution"` (:141), `"csg"` (:160), `"cut_cylinder"` (:183), `"fitted"` (:215), `"faceted"` (:201) — while FR-9 r2 says `method ∈ auto|fitted|faceted`.
- `primitive` also takes `"cut_cylinder"` (`pipeline.py:184`) — absent from §6's enum and from the client JSDoc (`reconstruct.ts:33`, which also still says `when method="auto"`).
- §6's report omits `surface_deviation`, `fidelity_tol`, `tangent_regions`, which are emitted on every report (`pipeline.py:53-57`); `primitive` is emitted as JSON `null` for fitted/faceted (`asdict`, `pipeline.py:66`) while the README says "(else absent)".

### 7-M2 · MEDIUM · FR-7's closure-verification chain is not what most routes run

- The full claimed chain (`NbFreeEdges()==0` + `BRepCheck_Analyzer.IsValid()` + `OrientClosedSolid` + positive volume) exists only in `cylinder_solid` (`curved_faces.py:107,125-127`, no `OrientClosedSolid`) and `freeform_capped_solid` (`freeform.py:179-192` — the **only** `OrientClosedSolid` call in the codebase).
- Sphere/cone hardcode `free_edges=0` unchecked (`curved_faces.py:143` — the literal `0` in `SolidResult(solid, is_solid, valid, 0, volume, n_faces)`); revolution likewise (`revolution.py:93`). Fitted/faceted assembly checks only `MakeSolid.IsDone()` + `IsValid()` — no free-edge count, no positive-volume check (`faceted.py:83-88`, `fitted.py:162-167`). In practice `IsValid` catches open shells (`test_pipeline.py:48-55`), but the spec's "verified, never assumed" mechanism is overstated as universal.

### 7-M3 · MEDIUM · FR-6: two named mechanisms have zero code; `GeomAPI_IntSS` never builds an edge in production

- "Tangential joins via **snapped boundary polylines**" — no snapping code exists anywhere (`grep -rn snap app/` → 0 hits). "Corners via **edge–edge intersection**" — absent.
- The `GeomAPI_IntSS` "shared-edge primitive" (`topology.py:60-77`) returns curves that are never converted into TopoDS edges in any solid; in production it is used solely as a yes/no plane-crosses-cylinder predicate (`topology.py:193`) — the actual shared edges come from `BRepAlgoAPI_Cut` (`topology.py:196-200`). The spec admits R6.9 is partial (sagitta case) but not that these two mechanisms are entirely absent.

### 7-M4 · MEDIUM · NFR-2's "no RNG machinery is needed **or present**" is now false

- `app/fidelity.py:116-119` samples with `mx.random` (categorical + uniform), seeded from a SHA-256 of the mesh (`fidelity.py:210-220`). It **is** deterministic (verified by `test_fidelity.py:43-50,152-157`), but the r2 revision-note claim drifted when M1 landed.

### 7-M5 · MEDIUM · FR-4's per-region curved collapse is whole-mesh/whole-part only

- Analytic curved faces arise only when the **whole mesh** is one primitive (`detect.try_single_primitive`, `detect.py:140-192`) or the whole part fits a special family (revolution / box±cylinder CSG / cylinder∩planes). A cylindrical *region* inside any other part becomes a freeform patch or stays faceted (`fitted.py:136-146`) — never an analytic cylinder face. §4.1 and R6.9 admit this; FR-4's own wording does not.

### 7-L · LOW (grouped)

- **Job store:** no `DELETE /jobs/{id}` route; nothing bounds concurrent CPU-bound jobs (`main.py:83-88`); eviction runs only on submit and only for terminal jobs (`jobs.py:78-90`), so a hung running job leaks forever.
- **Silent hypothesis-failure swallows:** `detect.py:161-162,179-180` (`except Exception: pass`), `csg.py:204-205`, `freeform.py:83-84,99-102` — by design these degrade to the next route (FR-8), but a genuine OCCT crash inside a route is indistinguishable in the report from a clean non-match.
- **The auto chain's terminal "→ faceted" is only fitted's internal fallback:** if `fitted_shape` itself raises, the job fails with no faceted attempt (`pipeline.py:190`; `fitted.py:148-149`) — NFR-1's "every input mesh yields a valid STEP" is aspirational at the exception boundary (§7 partially admits this).
- **Count/name drifts:** R6.9 says "7 live-OCCT pytest" for topology — `test_topology.py` has **8**; stale RANSAC docstrings (`faceted.py:5-6`, `app/__init__.py:5-6`) describe a RANSAC that deliberately does not exist; `test_fitted.py:41` is named `test_pipeline_defaults_to_fitted` though the default is `auto`; `reconstruct.ts:1` header says "SPEC-6 R6.6" for SPEC-7 work; the README's auto-chain enumeration omits the cut-cylinder route.
- **Module list drift:** §4.2 omits three shipped modules in every request's import chain — `fidelity.py` (220 lines), `recognition.py` (119 lines), `logging_setup.py`.

---

## 4. SPEC-6 — AI generation

### 6-H1 · HIGH · "The local-Ollama LLM-boundary E2E is green in CI" is structurally impossible

- **Spec claims:** §10 "run against a real local Ollama … **in CI**"; R5.3; acceptance §14.8 "green in CI".
- **Reality:** `e2e/plastiq/ai-ollama.spec.ts` is a genuine, honestly-built model-in-the-loop E2E — but it self-skips when Ollama is unreachable (`ai-ollama.spec.ts:53`), and `.github/workflows/ci.yml:59-96` never installs, pulls, or starts Ollama. In CI this test has always skipped; the acceptance criterion has never been met as written. Whether it has ever passed locally is not determinable from code.

### 6-M1 · MEDIUM · FR-5b's "preflight" is a static catalog lookup, not a probe

- `preflightModel()` (`apps/plastiq/src/ai/providers/models.ts:106-123`) looks the model up in the hardcoded `MODEL_CATALOG`; any custom model returns `supportsTools: true` plus a generic warning. No network probe, no provider metadata query (e.g. Ollama `/api/show`) ever happens — nothing is actually *preflighted*. The warning is surfaced in the UI (`SettingsPanel.tsx:64-67,156-160`), so it is not silent.

### 6-M2 · MEDIUM · The creative system prompt is dead code in the app

- `buildTurnTools` always wires `createMesh` (`agentTurn.ts:77-82`), so the paid `create_mesh` tool is always offered — but no production caller passes `creative: true` to `runGeneration` (`GenerationPanel.tsx:828-834` and `CommandPalette.tsx:107-113` omit it; default `false` at `runGeneration.ts:44`; `headless/generate.ts:121` passes `false` explicitly). `creativeSystemPrompt()` (`prompt.ts:91-97`) is reachable only from tests, contradicting `runGeneration.ts:13-14`'s own comment that the guidance is added "when the 3D-gen tool is offered". Tool surface and prompt surface have drifted apart.

### 6-M3 · MEDIUM · The always-on deterministic E2E covers less than §10/R5.2 promise

- `ai-deterministic.spec.ts:29-75` covers create, inspect, and edit with rendered-geometry assertions — no dress-up-via-predicate step, no GLB mesh-document step, no timeline/autosave assertion (`grep selector e2e/plastiq/*.spec.ts` → zero hits). Mitigation: those paths are covered by ungated vitest **integration** tests against real OCCT (`ai/tools/dressups.integration.test.ts`, `mesh/importGltf.integration.test.ts`, `buildPart.integration.test.ts`) — real, but not the promised browser E2E scope.

### 6-M4 · MEDIUM · FR-3's `OLLAMA_ORIGINS` CORS guidance is not surfaced in-product

- The in-product Ollama hint says only "Start Ollama with `ollama serve`, then pull the model" (`ai/errorHints.ts:70`); the only CORS guidance in product code is for llama-mlx (`errorHints.ts:73-75`). A CORS-blocked fetch produces a misleading "is it running?" hint. (The tool-capable-model half of FR-3 **is** surfaced.)

### 6-M5 · MEDIUM · The fal creative path has never been executed against the live API

- `meshgen/fal.ts` is a complete, real implementation of fal's queue protocol for Tripo/Meshy/Hunyuan + FLUX (`fal.ts:74-174`) — not a fake — but its own header admits "it has not been executed against the live fal API in this environment" (`fal.ts:22-23`), and the live test is keyed/opt-in (`createMesh.integration.test.ts:22`). Endpoint IDs and result field names are documentation-verified only. Acceptance §14.5 cannot be shown met.

### 6-M6 · MEDIUM · FR-19's command palette delivers a fraction of the promised surface

- FR-19 promises both panel **and** palette provide "prompt input, image attach + route choice, streaming response, a visible tool-call/build trace, and an error surface". `CommandPalette.tsx` has prompt input and a status/error line and genuinely drives the same `runGeneration` (`CommandPalette.tsx:86-127`) — but no image attach, no route choice, no streaming display (deltas accumulated silently, `:115`), no visible tool-call trace.

### 6-L · LOW (grouped)

- **L1:** Image-gen is hardwired to a single FLUX provider — `imageProvider: falImageProviders(cfg)[0]!` (`meshGenDeps.ts:38`; `fal.ts:253-255`) vs decision 6's "pluggable, multi-selectable" for image providers.
- **L2:** The usage meter is per-run, not a running session total — a fresh `UsageMeter` per generation (`GenerationPanel.tsx:732`, `CommandPalette.tsx:84`); the palette's meter is displayed nowhere.
- **L3:** First-run chooser has no Ollama auto-detect — the button blindly saves `qwen2.5 @ localhost:11434` (`GenerationPanel.tsx:97-105`) vs §6.8/R-10 "detect-and-use".
- **L4:** FR-11's "planar/cylindrical" hint shipped as `"planar" | "curved"` (`inspectGeometry.ts:32`); stale provider-union comments at `SettingsPanel.tsx:16` and `settings.ts:14` omit `llama-mlx`.

---

## 5. SPEC-11 — NeRF service (most genuinely implemented; integration gaps)

### 11-M1 · MEDIUM · No E2E exists for the NeRF path, while §6 invokes "the reconstruct precedent"

- §6 says the `.tsx` is "e2e-only … matching the reconstruct precedent". The reconstruct precedent *includes* a real browser E2E (`e2e/plastiq/reconstruct.spec.ts`); nerf has none — zero nerf/photos3d hits across all 35 `e2e/plastiq/` specs. The un-mocked browser→`services/nerf` path has never been driven anywhere. (The spec's "reachability is structural" admission is itself accurate.)

### 11-M2 · MEDIUM · UI "Cancel" never cancels the server job; `DELETE /jobs/{id}` has zero consumers

- Server implements and tests DELETE (`services/nerf/app/main.py:183-189`; `tests/test_api.py:123-138`), but `packages/nerf/src/client.ts` issues only POST/GET (its sole "DELETE" appearance is a doc comment at `client.ts:37`), and the panel's Cancel only aborts client-side polling (`GenerationPanel.tsx:377`). A cancelled capture keeps training on the M4 Max to completion. Flagged in `docs/audits/FableFindings.md:83` on 2026-07-03; the apiKey half was fixed, this half was not.

### 11-M3 · MEDIUM · Image↔frame pairing is purely positional; `frames[].file_path` is ignored everywhere

- Server pairs `images[i]`↔`frames[i]` (`main.py:144-151`); the parser drops `file_path` (`app/data_processing/dataparser.py:49`); the panel submits the multi-select `FileList` in browser order with only a count check (`GenerationPanel.tsx:304-315,333-336`). `grep file_path` across dataparser/main/GenerationPanel → zero functional hits. If picker order ≠ frames order, poses silently misassign and training produces garbage with no error.

### 11-M4 · MEDIUM · Server-side 401 auth is implemented but untested

- `NERF_API_KEY` auth is real (`main.py:55,72-74`, `Depends` at 123/184; open when unset), and the *client* header behavior is well tested — but no Python test sets `NERF_API_KEY` and asserts 401/200 (`grep NERF_API_KEY services/nerf/tests` → empty). `_API_KEY` is read at import time (`main.py:55`), which is monkeypatch-hostile; `require_auth` compares with non-constant-time `!=`.

### 11-L · LOW (grouped)

- **Hash-grid + PDF sampler unreachable in the served product** (see P2): every `/train` job runs a frequency-encoded, coarse-only model (`engine/pipeline.py:63-68` hardcodes the config; no wire field exposes the alternatives).
- **Reported `psnr` is held-IN**: `engine/pipeline.py:71-75` computes PSNR on a sample of the *training* rays (its own comment says "held-in") while the client doc calls it "Final held-out PSNR in dB" (`packages/nerf/src/types.ts:34`) — an optimistic quality signal. (The *tests* use genuinely held-out views: `tests/test_training.py:35`, `test_surface.py:105`.)
- **§5 "frozen" table drift:** undocumented 429 concurrency response (`main.py:138-142`); `POST /train` responds `JobView` (adds `error: null`); the service README's API table omits the DELETE row.
- **"NeuS" is actually VolSDF-only:** `app/models/neus.py` ships `VolSDFModel` (Laplace-CDF, `neus.py:33-47`); no logistic s-density NeuS exists. Disclosed in the module docstring; §2's table and the wire enum keep the name.
- **Mesh-fidelity assertion satisfiable by the untrained init:** the 0.6<r<1.5 bound in `test_surface.py:119-122` also holds at IGR geometric init (`test_exporters.py:52-58` asserts the identical bound untrained); only the PSNR floor genuinely proves training. Candidly disclosed in the test file (`test_surface.py:10-14`).
- **No UI knobs** for `method`/`iters`/`grid_res` — every capture uses server defaults (`GenerationPanel.tsx:356-360`); the wire supports them.
- **"reuses capture pinhole" (§2) is convention-reuse, not code-reuse** (`app/data_processing/rays.py:1-25` reimplements it).

---

## 6. SPEC-9 — Authoring extensions

### 9-H1 · HIGH · `.assy` input is a tested island — no human or agent can get a `.assy` into the app

- **Spec claim:** §assembly "(M4 · shipped)" — "a declarative document **a human or the AI agent can write**"; `parseAssy` validates AI-authored JSON.
- **Reality:** `parseAssy` and `realizeAssembly` have **zero non-test callers** (repo-wide grep). The only production import of `assy.ts` is `app/BomSection.tsx:9` — and only for `assemblyToAssy` (export). No file-open path, no UI action, no AI tool references `.assy`. The plan file admits it (`docs/plans/2026-06-21-expanse-ref-integrations.md:179,200-201` — "`.assy` file import/export UI (pending)"; M4.5 unchecked); SPEC-9 says "shipped" with no such disclosure.

### 9-M1 · MEDIUM · `plan_part`'s recorded plan is write-only

- `onPlan` is optional (`toolDefs.ts:111`), invoked at `toolDefs.ts:164` — and neither production runner passes it (`agentTurn.ts:77-82`; `headless/nodeBuild.ts:180-184`). The validated `PlanGraph` is discarded; the comment "so the trace/UX can show it" (`toolDefs.ts:110`) describes UX that doesn't exist. Mitigations: tool calls appear in the generic trace (args truncated to 200 chars, `GenerationPanel.tsx:847-853`) and the plan stays in the model conversation, so plan-conditioning of later turns is real.

### 9-M2 · MEDIUM · The voxel "honest scope" is stale in the flattering-to-nobody direction — the deferred UI **shipped**

- SPEC-9 §voxel says the rendering/editing UI and mode-shell wiring are "deferred" and `VoxelDoc` is "not yet a member of `PersistedDoc`". Both statements are now false: commit `0883c96` (2026-07-03) shipped the full voxel-sculpt mode — `PersistedDoc = CadDocument | MeshDoc | VoxelDoc` (`store/types.ts:84`), `three/VoxelSculpt.tsx` (render + click-sculpt + drag-paint + undo/redo) mounted at `three/Scene.tsx:185-192`, Sculpt workspace + `VOXEL_ACTIONS` (`actions/registry.ts:340-385`), full open/save/autosave/recovery routing (`projectsStore.ts:88-161,252`), plus two modules the spec never mentions (`voxel/voxelStore.ts`, `voxel/glb.ts`). ADR-0010 was amended for this; SPEC-9 was not reconciled in the same change. Not deceptive about capability (it *under*states) — but the spec is inaccurate today, as is its "14 tests" suite description (accurate only for the three originally-cited files).

### 9-L · LOW (grouped)

- **Cycle guard is a silent fallback:** a cyclic sub-assembly ref is emitted as a leaf part named after the sub-assembly (`assy.ts:159-164`) and counted as a leaf in the BOM (`assy.ts:177-179`); `parseAssy` performs no cycle detection, so a cyclic doc parses cleanly with surprising semantics rather than a descriptive error. No cycle test exists (`assy.test.ts` covers 9 other cases).
- **`assemblyToAssy` round-trips instances only:** `mates`, `joints` (`model.ts:62-66`), and `fixed` (`model.ts:30`) are silently dropped (`assy.ts:190-201`) — arguably by schema design, never stated by the spec.
- **Stale header:** "Status: In progress (M4 shipped)" contradicts the spec's own §planning-ir "(M5 · shipped)" and the now-shipped M10.

---

## 7. SPEC-10 — Capture & completion

### 10-M1 · MEDIUM · `services/photogrammetry/` — empty, untracked, unreferenced (see P3)

All files 0 bytes, empty `app/`/`tests/`, created 2026-07-03 23:23, referenced by nothing. Cannot overclaim (it asserts nothing) — but it is unstarted, unspecced work sitting in the tree, and by name it contradicts SPEC-10's twice-stated "photos → posed point cloud is COLMAP's job, not built here."

**Update 2026-07-04 (later same day):** no longer unspecced — the build decision was made and
`docs/specs/SPEC-13-photogrammetry-service.md` defines the service (own-MVG SfM + MLX plane-sweep
MVS, :8004); SPEC-10/ADR-0007/ADR-0006 carry the dated reversal notes this finding asked for. Still
**unstarted** (the scaffold remains empty until SPEC-13 P0).

### 10-M2 · MEDIUM · The "real-dataset checkpoint" escape hatch has no producer

- Loading works (`services/capture/app/main.py:125-130`, `net.load_weights(ckpt)`), but nothing in the repo can **produce** a checkpoint: zero `save_weights` calls anywhere in `services/capture` (grep: `load_weights` at `main.py:128` is the only weights-IO), no real-data training script, no dataset loader — `fit_completion` hardcodes the synthetic sphere sampler (`completion_mlx.py:104`). The spec admits the *data* is needed, not that the *tooling* is absent. The checkpoint branch also has zero test coverage (no test sets `CAPTURE_COMPLETION_CHECKPOINT`).

### 10-L · LOW (grouped)

- **No aggregate concurrency bound:** `main.py:34-38` promises "a single unauthenticated submit must not be able to exhaust memory/compute", but `running_count()` (`jobs.py:91-93`) is test-only; N parallel submits each start a full MLX fit thread; `MAX_POINTS` bounds one request, not the aggregate. No `DELETE /jobs/{id}`, so panel Cancel abandons the poll while the server keeps computing.
- **`app/geometry.py` (M6) is an island** — real, tested MLX math with no endpoint/CLI/caller (see P2); ADR-0006 scopes it to "the math only", but the spec's "from a depth scan via `app/geometry.py`" phrasing implies a working input path.
- **`tests/test_geometry.py:8` lacks the `importorskip` gate** every other MLX test file has — on non-Apple hardware it errors at collection instead of skipping.
- **Zero test coverage** for the `settings-capture-url` field / `captureBaseURL` override (`SettingsPanel.tsx:222-224`; `GenerationPanel.tsx:511-525`) — an asymmetry with the NeRF pattern the spec says it mirrors (`SettingsPanel.nerfkey.test.tsx` exists; no capture equivalent).
- **Trivia:** `MIN_POINTS` lives in `packages/capture/src/types.ts:14`, not `pointcloud.ts` as the spec places it; `test_sdf_mlx.py:1`'s docstring says "SIREN" for a Softplus/IGR MLP (`sdf_mlx.py:26-29` explicitly contrasts itself with SIREN); the "~6 s / ~2 s" timings are described, not asserted (fit *quality* is asserted).

---

## 8. SPEC-8 — Feature recognition (most honest spec; three real gaps)

### 8-M1 · MEDIUM · Spec names "scipy connected-components"; code uses a hand-rolled union-find + an undeclared MLX dependency

- §5: "fixed 5°/20° thresholds, **scipy connected-components**, fixed traversal." Reality: `services/reconstruct/app/recognition.py:39-62` is a custom Python union-find (its own docstring at `recognition.py:13,41`: "connected components is a Python union-find (MLX has no equivalent)"); the dihedral math runs in `mlx.core` (`recognition.py:19,74-77`) — an MLX dependency SPEC-8 never mentions. Determinism itself holds (first-seen root relabeling :41; sorted labels :106). Also a third fixed threshold the spec omits: `CURVED_SPREAD_DEG = 10.0` (`recognition.py:28`).

### 8-M2 · MEDIUM · `tangent_regions` dead-ends before the user ("honest UX" unfulfilled)

- §4 says the field exists "for honest UX (NFR-4)". It is computed on every route (`pipeline.py:97,128,147,166,189,224`) and typed on the client (`reconstruct.ts:29`) — and the only consumer, `GenerationPanel.tsx:196-211`, never renders it. §6's literal claim (type surface) is met; §4's purpose is not.

### 8-M3 · MEDIUM · Centroid-string face-id resolution can silently mis-wire topology for concentric geometry

- `packages/cad/src/mesh/tessellate.ts:166-167` keys face-id lookup by `centroid.join(",")` with a `?? -1` fallback (:191-192). Two distinct faces with an identical area centroid (real case: inner/outer lateral walls of a shelled tube) collide — last-inserted wins, edges record the wrong adjacent face. Downstream `topology.ts:80` maps `idA===idB || id<0` → `"smooth"`, so convex/concave selectors silently drop such edges and `growTangentFaces`/`faceAdjacency` traverse the wrong face — deterministic, but deterministically wrong for that geometry class, with no counter (unlike `droppedFaces`/`droppedEdges`) and no shelled/concentric-part test. (Mechanism verified in code; not executed at runtime.)

### 8-L · LOW (grouped)

- MLX is a hard import inside a Linux Docker image (same chain as 7-H1) — SPEC-8 silent on it.
- `tests/test_recognition.py:41-43` soft-passes (silent `return`) if the `domed_box.glb` fixture disappears — the fixture exists today, and the cylinder test independently asserts curved detection.
- `environment.yml:23`'s "deterministic by seed" comment describes seeding that doesn't exist (the math is seedless-deterministic — harmless, sloppy).

---

## 9. Test-count reconciliation (spec claims vs live measurement)

| Suite | Spec/plan claim | Measured during this investigation |
| --- | --- | --- |
| `services/reconstruct` pytest | "93 pytest passing as of 2026-07-03" (SPEC-7 header) | **93 passed** (live run, `plastiq-reconstruct` env, 6.18 s; 15 files, 91 functions + 2 from a ×3 parametrize). CI runs **92** (one documented platform-numerics deselect, `ci.yml:130-132`) |
| `test_topology.py` | "7 live-OCCT pytest" (R6.9) | **8** test functions |
| `services/nerf` pytest | "53 tests … passes" (SPEC-11 §6) | **53 collected, 53 passed, 0 skipped** (live run, `plastiq-nerf` env, 12.91 s). Caveat: 12 of 13 files gate on `importorskip("mlx.core")` — on non-Apple hardware only ~6/53 would run; in CI only `tests/test_jobs.py` runs (`ci.yml:134-135`) |
| `services/capture` pytest | (28 implied by suite docs) | **28 passed** (live run, 16.19 s, real MLX training incl. the missing-hemisphere completion assertion). In CI only `tests/test_jobs.py` runs (`ci.yml:133`) |
| SPEC-9 vitest surface | "14 tests" (§voxel) | 14 accurate for the three cited files; the voxel surface now has ~8 more test files (76/76 pass across the 10 SPEC-9-related files) |
| `packages/nerf` vitest | plan: 6 | 8 (auth tests added) — pass |

The CI workflow itself is candid about the MLX limits (`ci.yml:98-120`) — the *specs* are what lag.

---

## 10. What is verified genuine (why the absence of worse findings is meaningful)

- **SPEC-6:** three real streaming tool-calling adapters (`providers/anthropic.ts:172-235`, `openaiCompatible.ts:174-228`, `llama-mlx.ts:53-75`); truly atomic `build_part` (validate → SI → off-thread worker build probe → only then apply — `ai/tools/buildPart.ts:52-94`, seam at `agentTurn.ts:65-75`); real `TaggedMesh` enumeration in `inspect_geometry` (`inspectGeometry.ts:110-153`); 12 selectors resolved fresh each worker rebuild (`predicates.ts:19-35`, `rebuild.ts:122-136`); real fal queue-protocol client with paid-confirm gating (`createMesh.ts:119-252`); kind-discriminated `MeshDoc` across idb/sqlite/memory with main-thread GLTF render (`store/types.ts:57-88`, `three/Viewport.tsx:443-462`); per-project conversation persistence wired end-to-end (`conversation.ts:35-78`, `projectsStore.ts:249-418`); cancellation propagates to real fetch aborts (`anthropic.ts:216`, `openaiCompatible.ts:208`); FR-9a unit display shipped (`app/PropertiesPanel.tsx:106-116`). No TODO/FIXME/stub markers anywhere in `ai/`, `mesh/`, `viewport/`, `select/`.
- **SPEC-7:** the pipeline, closed-form fits (SVD/Kåsa/Eberly — `primitives.py:53-149`), analytic solids with exact shared rims (`curved_faces.py:92-127`), revolution/CSG with exact-volume self-validation (`revolution.py:40-116`, `csg.py:104-246`), MakeFilling freeform with accuracy ladder (`freeform.py:54,114-119`), the SCD fidelity metric (real ported code, `fidelity.py` + ADR-0001), and the auto chain order (`pipeline.py:104-190`) are all real. The pytest suite has **no skip machinery** — a missing OCCT hard-fails collection, so "93 passing" cannot be hollowed out by skips. The sagitta contrast test exists as claimed (`test_cylinder.py:73-99`).
- **SPEC-8:** substrate math implements the documented tests exactly (`topology.ts:36-89`); `TaggedEdge.faceIds` is required and populated (`tagged.ts:63`, `tessellate.ts:207`); selectors wired through worker and AI prompt (`rebuild.ts:122-137`, `prompt.ts:76-81`); TS tests run the real 17.9 MB vendored OCCT WASM.
- **SPEC-9:** parse/realize/BOM math is real (correct Hamilton product, `model.ts:104-113`); `plan_part` is wired into both real runners and listed first (`toolDefs.ts:44-50`, `agentTurn.ts:77`); the voxel core is a genuine dense-grid + Amanatides–Woo DDA implementation, fully wired into the (shipped) sculpt mode and the Convert-to-CAD handoff (`registry.ts:324-338`).
- **SPEC-10:** the IGR SDF network, eikonal-via-`mx.grad` losses, PointNet completion, and marching-cubes extraction are real and *really train* (`sdf_mlx.py:38-103`, `completion_mlx.py:38-116`); the missing-hemisphere completion assertion is genuine (`test_completion_mlx.py:30-39`); the browser parsers implement every documented format edge case (`pointcloud.ts:36-171`); the panel wiring matches the spec claim-for-claim (`GenerationPanel.tsx:458-618`).
- **SPEC-11:** real multi-resolution *hash* encoding (forced collisions at 256³ vs 2^14 tables, `encodings.py:42-93`), real inverse-CDF importance sampling (`ray_samplers.py:31-54`), real second-order eikonal gradients (`base_surface_model.py:81-82`), real Laplace-CDF VolSDF (`neus.py:33-47`), training that measurably learns on held-out views (`test_training.py:32-47`), and a §5-conformant API + client pair (`main.py:77-189`; `client.ts:39-96`).

---

## 11. Open questions (not determinable from code)

1. Whether `docker build` of `services/reconstruct` fails at env-create or the container crashes at uvicorn import (either way unusable per the repo's own MLX-on-Linux note) — confirming requires building the ≈4.7 GB image (7-H1).
2. Whether `ai-ollama.spec.ts` or the R6.7 browser E2E have ever passed against live backends since the M1/M2c changes — no automated record exists (6-H1, 7-M "browser E2E").
3. Whether any of the three fal `create_mesh` modes has ever produced a real mesh end-to-end (6-M5), and whether `thinking: { type: "adaptive" }` + the curated model IDs work against the live Anthropic API (opt-in keyed test only).
4. What `services/photogrammetry/` is intended to become (10-M1) — if it proceeds, SPEC-10's "COLMAP's job, not built here" scope statements need the same dated decision-reversal note the browser client got. — **Answered 2026-07-04:** build; SPEC-13 authored and the reversal notes added.
5. Whether the SPEC-8 centroid-collision hazard (8-M3) reproduces at runtime on a shelled/concentric part — the mechanism is unambiguous in code; a runtime repro was not attempted.
6. Whether `surface_deviation` is bit-identical across Apple-Silicon MLX and `mlx[cpu]` Linux (SPEC-7 NFR-2 cross-platform) — CI proves the suite passes on Linux with one deselect, not score equality.
7. Whether the completion-training tooling gap (10-M2) is deliberate deferral or oversight — the spec's "point it at a real dataset" phrasing reads as if tooling exists.

---

## 12. Resolution log (2026-07-04)

Same-day remediation after the audit above. The changes below almost entirely **wire the P2 dead-seams** (`.assy` import, `plan_part`'s `onPlan`, every `DELETE /jobs/{id}`, the nerf hash-grid/importance knobs, `tangent_regions`, capture `geometry.py`, and the three dead SPEC-6 exports), **de-theater P1** (a real no-mock nerf browser E2E now exists and the Ollama/reconstruct E2E claims are relabeled local-not-CI, honestly), and **repair the P3 Docker/MLX break** (7-H1). What is left open is the P3 `services/photogrammetry/` scaffold (a pending user decision), the FR-6 general surface-intersection topology tail, the by-design `.assy` mate/joint drop, and the live-execution of the paid/keyed backends (fal / keyed-Anthropic / live-Ollama) — code-real here, never driven against the live services in this pass. Every **Fixed** row below was re-verified against code (file:line cited); every **Reconciled (docs)** row was checked to carry a dated 2026-07-04 note in its spec; every **Open** row was confirmed still open.

### 12.1 SPEC-7 — mesh→B-rep (§3)

| id | status | what shipped / where |
| --- | --- | --- |
| 7-H1 | **Fixed** | `services/reconstruct/Dockerfile:16` installs `pip install "mlx[cpu]"` into the `plastiq-reconstruct` env (rationale `:11-15`); `README.md:172` now reads "**Verified locally (2026-07-04)**", `:225` descopes the hosted deploy. Docker can start again. |
| 7-H2 | **Fixed** | `method` is a real request param: `app/main.py:75` `method: Literal["auto","fitted","faceted"] = "auto"` on `SubmitBody`, threaded at `:108/:112`; client sends it (`ai/reconstruct.ts:76,104`). |
| 7-M1 | **Reconciled (docs)** | SPEC-7 r3 note (`SPEC-7-mesh-reconstruction.md:17`) rewrites the §6 report contract + FR-9 enums to the real route names (`cylinder/…/cut_cylinder/fitted/faceted`) and documents `surface_deviation/fidelity_tol/tangent_regions`. |
| 7-M2 | **Fixed** | uniform closure: `app/closure.py:64` `verify_closure` (real `count_free_edges` `:43`) is called by every solid route; `free_edges` now flows from `rep.free_edges` (`curved_faces.py:116,120,133`, `revolution.py:89`, `csg.py:250`, `topology.py:206`, `fitted.py:172,175`, `faceted.py:93,96`, `freeform.py:227`) — the hardcoded literal `0` is gone. |
| 7-M2b | **Fixed** | `csg.py:38,247` and `topology.py:42,200` both import + call `closure.verify_closure`. |
| 7-M3 | **Reconciled (docs)** + **Open** | r3 admits the tail is partial (`SPEC-7:69`) and names `GeomAPI_IntSS` (`topology.py:37,67`) as the reusable foundation — but the two named mechanisms (snapped boundary polylines, edge–edge corners) are still 0 code (`grep -rn snap app/` → 0). Analytic-rim general case still falls to faceted (see 12.7 Open). |
| 7-M4 | **Reconciled (docs)** | r3 corrects NFR-2's "no RNG present": fidelity samples `mx.random` seeded from a SHA-256 of the mesh — deterministic, but present. |
| 7-M5 | **Reconciled (docs)** | r3 reconciles FR-4: per-region curved collapse is whole-mesh/whole-part only; a curved *region* inside a mixed part stays freeform/faceted. |
| 7-L1 | **Fixed** | `DELETE /jobs/{id}` (`main.py:139`); `RECONSTRUCT_MAX_CONCURRENT_JOBS`→`429` (`main.py:50,91-97`); running-job TTL eviction (`jobs.py:95-108`). |
| 7-L2 / 7-L2b | **Fixed** | `attempted: list[RouteAttempt]` on the report (`pipeline.py:91,161`); freeform-region errors now surface in fitted's recorded attempt (`pipeline.py:283-288`). |
| 7-L3 | **Fixed** | fitted→faceted exception fallback (`pipeline.py:277-282`); analytic routes also degrade route-to-route (`:145-147`) — closes NFR-1's exception-boundary gap. |
| 7-L4 | **Fixed** | RANSAC docstrings are now accurate *negative* statements (`app/__init__.py:6`, `faceted.py:8` "deliberately no RANSAC"); `test_fitted.py:41` renamed `test_pipeline_default_auto_falls_through_to_fitted_for_a_box`; `reconstruct.ts:1` header now says "SPEC-7"; stale per-file topology count folded into the global "122". |

Suite: 120 `def test_` + a 3-way `@pytest.mark.parametrize` (`test_cylinder.py:37`) = **122 collected** — matches the r3 header ("122 pytest passing", `SPEC-7:11`). (Not re-run in this pass; count verified by inspection.)

### 12.2 SPEC-6 — AI generation (§4)

| id | status | what shipped / where |
| --- | --- | --- |
| 6-H1 | **Reconciled (docs)** | SPEC-6 r4 (`SPEC-6-ai-generation.md:14`) states the Ollama LLM-boundary E2E is a **local**, self-skipping test (`ai-ollama.spec.ts:53`), **not** a CI gate (`:47-50,719-721,744-748,847-848`) — the "green in CI" overclaim is retracted. |
| 6-M1 | **Fixed** | real preflight probe: `probeModelCapabilities` (`ai/providers/models.ts:271`) does `POST /api/show` (`:176-188`) + a tool-capability chat probe (`:220-224`) via injectable `fetchImpl`, superseding the static catalog lookup. |
| 6-M2 | **Fixed** | creative prompt now ships when `create_mesh` is offered: `runGeneration.ts:58` `opts.creative ?? offersCreateMesh(opts.tools)` → `creativeSystemPrompt()` (`prompt.ts:91`) is reachable in production. |
| 6-M3 | **Fixed** | `ai-deterministic.spec.ts` extended: selector-predicate dress-up (`:109,134`), GLB mesh-doc render (`:144,147-148`), timeline + autosave-across-reload (`:178,215-257`). |
| 6-M4 | **Fixed** | `ai/errorHints.ts:93` emits `OLLAMA_ORIGINS='…' ollama serve` CORS guidance for the ollama provider. |
| 6-M5 | **Reconciled (docs)** + **Open** | r4 annotates §14.5: the fal client is real but "has **not** been executed against the live fal API in this environment" (`fal.ts:23,266`); acceptance stays unproven pending a FAL key (see 12.7 Open). |
| 6-M6 | **Fixed** | command palette reaches FR-19 parity: image attach (`CommandPalette.tsx:40,70`), route toggle (`:71`), live streaming + tool-call trace (`:261-296`), error surface (`:323`), image-model selector (`:78`) — drives the same `runGeneration` (`:269`). |
| 6-L1 | **Fixed** | 3 selectable fal image models: `falImageProviders()` (`fal.ts:269-282`) returns flux-schnell/flux-dev/fast-sdxl; wired in `meshGenDeps.ts:14,50` and both UIs. |
| 6-L2 | **Fixed** | running session-total usage: `ai/usage.ts:17` + `sessionUsage` store slice, rendered in panel (`GenerationPanel.tsx:1454-1458`) and palette (`CommandPalette.tsx:562-569`). |
| 6-L3 | **Fixed** | first-run chooser auto-detects Ollama (`GenerationPanel.tsx:143` `await detectOllama()`) instead of blindly saving. |
| 6-L4 | **Fixed** | previously-dead exports now imported by production: `isFirstRun` (`GenerationPanel.tsx:1301`), `proxyKeyResolver` (`registry.ts:34`), `geometryClientProbe` (`agentTurn.ts:78`); cylindrical-face hint wired (`inspectGeometry.ts`, panel `:327`); stale `llama-mlx` provider-union comments corrected. |

### 12.3 SPEC-11 — NeRF service (§5)

| id | status | what shipped / where |
| --- | --- | --- |
| 11-M1 | **Fixed (code)** * | real no-mock browser E2E `e2e/plastiq/nerf.spec.ts` (browser → NerfCaptureSection → `@plastiq/nerf` → HTTP → live MLX training → GLB → MeshDoc → viewport, reachability-gated `:22,29`). *Live green-run attested by SPEC-11 §136 + the orchestrator (M4 Max, 2026-07-04); **not re-run in this pass** — see 12.7 caveat. |
| 11-M2 | **Fixed** | Cancel now issues DELETE: `client.ts:118` `cancelJob` (`method:"DELETE"` `:124`) + `onJob` (`:78`); panel wires it (`GenerationPanel.tsx:526,621,645-647`). |
| 11-M3 | **Fixed** | filename-based image↔frame pairing: `ai/framePairing.ts` (+ `framePairing.unit.test.ts`), used by the panel instead of picker order. |
| 11-M4 | **Fixed** | request-time key + constant-time compare: `main.py:63-66` reads env per-request, `secrets.compare_digest` (`:90`)→401 (`:93`); new `tests/test_auth.py` (4 tests: 401 missing/wrong, 401-before-404, 200 correct, open-when-unset). |
| 11-L (hash-grid/importance) | **Fixed** | wired end-to-end: `types.ts` (`encoding:"hashgrid"`, `importanceSamples`) → `client.ts:66,98` → `main.py:115-124` (TrainBody + hashgrid∧neus 422 guard) → `engine/pipeline.py:58,95,96` reads them. |
| 11-L (held-in PSNR) | **Fixed** | `engine/pipeline.py:36` `_holdout_split` (disjoint, seeded, held out before training); reported `psnr` evaluated on held-out rays (`:117,134`). |
| 11-L (frozen §5 table) | **Reconciled (docs)** | SPEC-11 reconcile (`:10`) records the 429 cap + true `JobView` `/train` response + additive fields (`:85`) in §5. |
| 11-L (NeuS is VolSDF) | **Reconciled (docs)** | `SPEC-11:42-44` states the model is VolSDF (Laplace-CDF), enum stays `"neus"` for the family name. |
| 11-L (mesh assertion) | **Fixed** | `tests/test_surface.py:107` now trains, extracts a mesh, and asserts the mean \|r−1\| error at least halves vs the untrained init (`:136`). |
| 11-L (no UI knobs) | **Fixed** | NerfCaptureSection exposes method/iters/grid_res/encoding/importanceSamples (`GenerationPanel.tsx:504-604`). |
| 11-L (pinhole reuse) | **Reconciled (docs)** | `SPEC-11:32` clarifies the ray code reimplements the capture pinhole *convention*, not code-reuse. |

### 12.4 SPEC-9 — authoring extensions (§6)

| id | status | what shipped / where |
| --- | --- | --- |
| 9-H1 | **Fixed** | `.assy` import path built + wired: `actions/registry.ts:376` `import-assy` / `:383` `export-assy`; `importAssyText` (`:162-170`) calls `realizeAssembly(parseAssy(JSON.parse(text)))` → `loadAssemblyModel`; `AssemblyTree.tsx:376-381,453-458` buttons. `parseAssy` now has a real non-test caller. |
| 9-M1 | **Fixed** | `onPlan` wired in **both** runners: `agentTurn.ts:91-95` (with `appendTrace({kind:"plan",…})` `:94`) and `headless/nodeBuild.ts:188-195` (captures `committedPlan` into the session report); trace kind declared `conversation.ts:16`; panel `formatPlanGraph` (`GenerationPanel.tsx:89,1140`). |
| 9-M2 | **Reconciled (docs)** | SPEC-9 status now "Shipped (M4 + M5 + M10)" (`:3-4`); §voxel is "(M10 · shipped)" (`:103`) and states the ADR-0010-deferred three.js render/edit/mode-shell "all shipped" (`:129-130`) — the stale "deferred" text is gone. |
| 9-L (cycle guard) | **Fixed** | `assy.ts:102` `assertAcyclic` (throws naming the path, `:107`), invoked `:127`; cycle tests `assy.test.ts:23-38` (self + transitive) + diamond-legality `:45`. |
| 9-L (assemblyToAssy drop) | **Open (by-design)** | `assemblyToAssy` (`assy.ts:211`) still round-trips instances only — `mates`/`joints`/`fixed` are dropped by schema; a `.assy` export→import loses them. Not targeted this pass. |

### 12.5 SPEC-10 — capture & completion (§7)

| id | status | what shipped / where |
| --- | --- | --- |
| 10-M1 | **Open** (decision resolved) | `services/photogrammetry/` is still `?? ` untracked — 4 zero-byte files (`.dockerignore/.gitignore/pyproject.toml/README.md`) + empty `app/`,`tests/`. Nothing shipped; the user decision arrived later on 2026-07-04: **build** — SPEC-13 authored (spec only; no code yet). |
| 10-M2 | **Fixed** | completion-training CLI: `app/train_completion.py` (`net.save_weights` at `:168` intermediate, `:219` final); checkpoint round-trip + `CAPTURE_COMPLETION_CHECKPOINT` serving branch tested (`tests/test_train_completion.py:95,108,125,127`). |
| 10-L (concurrency / DELETE) | **Fixed** | `DELETE /jobs/{id}` (`main.py:266`); `CAPTURE_MAX_CONCURRENT_JOBS`→429 (`main.py:48,159,221`). |
| 10-L (geometry.py island) | **Fixed** | wired via `POST /points-from-depth` (`main.py:103-106,146`) using `app/geometry.py` (unproject + gradient normals). |
| 10-L (importorskip) | **Fixed** | `tests/test_geometry.py:9` `pytest.importorskip("mlx.core")` — no longer errors at collection off-Apple. |
| 10-L (capture-url tests) | **Fixed** | `ai/SettingsPanel.capture.test.tsx` (4 cases: default/prefill/persist+reload/clear) + `GenerationPanel.capture.test.tsx`. |
| 10-L (trivia) | **Fixed (doc)** / residual | the "SIREN" docstring is gone from `test_sdf_mlx.py`; `MIN_POINTS` still lives in `packages/capture/src/types.ts:14` (spec-placement trivia, unchanged, harmless). |

Suite: **43** `def test_` in `services/capture/tests` (matches the claim; not re-run this pass).

### 12.6 SPEC-8 — feature recognition (§8)

| id | status | what shipped / where |
| --- | --- | --- |
| 8-M1 | **Reconciled (docs)** | `SPEC-8:3` "reconciled 2026-07-04"; `:86-92` documents the hand-rolled Python union-find + `mlx.core` (`recognition.py:19,39-53`) as a hard runtime dep — explicitly "not scipy". |
| 8-M2 | **Fixed** | `tangent_regions` now reaches the user: `GenerationPanel.tsx` MeshConvertSection (`:284`) reads `report.tangent_regions` (`:330`) and appends "N tangent region(s)" to the convert-to-CAD status line (`:341`), guarded for older servers. |
| 8-M3 | **Fixed** | collision-safe face-id resolution: `mesh/tessellate.ts:165-189` buckets by centroid then disambiguates with OCCT `face.IsSame` (`:184`) + an `unresolvedEdgeFaces` counter (`:173,187,283`); real-OCCT shelled-tube test `tessellate.collision.test.ts` asserts `unresolvedEdgeFaces===0` and distinct inner/outer wall ids. |
| 8-L (soft-pass / env comment) | **Fixed** | `tests/test_recognition.py:42-45` now `pytest.skip(...)` explicitly (not a silent `return`); `environment.yml:23-24` comment corrected ("recognition math is seedless; fidelity seeds from a SHA-256"). |

### 12.7 Still open (verified honestly)

- **10-M1 · `services/photogrammetry/`** — empty, untracked scaffold; nothing built. By name it contradicted SPEC-10's twice-stated "photos → posed point cloud is COLMAP's job, not built here." **Decision made 2026-07-04 (later same day): build** — SPEC-13 defines the service and SPEC-10/ADR-0007/ADR-0006 carry the dated reversal notes. The build itself remains open (SPEC-13 P0 not started).
- **7-M3 / FR-6 general topology tail (SPEC-7 R6.9)** — a cylindrical *region* inside a mixed part, and the analytic-rim sagitta case, still fall through to the faceted baseline. The `GeomAPI_IntSS` primitive (`topology.py:37,67`) is the reusable foundation, but the snapped-polyline and edge–edge-corner mechanisms are not built (`grep -rn snap app/` → 0). Partial, tracked in the spec.
- **9-L `.assy` mate/joint/fixed drop** — by-design schema limitation of `assemblyToAssy` (`assy.ts:211`); export→import is lossy for those fields. Not a defect the spec claims otherwise, but still real.
- **Live-execution of paid/keyed backends (open questions, not defects)** — the fal creative path (6-M5), the keyed-Anthropic `create_mesh`/thinking path, and the live-Ollama LLM-boundary E2E are all code-real and honestly labeled, but **were never driven against the live paid/keyed services in this pass**. Likewise **11-M1's live green-run** on the M4 Max is attested by SPEC-11 §136 + the orchestrator; the E2E *file* is code-verified here, but the run itself was not reproduced in this verification pass.

### 12.8 Tally

**37 findings fixed in code** (each re-verified against the file:line cited above), **~10 reconciled in the specs' dated 2026-07-04 notes**, **4 tails left open** (the `photogrammetry` scaffold — whose build-vs-scaffold *decision* was resolved later the same day: build, per SPEC-13; the code tail stays open — the FR-6 general-topology tail, the by-design `.assy` mate/joint drop, and the live-execution of the paid/keyed backends). No new simulated/deceptive code was introduced; the audit's central negative finding (no faked core geometry) still holds.
