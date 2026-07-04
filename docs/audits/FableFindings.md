# FableFindings — What stands between Plastiq and a finished, polished, user-ready product

**Date:** 2026-07-03
**Branch audited:** `code-review-fixes` (17 commits ahead of `main`, plus 3 uncommitted modified files)
**Method:** `/lore:deep-code-investigation` — six parallel read-only investigation agents (editor app, cad+sim kernel, Expanse packages, Python services, desktop+benchmark, distribution/ops), every load-bearing claim independently re-verified against the actual code with `file:line` evidence, and **all test suites run live this session** rather than trusted from docs.

> **Resolution (2026-07-03, same session).** This audit was acted on immediately.
> A verified sub-agent swarm resolved the P0–P3 items on branch `code-review-fixes`
> (each fix committed individually after the orchestrator re-ran its tests):
> ground/fixed now lowers to the sim manifest (§1.1); the full joint vocabulary is
> implemented-or-loud across all four backends with rapier's rotated-hinge and
> MuJoCo's loop-closure fixed (§1.3–1.4); `extrudeToFace` is a true up-to-face trim
> (§1.2); the residual OCCT leaks, poisoned init memos, and hull perf are fixed
> (§2.1); the NeRF client authenticates and the capture service got a browser client
> + panel (§1.5–1.6); a **PolyForm Noncommercial** LICENSE, THIRD-PARTY-NOTICES, and
> OCCT license text landed (§3.1); the desktop shell is wired and the lockfile CI
> break is closed (§3.2/§5); a self-host Docker/nginx path + `docs/deploy.md` exist
> (§3.3); the app-shell got an error boundary, capability guard, unsaved-changes
> prompt, ⌘S, delete-confirm, and a loading overlay (§2); the coverage gate now
> measures the React layer (§7); the BOM panel and a full **voxel-sculpt mode** are
> mounted (§6); services got bounded job stores, logging, and a Python CI job (§4);
> the open Medium/Low review findings are cleared (§8.1); and the docs are
> reconciled (§7, this pass). Final gate: workspace typecheck + lint clean, **1474
> vitest** passed (3 skipped), **69 Playwright e2e** passed, services **93 / 28 / 53**
> pytest, `cargo check` clean, production build clean. Remaining by design: the
> operator-only benchmark run (official GT access) and the empty future-scaffold
> dirs. Individual `§`-references above point into the original findings, preserved
> verbatim below.

---

## 0. Executive summary

**Plastiq is a fully client-side, parametric, in-browser CAD editor** — sketch → constraint-solved profile → ordered B-rep feature history on a real OCCT/WASM kernel → 3D face/edge/vertex selection → assemblies with mates and joints → physics simulation under gravity (MuJoCo default) → SQLite persistence with crash recovery — plus a tool-using AI generation agent (local Ollama or BYO Anthropic key), a creative text/image→mesh path, and three self-hosted Python services (mesh→B-rep reconstruction, MLX NeRF photo capture, MLX point-cloud capture/completion) that all funnel into one marquee action: **Convert to CAD**.

**The verdict: the engine is finished; the product wrapper is not.** Every suite is green (typecheck clean; **1134 unit/integration tests passed**, 3 skipped — all keyed live-service tests; **71/71 Playwright no-mock e2e tests passed**; services: **reconstruct 86, nerf 53, capture 22 pytest passed**, all run this session). All ten Critical/High code-review findings previously flagged in `Review.md` are fixed on this branch with regression tests. What remains clusters in five layers, ordered by user impact:

1. **A small set of user-visible functional gaps** — the worst being that the "Fix (ground)" toggle never reaches the physics manifest, so every simulated assembly free-falls (§1.1).
2. **The distribution/legal layer is entirely absent** — a public GitHub repo with **no license**, redistributing LGPL-family WASM with no attribution, no release process, no hosting story, no out-of-app user docs (§3).
3. **App-shell resilience** — no error boundary, no browser-capability guard, no unsaved-changes prompt (§2).
4. **Ops packaging for the services** — three conda envs, three terminals, no one-command bring-up, unbounded job stores, zero logging (§4).
5. **Loose ends** — an untouched Tauri desktop scaffold that the committed lockfile already references (a fresh-clone CI break), seven empty scaffold directories, four built-but-unmounted feature islands, 17 open Medium/Low review findings, and a spread of documentation drift (§5–§8).

---

## 1. Functional gaps a real user will hit (highest priority)

### 1.1 "Fix (ground)" grounds nothing in simulation — assemblies free-fall ⚠ *most impactful finding*

Verified first-hand end-to-end:

- The manifest schema supports static bodies: `ManifestBody.fixed?: boolean` — "A fixed body is static (does not fall)" (`packages/cad/src/lower/manifest.ts:32`), and every sim backend honors it (e.g. `packages/sim/src/backends/mujoco.ts:10-11`).
- But **`exportForSim` can never emit it**: `bodies.push({ id, mass, com, orientation, colliders })` at `packages/cad/src/lower/export.ts:67-73` — no `fixed`; `grep fixed` over `export.ts` and `component.ts` returns zero hits. Neither `Body` nor `Component` carries a static flag (`packages/cad/src/lower/component.ts:13-38`).
- The editor's "Fix (ground)" toggle (`apps/plastiq/src/app/AssemblyTree.tsx:402`) sets `AssemblyModel.instances[].fixed` (`apps/plastiq/src/assembly/model.ts:30`), which only anchors the **mate solver** (`model.ts:212`); `lowerAssembly` drops it when building components (`apps/plastiq/src/worker/lower.ts:54-65`), and the manifest goes unpatched into `new Simulator(...)` (`apps/plastiq/src/three/Viewport.tsx:301-305`).
- Consequence: every body in a user-lowered assembly is dynamic — the "grounded" part falls under gravity with everything else. The only manifests containing static bodies are hand-written test fixtures (`packages/sim/src/backends/fixtures.ts:57,71,85`).
- Corroborating test gap: `apps/plastiq/src/worker/lower.test.ts:23` sets `fixed: true` on an instance and never asserts anything about `manifest.bodies[*].fixed`.

**Needed:** a `fixed` path from instance → `lowerAssembly` → `Component`/`Body` → `exportForSim` → manifest, plus a lowering test that asserts it.

### 1.2 `extrudeToFace` is a centroid approximation shipped under a full feature's name

`packages/cad/src/action/extrude.ts:84-91`: pad height = distance from the sketch plane to the target face's **area centroid** — its own comment says "EXACT only when the target is a planar face perpendicular to the extrude direction … it does not truly terminate on the face." A user extruding "up to" an angled or curved face gets a flat-topped pad that over/undershoots. There is **no test** for an angled target (the documented approximation is untested).

**Needed:** either a true up-to-face trim, or a UI/doc surface that names the limitation where the user invokes it — plus a test pinning whichever behavior ships.

### 1.3 Joint vocabulary: 4 of 6 joint kinds never reach physics

`JointKind` declares `revolute | prismatic | cylindrical | fixed | ball | planar` (`packages/cad/src/assembly/solver.ts:44-50`), but only `revolute`/`fixed` are lowerable (`packages/cad/src/lower/joints.ts:29-31`); the manifest constraint vocabulary is `"hinge" | "fixed"` only (`packages/cad/src/lower/manifest.ts:36`). The app *does* surface skips (`apps/plastiq/src/worker/lower.ts:68-74`, `AssemblyTree.tsx:447-448`) — a surfaced limitation, not a silent one — but a user's slider/cylindrical/ball/planar joint simply doesn't articulate in sim.

**Needed:** either lower the remaining kinds (prismatic at minimum) or present them as "not simulatable" at creation time, not only at lowering time.

### 1.4 Backend-specific silent physics degradations

- **Rapier silently mis-simulates rotated hinges.** `packages/sim/src/backends/rapier.ts:63-69` documents it cannot express a world-axis hinge between differently-oriented bodies — and builds the joint anyway with world values, **emitting no runtime warning**. The integration suite deliberately excludes rapier from rotated-hinge coverage (`packages/sim/src/constraint-frame.integration.test.ts:88-96`). MuJoCo being the default (`packages/sim/src/prediction.ts:26`) routes around it — but the backend remains user-selectable, producing wrong physics with zero signal.
- **MuJoCo drops loop-closing hinges** (e.g. a four-bar linkage): `packages/sim/src/backends/mujoco.ts:131-135` — `console.warn` only; the hinge vanishes from the dynamics. Fixed loop-closers get a `<weld>` (`:129-130`); hinge loop-closers have no equivalent.
- All four backends warn-and-drop constraints naming missing bodies **console-only** (`ammo.ts:122-127`, `rapier.ts:51-55`, `cannon.ts:56-60`, `mujoco.ts:81-85`) — the app never surfaces these to the user (the app source itself contains zero `console.error`/`console.warn`, so console is not a channel any UI reads).
- `PhysicsEngine`'s interface doc still claims plain "interchangeable backends" with no note on any divergence (`packages/sim/src/engine.ts:1-3,28-43`) — open Review.md finding #16.

**Needed:** a warning channel from backends to the UI (the manifest/spawn path), a rapier in-UI caveat or delisting for rotated-hinge assemblies, and honest interface docs.

### 1.5 NeRF service auth locks out its own client

Verified first-hand: the server enforces optional bearer auth — `NERF_API_KEY` + `require_auth` (`services/nerf/app/main.py:50-56`) — but `@plastiq/nerf` sends only `Content-Type` (`packages/nerf/src/client.ts:53`); `NerfOptions` has no key/header knob (`packages/nerf/src/types.ts:50-64`) and the app has no NeRF key setting. Setting `NERF_API_KEY` makes the editor unable to talk to the service at all. Related contract drift: `DELETE /jobs/{id}` (`main.py:153-159`) is absent from SPEC-11's frozen §5 contract table (`docs/specs/SPEC-11-nerf-service.md:56-66`) and the client never calls it — browser cancel is abort-only (`client.ts:63`).

**Needed:** an API-key option threaded client → settings → request header, and the SPEC-11 contract table updated (per its own "must not diverge" rule).

### 1.6 The capture service is unreachable from the product

`services/capture` (`/capture` point-cloud→watertight-GLB and `/complete` partial-scan completion; 22 tests green) has **no browser client, no settings entry, no UI** — deliberate per `docs/specs/SPEC-10-capture-and-completion.md:27-29`, but the practical consequence is that a real user needs hand-rolled curl JSON posts of Nx3 float arrays to use it, then manual GLB import. It even ships CORS middleware for browser callers that don't exist (`services/capture/app/main.py:31-33`).

**Needed (product decision):** either a client+panel mirroring the N11 `@plastiq/nerf` pattern, or explicit "external tool" positioning in user-facing docs.

---

## 2. Editor resilience & polish (the app-shell layer)

All verified first-hand by grep/read on the current tree:

| Gap | Evidence | Consequence |
| --- | --- | --- |
| **No React error boundary** | zero `ErrorBoundary`/`componentDidCatch`/`getDerivedStateFromError` hits in `apps/plastiq/src` | any render-time crash white-screens the app, even though recovery *data* sits in storage |
| **No browser-capability guard** | zero WebGL/`WebAssembly`/storage feature-detection in app source (all WebGL hits are three.js internals) | unsupported browser ⇒ raw exceptions, not a friendly message |
| **No `beforeunload` unsaved-changes prompt** | zero handlers in `apps/plastiq/src` | tab-close protection rests entirely on the 500 ms-debounced recovery snapshot (`apps/plastiq/src/persistence/projectsStore.ts:24-27,56-62`); edits inside that window are silently lost |
| **Poisoned init memos brick the kernel on transient failure** | worker: `ocPromise ??= initOcct(...)` with no catch-and-reset (`apps/plastiq/src/worker/geometry.worker.ts:17-18`); same pattern `packages/cad/src/oc/init.ts:61-66` and `packages/cad/src/sketch/solver.ts:64-74`. The V-HACD loader was explicitly fixed for exactly this ("Don't poison the memo", `packages/cad/src/lower/decompose.ts:32-38`) — the other three are oversights, not policy | one transient wasm-fetch failure disables geometry/sketching until full reload |
| **Loading is text-only** | multi-MB wasm boot and long OCCT rebuilds show only the word "building" in the status bar (`apps/plastiq/src/three/Viewport.tsx:182,192`) | no spinner/progress affordance anywhere |
| **No ⌘S** | global keydown covers ⌘K, undo/redo, Esc, mode keys 1-4 only (`apps/plastiq/src/app/App.tsx:79-128`) | autosave mitigates for named projects; untitled docs have no keyboard save |
| **One-click project delete, no confirm** | `apps/plastiq/src/app/ProjectsMenu.tsx:106-113` | destructive, irreversible (open finding #25) |
| **Sketch-drag performance** | full wasm `solve()` per `pointermove` and zero memoization in the 1238-line `apps/plastiq/src/sketch/Sketcher.tsx` (`:1010-1015`, `:1081-1083`) | the one open perf issue users will *feel* (open finding #15) |
| **AI error ergonomics** | provider failures surface as raw strings — e.g. browser `Failed to fetch` when Ollama isn't running — with no translation or retry affordance (`apps/plastiq/src/ai/GenerationPanel.tsx:554-570,583-584`) | first-run local users hit this immediately |
| **AI transcript not replayed** | visible transcript is component `useState` (`GenerationPanel.tsx:437`); history *is* persisted and fed to the model (`apps/plastiq/src/ai/aiStore.ts:62-91`) but never re-rendered on reopen | returning users see an empty panel although the AI remembers the conversation |
| **No health pre-check on service calls** | mesh-convert and NeRF sections submit blind; a down service yields a generic fetch error in-panel (`GenerationPanel.tsx:165-167,309-311`) | fine mechanics, rough wording |

For balance — what already meets a shipping bar (verified): first-run Welcome overlay with workflow + keyboard cheat-sheet, reopenable via "?" (`apps/plastiq/src/app/Welcome.tsx`, `ribbon/TopBar.tsx:17,58`); state-based error surfacing everywhere (zero console-only paths in app source); document+sketch undo/redo with gizmo-drag coalescing; crash-recovery banner with Recover/Discard (`App.tsx:25-59`); first-class cancellation on all long jobs (AbortController threaded through AI, convert, NeRF); paid cloud jobs gated behind an explicit confirm modal (`ai/PaidJobConfirmModal.tsx`).

### 2.1 Residual OCCT error-path leaks (kernel)

The systematic leak-fix campaign (ammo backend, dressup/loft/boolean failure paths — all confirmed fixed, guarded by `packages/cad/src/action/cleanup.unit.test.ts`) missed a few spots:

- `Sketch.toWire` has no try/finally — a `Standard_Failure` mid-loop (collinear arc points `packages/cad/src/sketch/sketch.ts:109-110`, spline fit `:127-134`) leaks the wire-maker and all accumulated edges; the circle path doesn't validate r>0 (`:66-83`). Reachable from AI-authored sketches.
- Zero-axis vectors leak temporaries: `revolve` (`packages/cad/src/action/revolve.ts:23-25`), `rotate`/`mirror` (`packages/cad/src/action/transform.ts:33-50`, no try/finally at all).
- `importStep` throws on a null shape **without** deleting the handle (`packages/cad/src/io/index.ts:49-50`) — the one violation of the kernel's own convention (cf. `boolean.ts:22-24`).
- The only swallowed catch in either kernel package: bare `catch {}` around per-edge tessellation (`packages/cad/src/mesh/tessellate.ts:189-191`) — silently yields an unpickable edge and can leak `fB` (`:171-174`).

---

## 3. Distribution, legal, and release — the missing productization layer

The repo is **public** (`github.com/LayerDynamics/plastiq`). Facts, verified:

### 3.1 Licensing (sharpest gap in the whole audit)

- **No LICENSE, COPYING, or NOTICE file anywhere in the project** (root and every owned package), and **no `license` field in any owned `package.json`** (root, `apps/plastiq`, `packages/cad`, `packages/sim`, `packages/nerf`). All are `private: true`, so npm never publishes them — but the public GitHub repo defaults to all-rights-reserved while shipping copyleft-adjacent artifacts.
- The **trimmed OCCT wasm** (17 MB, `packages/cad/vendor/occt/plastiq-occt.wasm`) is a derived binary of **LGPL-2.1** OCCT (`opencascade.js@2.0.0-beta` license field: LGPL-2.1-only) redistributed in-repo and in the built bundle — and its vendor dir carries **no license text at all**: `packages/cad/vendor/occt/` contains only `.js/.wasm/.d.ts/PROVENANCE.md`, and PROVENANCE.md has **zero** mentions of "license" or "LGPL" (verified by grep).
- `@salusoft89/planegcs` (FreeCAD PlaneGCS) is **LGPL-2.0-or-later** and its wasm also ships in the bundle.
- The **model to copy already exists in-repo**: `packages/sim/vendor/mujoco/` carries both `LICENSE` (Apache-2.0) and a provenance note; `packages/cad/vendor/vhacd/` likewise (BSD-3-Clause).

**Needed:** a project license decision, LICENSE at root + `license` fields, a THIRD-PARTY/NOTICE attribution file covering OCCT/planegcs/MuJoCo/V-HACD/sql.js/ammo/rapier/cannon, and license text in the OCCT vendor dir. (Facts documented; the license *choice* is the owner's.)

### 3.2 Release engineering

- **0 git tags**, no CHANGELOG, no release or publish workflow; versions are placeholders (root `0.1.0`, app `0.0.0`).
- CI (`.github/workflows/ci.yml`) is genuinely good — SHA-pinned actions, typecheck → lint → coverage-gated tests → build, plus a separate no-mock Playwright e2e job — but is **JS/TS only**: the 161 Python service tests (86+53+22) never run in CI, and `.github/` contains nothing else (no CODEOWNERS, templates, dependabot, SECURITY.md, CONTRIBUTING).
- **Fresh-clone CI hazard, verified first-hand:** the committed `pnpm-lock.yaml` declares an `apps/desktop:` importer (HEAD line 54, introduced by commit `e99894a`) while `apps/desktop/` is **untracked**. Both CI jobs install with `pnpm install --frozen-lockfile` (`ci.yml:31-32,72-73`); on a clone without the untracked dir, the workspace project set won't match the lockfile importers — a frozen-lockfile mismatch failure. Either commit the scaffold or remove the importer.

### 3.3 Hosting & delivery

- **No deployment story exists**: no host config (netlify/vercel/wrangler/Docker-for-the-app), no deploy docs, no CDN/compression configuration. The built app is **33 MB raw / ~8.5 MB gzip-critical** (OCCT 17 MB→5.3 MB gz, MuJoCo 8.7 MB→2.2 MB gz, sql.js 644 KB, planegcs 496 KB) — server compression config is currently nobody's job.
- **No COOP/COEP anywhere — deliberately unnecessary** (the vendored wasm is single-threaded by choice, `packages/sim/vendor/mujoco/PROVENANCE.md` explicitly not vendoring the `./mt` build), but that constraint is documented nowhere a deployer would look; flipping to threaded wasm later would silently require cross-origin isolation.
- **No PWA/offline support** (no manifest, no service worker) — an ironic gap for a product whose marquee claim is "runs entirely in the browser" with an offline-capable Ollama path.
- No favicon / `public/` dir (`apps/plastiq/index.html` head is charset/viewport/title only).
- Vite `base` is default `/` — subpath hosting would break asset URLs (`apps/plastiq/vite.config.ts`).

### 3.4 User-facing documentation

`docs/` is developer-only (adr/investigations/plans/research/specs). There is **no user guide, tutorial, FAQ, or standalone shortcut reference** anywhere. Onboarding exists solely in-app (the Welcome overlay — good, but nothing a prospective user can read before installing). The root README is developer-oriented and partially stale (§7).

### 3.5 Security/privacy posture (facts)

- BYO API keys stored **plaintext in IndexedDB** (`apps/plastiq/src/ai/settings.ts:4-8,22,35-38`), password-type inputs, an explicit in-UI disclosure, and a designed-but-unbuilt `KeyResolver` proxy seam (`settings.ts:84-95`). Both providers use `dangerouslyAllowBrowser: true` (`ai/providers/anthropic.ts:190`, `openaiCompatible.ts:190`) — documented as intentional (user's own key, user's chosen endpoint).
- No telemetry of any kind (verified). No CSP (no server layer to set one). No SECURITY.md/disclosure policy.

---

## 4. Services ops (reconstruct · nerf · capture)

All three are **feature-complete against their specs with live-verified green suites** — the gaps are operational:

| Concern | reconstruct (:8000) | capture (:8001) | nerf (:8002) |
| --- | --- | --- | --- |
| Bring-up | conda env + uvicorn, documented | same (no env exists on this machine yet) | same |
| One-command startup | **none anywhere** — no compose file, no justfile service targets; 3 envs, 3 terminals | ← | ← |
| Docker | Yes (`Dockerfile`, image ≈4.7 GB — hosted deploy deferred by SPEC-7 D-6) | **No** | **No** (stray `.dockerignore` implies abandoned intent; MLX/Metal container rationale undocumented) |
| Job store | **unbounded** in-memory dict, full STEP text retained until restart (`services/reconstruct/app/jobs.py:33-53`) | **unbounded**, identical (`services/capture/app/jobs.py:32-53`) | bounded + TTL-evicting (`services/nerf/app/engine/jobs.py:44-91`) — the model to copy |
| Logging | **zero `logging` usage in any service** (uvicorn access log only) | ← | ← |
| Auth | none | none | optional bearer — but locks out the client (§1.5) |
| Input caps | base64-validity only | ≥16 points but **no upper bound on N** | comprehensive caps (`main.py:32-37`) |
| Job persistence | none — a restart loses all jobs mid-poll | ← | ← |
| Health endpoint | `GET /health` ✓ | ✓ | ✓ |

**The one open engineering remainder in reconstruction:** SPEC-7 R6.9's general per-region surface-intersection tail + analytic-rim sagitta case (`docs/specs/SPEC-7-mesh-reconstruction.md:254`) — organic/mixed-curved regions stay *valid* but fall back to dense faceted output, exactly as the docs honestly state.

---

## 5. The desktop app: an empty scaffold already leaking into the build

`apps/desktop/` (untracked) is a byte-stock `create-tauri-app` template: the "Welcome to Tauri + React" greet demo (`apps/desktop/src/App.tsx:6-49`), exactly one Rust command `greet` (`apps/desktop/src-tauri/src/lib.rs:2-5`), placeholder identity (`productName`/`identifier` both `"desktop"`, `tauri.conf.json:3-5`), template Cargo metadata (`authors = ["you"]`), and **zero references to Plastiq** — `grep -rn "plastiq"` across the app returns nothing; no `@plastiq/*` dependencies (`apps/desktop/package.json:12-17`). Nothing in the justfile, README, or docs mentions it.

Yet it is already load-bearing in two bad ways: the `apps/*` workspace glob makes it a workspace member on every `pnpm install`, and the **committed lockfile references it while git doesn't track it** (§3.2 — the fresh-clone CI break).

**Needed for a real desktop distribution** (if that's the intent): point Tauri at `@plastiq/app`'s build (`tauri.conf.json:6-11` `frontendDist`/`devUrl`), real identity/icons, native surfaces worth a shell (file dialogs for STEP import/export), and resolution of the lockfile inconsistency. Alternatively: remove it and regenerate the lockfile. Right now it is pure liability.

---

## 6. Built-but-unwired islands and empty scaffolding

**Islands — real, tested code that no production path reaches** (each verified; none degrade the product, all are latent value):

| Island | Evidence | Deferral record |
| --- | --- | --- |
| BOM panel (M4 `.assy`/auto-BOM) | `apps/plastiq/src/assembly/BomPanel.tsx` — only importer is its own test (verified) | `docs/adr/0004:39` |
| Voxel-sculpt mode (M10) | `voxel/{grid,pick,doc}.ts` + tests exist; `VoxelDoc` explicitly "not yet a member of `PersistedDoc`" (`apps/plastiq/src/store/types.ts:68,83`, verified); zero imports outside `voxel/` | ADR-0010 |
| Capture depth front-end (M6) | `services/capture/app/geometry.py` imported only by its test; `/capture` takes oriented points, never calls it | ADR 0006 |
| Capture service as a whole | no browser client (§1.6) | SPEC-10:27-29 |
| Dead SVG view-cube pair | `apps/plastiq/src/viewport/ViewCube.tsx` + `cubeView.ts`, zero production importers; the live cube is the drei gizmo (`three/gizmos/viewCube.gizmo.tsx`, mounted `three/Scene.tsx:224`) | Review.md #22 — needs a wire-or-remove decision |

**Empty scaffolding — zero files, zero references, zero git history** (verified first-hand): `packages/data`, `packages/embed`, `packages/recon`, `packages/rl`, `packages/segment`, `services/nurbs/{app,tests}`, and `apps/plastiq/src/timeline/`. The NeRF plan explicitly labels the packages "the user's future scaffolding — OUT OF SCOPE" (`docs/plans/2026-06-22-nerf-service.md:179-180`). Harmless to the build (pnpm ignores dirs without `package.json`), but anyone auditing a public repo will trip over seven empty directories.

**The Expanse effort itself is essentially complete:** every milestone M1–M10 and N0–N12 is verifiably implemented and tested (SCD fidelity metric live in the convert report; tangent/fillet-chain selectors live in kernel + worker + AI prompt; `plan_part` planning-IR live; the full MLX NeRF service + `@plastiq/nerf` client + "Capture from photos" panel live and green). Remaining Expanse work is exactly the islands above plus `recognized_holes` (only `tangent_regions` ships — `services/reconstruct/app/recognition.py:92`, `pipeline.py:57,97,101`).

---

## 7. Documentation drift (each item leaves a doc describing a state that isn't current)

- **README architecture is stale**: "a pnpm workspace of one app and two owned packages" (`README.md:24-32`) omits `packages/nerf` (a third owned package and a runtime dep of the app), `services/capture`, and `services/nerf` entirely.
- **README overstates "STEP/IGES/glTF interchange"** (`README.md:37`): IGES and glTF are **export-only** (`packages/cad/src/io/index.ts:20,41,59,94` — no `importIges`/`importGltf` exists). Review.md #26, still open.
- **Plan checkboxes contradict shipped code**: `docs/plans/2026-06-21-expanse-ref-integrations.md` leaves M1, M2, M4, M5, M6 tasks unchecked though all are implemented and tested; `docs/plans/2026-06-22-nerf-service.md` leaves N0–N7 unchecked though SPEC-11 §6 itself declares "N0–N12 complete." *(Fixed 2026-07-03: both plans reconciled against the tree — every shipped task checked with delivered-as notes; M4.5's UI half left open as genuinely unshipped, M6.2 recorded as deferred per ADR 0006.)*
- **Stale counts**: SPEC-11 claims "43 tests" vs current 53; SPEC-7 "67 pytest" (date-qualified) vs current 86; `packages/cad/vendor/occt/PROVENANCE.md:33-34` claims "288 unit + 15 browser E2E" vs current 1134/71.
- **SPEC-11 §5 frozen contract table** is missing the shipped `DELETE /jobs/{id}` endpoint — violating its own "must not diverge without updating the client + this spec together" rule.
- **Ghost references**: `.gitignore:20-22` and `apps/plastiq/vite.config.ts:9` both reference `packages/sim/src/pkg`, which no longer exists (sim wasm lives at `packages/sim/vendor/mujoco/`). *(Fixed 2026-07-03: both comments now point at `packages/sim/vendor/mujoco/`.)*
- **Coverage-config stale exclusions** (Review.md #7, the one open High): `vitest.config.ts:47` blanket-excludes `**/*.tsx` (the entire React/R3F layer is invisible to the coverage floor; e2e covers behavior but the gate can't see it); `:48` excludes `apps/*/src/viewport/SceneController.ts` **which does not exist** (verified); `:65` excludes `three/contextmenu/snapshot.ts` although `snapshot.test.ts` exists and runs in the node suite (verified) — contradicting the exclusion's own "only runs in a real browser" comment.
- `benchmark/harness/cadbench_harness/cli.py:4-5` docstring omits the registered `render` command (`cli.py:12,27`). *(Fixed 2026-07-03: `render` added to the docstring.)*
- **Internal audit documents tracked at repo root** (`Missing.md`, `Review.md`, `Expanse.md` — 85 KB combined), unreferenced by the README: a stranger cloning the public repo lands on three internal working documents. *(Resolved 2026-07-03: all root audit docs — including this file — relocated to `docs/audits/`.)*

---

## 8. Open review findings & test thin-ice

### 8.1 Review.md ledger (all 27 findings re-verified in code this session)

**Fixed on this branch, each with a regression test (10):** the Critical solved-radii-thrown-away bug (writeback now at `apps/plastiq/src/sketch/sketchStore.ts:639-661`, verified first-hand; test at `sketchStore.test.ts:242-262`); dead Measure tool; broken shift-click multi-select; ammo wasm leaks; per-frame gizmo deep-clones; swallowed persistence failures; `isSimManifest` numeric validation; OCCT failure-path leaks; per-hover bounding-sphere work; whole-DB re-serialization.

**Still open (17):** 1 High — the coverage gate (§7); 6 Medium — worker poisoned memo (§2), STEP-bloated recovery snapshots + silent quota failure (`apps/plastiq/src/persistence/recovery.ts:43-47`, `worker/rebuild.ts:433`), driven dims in the conflicts panel (`Sketcher.tsx:929-947`), sketch-drag perf (§2), undocumented backend divergences (§1.4), stale PROVENANCE counts (§7); 10 Low — including one-click delete (§2), dead view-cube pair (§6), IGES/glTF overstatement (§7), O(n²) hull dedup (`packages/cad/src/lower/hull.ts:52-57`), exact float-zero comparisons, unknown-action silent null (`ribbon/ActionButton.tsx:19-20`).

### 8.2 Green but thin ice

- **11 of 18 sketch-constraint solver mappings have no direct test** (untested: vertical, vDistance, parallel, perpendicular, equalLength, angle, concentric, tangentLineCircle, pointOnLine, pointOnCircle, symmetric — each a one-line planegcs mapping where a wrong parameter name only surfaces at runtime; `packages/cad/src/sketch/solver.ts:140-223` vs `solver.test.ts`).
- **3 of 6 mate kinds untested** (concentric, perpendicular, angle — `packages/cad/src/assembly/solver.ts:36-42`).
- **Duplicate body ids are not rejected** by either manifest validator (`packages/cad/src/lower/manifest.ts:71-113`, `packages/sim/src/manifest.ts:94-149`) — constraints would silently bind to the last same-id body in every backend's `byId` map.
- No test asserts `exportForSim` emits `fixed` (§1.1) or exercises `extrudeToFace` on an angled target (§1.2).

---

## 9. In-flight work on this branch

- **Uncommitted (3 files):** the Anthropic half of CB6.2.2 `tool_choice` — `toAnthropicToolChoice` mapping + drop-thinking-on-forced-tool (Anthropic 400s otherwise) in `apps/plastiq/src/ai/providers/anthropic.ts:36-41,196-213`, 4 new tests (suite re-run this session: 10/10 pass), and the plan doc updated to match. A complete, coherent unit — **needs only a commit**.
- **Branch state:** `code-review-fixes` is 17 commits ahead of `main` with all suites green — needs merge.
- **CADGenBench harness:** complete per plan (every CB0–CB6.3 milestone verified in code; 22 harness pytest + 11 headless tests green). What remains is **operator work, not code**: the fixture mount is currently empty (`./local` — `just bench-mount` required; note `paths.py:56-67` accepts an empty dir silently and the run exits via the produced==0 guard), a local model server must be serving, the full 81-fixture run hasn't been launched, ground truth requires either the official access request (`SUBMIT.md`) or more self-authored fixtures (the proven local loop scored 1.0/0.68 on authored GT), and no leaderboard submission has been made.

---

## 10. Boundary map (compact)

| # | From → To | Mechanism | Failure handling today |
| --- | --- | --- | --- |
| 1 | React app → geometry worker | `postMessage`, OCCT wasm in worker chunk | per-request errors surfaced; init memo poisoned on transient failure (§2) |
| 2 | App → AI providers (Ollama/Anthropic) | browser-direct SDK, streaming, AbortController | errors → transcript as raw strings; no health check/retry (§2) |
| 3 | App → reconstruct :8000 | fetch submit→poll, ~10 min cap | thrown → in-panel error; no pre-check; unbounded server job store |
| 4 | App → nerf :8002 via `@plastiq/nerf` | submit→poll ≤~20 min, abortable | in-panel error; auth gap (§1.5) |
| 5 | (nobody) → capture :8001 | — | unreachable from product (§1.6) |
| 6 | Assembly → sim backends | `SimManifest` JSON, versioned | `fixed` unlowerable (§1.1); joint skips surfaced; backend warns console-only (§1.4) |
| 7 | Harness → headless gen | subprocess `npx tsx src/headless/cli.ts` | fail-loud; fixture-mount emptiness passes silently (§9) |
| 8 | Desktop shell → app | **none** (template greet only) | §5 |

---

## 11. What "done" looks like — the prioritized needs list

**P0 — correctness a user will hit in week one**
1. Ground/fixed flag lowered end-to-end into the sim manifest (+ test) — §1.1.
2. Fresh-clone CI break: commit or excise `apps/desktop` so the lockfile and tree agree — §3.2/§5.
3. Rapier rotated-hinge and MuJoCo loop-hinge degradations surfaced in the UI (or rapier delisted for such assemblies) — §1.4.
4. NeRF client API-key support (or document that `NERF_API_KEY` is server-to-server only) — §1.5.

**P1 — legal/distribution (blocks *any* public "use this" invitation)**
5. LICENSE + package `license` fields + THIRD-PARTY/NOTICE + OCCT vendor license text — §3.1.
6. A deployment story: one supported hosting path with compression, the single-thread-wasm constraint documented, favicon, and a versioned release (tag + CHANGELOG) — §3.2/§3.3.
7. Out-of-app user documentation: a getting-started page, feature tour, shortcut reference — §3.4.

**P2 — resilience & polish**
8. Error boundary, capability guard, `beforeunload` prompt, un-poisoned init memos — §2.
9. AI error-message translation + transcript replay; service health pre-checks — §2.
10. The seven open Medium review findings, led by the coverage gate (`.tsx` exclusion + stale entries) and sketch-drag perf — §8.1.
11. Kernel error-path leaks (toWire, zero-axis, importStep, tessellate catch) + `extrudeToFace` honesty — §1.2/§2.1.

**P3 — ops & completeness**
12. Services: one-command bring-up, bounded job stores + logging on reconstruct/capture, Python tests in CI — §4.
13. Decide each island: mount the BOM panel, wire or park voxel mode, client-or-document the capture service, wire-or-remove the SVG view-cube — §6.
14. Test thin-ice: the 11 untested constraint mappings, 3 untested mates, duplicate-body-id rejection — §8.2.
15. Documentation reconciliation pass: README architecture + interchange wording, plan checkboxes, spec counts, SPEC-11 contract table, ghost `sim/src/pkg` references, root audit docs relocated or referenced — §7.
16. Desktop shell: build it for real or delete it — §5.
17. CADGenBench: mount fixtures, run the 81-fixture benchmark, obtain/author GT, submit — operator work — §9.

---

## 12. Open questions (not determinable from code)

1. **License intent** — which license for a public repo shipping LGPL-derived wasm? (Owner decision; facts in §3.1.)
2. **Is the Tauri desktop shell a real goal** or an abandoned experiment? (Zero code signal either way — §5.)
3. **Hosting target** for the browser app (static CDN? self-host? none-by-design?) — determines §3.3 scope.
4. **Should capture get a UI**, or is "external tool workflow" its permanent positioning? (SPEC-10 says the latter; §1.6.)
5. **Is rapier's rotated-hinge limitation acceptable** for a selectable backend, or should selection be constrained? — §1.4.
6. **CADGenBench ground truth** — pursue official access or scale self-authored fixtures? — §9.
7. **Root audit docs** (`Missing.md`, `Review.md`, `Expanse.md`) — keep at root, move to `docs/`, or drop from the public tree? — §7. *(Answered 2026-07-03: moved to `docs/audits/`.)*

---

*Every claim above carries a `file:line` citation read from the working tree on 2026-07-03, or a command run this session. Test evidence: workspace typecheck clean; vitest 1134 passed / 3 skipped (the skips are keyed live-service integration tests, `describe.skipIf` on `RECONSTRUCT_URL`/`FAL_KEY`); Playwright 71/71 passed; reconstruct 86, nerf 53, capture 22 pytest passed; benchmark harness 22 + headless 11 passed; anthropic provider unit suite 10/10 with the uncommitted diff applied.*
