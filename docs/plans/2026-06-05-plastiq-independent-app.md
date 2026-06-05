# Plan — Plastiq: extract CAD Studio into an independent application

**Date:** 2026-06-05
**Source findings:** `CADStudio.md` (root of this repo)
**Goal:** Turn the byte-for-byte copy of `mechx/apps/cad-studio` now living at
`/Users/ryanoboyle/cad-studio` into a self-contained, buildable, testable
application named **Plastiq** — with its monorepo dependencies vendored, its
correctness defects fixed (each with a regression test), and its E2E suite
ported.

---

## Decisions (locked)

| # | Decision | Consequence |
|---|----------|-------------|
| 1 | **Rename packages to `@plastiq/*`** | `@mechx/cad`→`@plastiq/cad`, `@mechx/sim`→`@plastiq/sim`. Rewrite all 20 `src/` import sites + `vite.config.ts` `exclude`/`external`. App scope → `@plastiq/cad-studio`. |
| 2 | **pnpm workspace, `apps/` + `packages/`** | Repo root holds the workspace; app at `apps/cad-studio`, vendored kernel at `packages/cad`, prebuilt sim at `packages/sim`, E2E at `e2e/cad-studio`. Mirrors the proven monorepo shape so `workspace:*` + relative paths resolve with minimal change. |
| 3 | **Fix all 7 defects in this plan, each with a regression test** | Milestone 5. Ships a correct app, not just a building one. |
| 4 | **Wire the OCCT trim pipeline, defer the 30–90 min build** | Carry `occt.build.yml` + `cad-occt` recipe + `build-occt.md`; keep shipping the full npm `opencascade.js` wasm. Trim run is a documented follow-up task. |
| 5 | **Sim ships frozen as a prebuilt package** | Vendor `packages/sim/src/pkg/*` (committed `mechx_sim_bg.wasm` + glue). No Rust `crates/`, no `wasm-pack` rebuild path in this repo. |
| 6 | **Fix CRITICAL 5.1 right after build-green, before the E2E port** | New Milestone 2.5 fixes the mate/joint ID-collision on the proven-green base; the E2E port (M3) then validates it. The other 6 defects stay in Milestone 5. |
| 7 | **Upgrade to `vite@8` + latest `vitest` during extraction** | Milestone 0 pins the new versions and the move + upgrade happen together. **Watch-item:** a broken build could be the move *or* the upgrade — `vite@8` is rolldown-based, so `rollupOptions`→`rolldownOptions` and `optimizeDeps` esbuild→oxc migrations are likely (see M2.4). Re-establish the ≥209 green baseline under the new versions. |
| 8 | **Rename storage keys to a `plastiq` namespace — no migration** | IndexedDB `mechx-cad-studio`→`plastiq-cad-studio` (`persistence/idb.ts:7`), localStorage `cad-studio:recovery`→`plastiq:recovery` (`recovery.ts:21`). Existing locally-saved projects/recovery are **intentionally orphaned**; accepted because there are no production users of the standalone app yet. |
| 9 | **git init `main`, one atomic conventional-commit per milestone** | Repo is not under git today (CADStudio.md §1). Initialize on `main`; commit per milestone for a reviewable history; **ask before the first commit and before any push** (no remote yet) per project policy. |

### Sources of truth (the intact monorepo — copy FROM here, never modify it)
- App original: `/Users/ryanoboyle/mechx/apps/cad-studio` (byte-identical to this dir)
- Kernel: `/Users/ryanoboyle/mechx/packages/cad` (source + `occt.build.yml` + `scripts/build-occt.md`)
- Sim: `/Users/ryanoboyle/mechx/packages/sim` (incl. committed `src/pkg/*.wasm`)
- E2E: `/Users/ryanoboyle/mechx/e2e/cad-studio` (12 specs)
- Configs: `mechx/tsconfig.base.json`, `mechx/vitest.config.ts`, `mechx/eslint.config.js`, `mechx/.prettierrc`, `mechx/playwright.config.ts` (cad-studio project at lines 50-58, webServer line 82, port 4177)

### Baseline to preserve (the correctness oracle)
In the intact original (under `vitest@4.1.7`), `pnpm -C apps/cad-studio run typecheck`
exits 0 and `pnpm -C apps/cad-studio exec vitest run` reports **24 files / 209 tests
passing**. Because we upgrade to `vite@8` + latest `vitest` during extraction
(decision 7), the **first goal after install is to re-establish this green baseline
under the new versions**. Thereafter **every milestone must keep typecheck green and
the test count ≥ 209** (Milestones 2.5 and 5 add regression tests, raising the count).

---

## Target layout

```text
plastiq/
├── package.json            # workspace root: packageManager pnpm, shared devDeps
├── pnpm-workspace.yaml      # packages: ["apps/*", "packages/*"]
├── tsconfig.base.json       # inlined from mechx (see CADStudio.md §8)
├── vitest.config.ts         # node env, workspace include globs
├── eslint.config.js         # ported from mechx
├── .prettierrc  .nvmrc  .gitignore
├── playwright.config.ts     # cad-studio project, :4177
├── justfile                 # cad-occt recipe (deferred build), help
├── apps/
│   └── cad-studio/          # the app (src/, index.html, package.json, vite.config.ts, tsconfig.json)
├── packages/
│   ├── cad/                 # vendored kernel (@plastiq/cad) + occt.build.yml + scripts/
│   └── sim/                 # vendored prebuilt sim (@plastiq/sim) + src/pkg/*.wasm
└── e2e/
    └── cad-studio/          # 12 ported Playwright specs
```

> **Working-directory note:** This plan reorganizes the current flat
> `/Users/ryanoboyle/cad-studio` into the layout above. Each move is an explicit
> task. `CADStudio.md` and `docs/plans/` stay at the new repo root.

---

## Milestone 0 — Scaffold the Plastiq workspace

**Outcome:** an empty-but-valid pnpm workspace skeleton with all shared tooling
config present, before any code moves.

- [ ] **0.1 — Decide the move strategy and create the workspace root.** From
  `/Users/ryanoboyle/cad-studio`, create `apps/`, `packages/`, `e2e/`. The
  current app files (`src/`, `index.html`, `package.json`, `vite.config.ts`,
  `tsconfig.json`, `README.md`) will move to `apps/cad-studio/` in Milestone 2.
  *Verify:* `ls apps packages e2e` succeeds.
- [ ] **0.2 — Write `pnpm-workspace.yaml`** with `packages: ["apps/*", "packages/*"]`
  (drop the monorepo's `tools/*`). *Verify:* file present, valid YAML.
- [ ] **0.3 — Write the workspace-root `package.json`.** `name: "plastiq"`,
  `private: true`, `type: "module"`, `packageManager: "pnpm@10.32.1"`,
  `engines.node: ">=20"`. devDependencies (the set absent from the app today,
  per CADStudio.md §8): `typescript`, `vitest`, `eslint`, `@eslint/js`,
  `typescript-eslint`, `@playwright/test`, `prettier`, `@types/node`.
  **Decision 7 — pin the upgraded toolchain:** `vite@^8`, latest `vitest`
  (4.x line), matching `@vitejs/plugin-react` + `@tailwindcss/vite` versions
  compatible with `vite@8`. The app's `package.json` `vite` devDep moves to `^8`
  too. *Verify:* `pnpm install` later succeeds (Milestone 2) and resolves a single
  Vite major across the workspace (`pnpm why vite` shows one v8 tree).
- [ ] **0.4 — Inline `tsconfig.base.json`** at the repo root, verbatim from
  CADStudio.md §8 (the config the app's `tsconfig.json:2` extends via `../../`).
  *Verify:* file present; `apps/cad-studio/tsconfig.json`'s `extends: "../../tsconfig.base.json"` will resolve once the app is at `apps/cad-studio`.
- [ ] **0.5 — Write `vitest.config.ts`** adapted from `mechx/vitest.config.ts`:
  `environment: "node"`, `include: ["apps/**/src/**/*.{test,spec}.ts", "packages/**/src/**/*.{test,spec}.ts"]`,
  `exclude: ["**/node_modules/**", "**/dist/**", "**/pkg/**", "e2e/**"]`, no
  `passWithNoTests`. *Verify:* config parses (used in Milestone 2).
- [ ] **0.6 — Port `eslint.config.js`, `.prettierrc`, `.nvmrc`, `.gitignore`**
  from the monorepo root (adapt globs to the new layout; drop Rust/Cargo
  ignores that don't apply; ensure `node_modules`, `dist`, `*.tsbuildinfo` are ignored).
  *Verify:* config files present and lint runs in a later milestone.
- [ ] **0.7 — Initialize git (decision 9).** `git init -b main` at the repo root
  (currently NOT a git repo — CADStudio.md §1). The cadence is **one atomic commit
  per milestone** with conventional-commit messages (`chore: scaffold workspace`,
  `feat: vendor @plastiq/cad`, `feat: rewire imports + build green`, `fix: mate/joint
  id collision`, `test: port cad-studio e2e`, `chore: rebrand to plastiq`, …).
  **Ask before making the first commit, and before any push** (no remote exists).
  *Verify:* `git status` clean boundary after each milestone's commit.

---

## Milestone 1 — Vendor the kernel (`@plastiq/cad`) and sim (`@plastiq/sim`)

**Outcome:** both dependencies live inside the repo, renamed, with the kernel's
OCCT build pipeline carried along; nothing yet wired into the app.

- [ ] **1.1 — Copy the kernel** `mechx/packages/cad/{src,scripts,occt.build.yml,tsconfig.json,README.md,package.json}`
  → `packages/cad/`. Do **not** copy its `node_modules` or `e2e/` (the kernel's
  own harness E2E is out of scope — that's `playwright.cad.config.ts`, not the
  app suite). *Verify:* `packages/cad/src/index.ts` present; `occt.build.yml`
  present.
- [ ] **1.2 — Rename the kernel package.** In `packages/cad/package.json`,
  `name: "@mechx/cad"` → `"@plastiq/cad"`. Confirm its only runtime dep is
  `opencascade.js@2.0.0-beta.b5ff984` (CADStudio.md §2.1) and keep it. Its
  `main`/`types` stay `src/index.ts` (consumed as TS source — no build step).
  *Verify:* `grep '"name"' packages/cad/package.json` shows `@plastiq/cad`.
- [ ] **1.3 — Copy the prebuilt sim** `mechx/packages/sim/{src,tsconfig.json,package.json}`
  → `packages/sim/` **including `src/pkg/mechx_sim_bg.wasm`, `mechx_sim.js`,
  `mechx_sim.d.ts`, `mechx_sim_bg.wasm.d.ts`, `package.json`**. *Verify:*
  `ls packages/sim/src/pkg/mechx_sim_bg.wasm` exists.
- [ ] **1.4 — Rename the sim package.** `packages/sim/package.json`
  `name: "@mechx/sim"` → `"@plastiq/sim"`. Add a `README`/header note that this
  is a **frozen prebuilt** (no Rust crates, not rebuildable in this repo —
  CADStudio.md §2.4). *Verify:* `grep '"name"' packages/sim/package.json`.
- [ ] **1.5 — Verify the dependency boundary stayed shallow.** Re-run the §2.1
  check inside the vendored copies: `grep -rn "@mechx/" packages/cad/src packages/sim/src`
  should return only the kernel header comment + the glTF `generator` string
  (`packages/cad/src/io/gltf.ts:59`). Rename those two cosmetic strings to
  `@plastiq/cad`. *Verify:* no functional `@mechx/*` import remains in vendored packages.

---

## Milestone 2 — Move the app, rewire imports, go build-green

**Outcome:** `pnpm install`, typecheck, the full vitest suite (≥209), and
`vite build` all pass from the standalone repo.

- [ ] **2.1 — Move the app to `apps/cad-studio/`.** Move `src/`, `index.html`,
  `package.json`, `vite.config.ts`, `tsconfig.json`, `README.md`. Leave
  `CADStudio.md` and `docs/` at the repo root. Delete the stale `dist/`
  (CADStudio.md §3 #10) and the broken `node_modules/` (every entry is a dangling
  pnpm symlink — §1). **Deleting `dist/`/`node_modules/` is destructive — confirm before running.**
  *Verify:* `ls apps/cad-studio/src/main.tsx` exists; old root no longer has `src/`.
- [ ] **2.2 — Rename the app scope.** `apps/cad-studio/package.json`
  `name: "@mechx/cad-studio"` → `"@plastiq/cad-studio"`; update its `description`.
  Change deps `"@mechx/cad": "workspace:*"` → `"@plastiq/cad": "workspace:*"` and
  same for sim. *Verify:* `grep '@mechx' apps/cad-studio/package.json` returns nothing.
- [ ] **2.3 — Rewrite all 20 import sites** `@mechx/cad`→`@plastiq/cad`,
  `@mechx/sim`→`@plastiq/sim` across `apps/cad-studio/src/` (exact sites listed
  in CADStudio.md §2: `app/AssemblyTree.tsx:9`, `assembly/model.ts:11` +
  `model.test.ts:2`, `sim/simulator.ts:11`, `sketch/{dim.test,model.test,model,sketchStore}`,
  `store/store.ts:8-9`, `viewport/dressup.ts:8`, `worker/{bridge,geometry.worker,protocol,lower,rebuild}` + their tests).
  Do it with a scoped, reviewed find/replace, then **read the diff** — do not
  blind-replace. *Verify:* `grep -rn "@mechx/" apps/cad-studio/src` returns nothing.
- [ ] **2.4 — Update `vite.config.ts`** (`apps/cad-studio/vite.config.ts`):
  `optimizeDeps.exclude` and `worker`/`build` `external` entries `@mechx/sim`→`@plastiq/sim`
  (the `opencascade.js/dist/node.js` external regex stays). Re-scope
  `server.fs.allow: ["../.."]` — from `apps/cad-studio` the repo root is still
  `../..`, so this likely stays correct; **verify the dev server can serve
  `packages/sim/src/pkg/*.wasm` and the opencascade dist** under the workspace.
  **vite@8 (rolldown) migration (decision 7):** the current config uses
  `build.rollupOptions` + `worker.rollupOptions` + `optimizeDeps` — under
  rolldown-vite these likely become `rolldownOptions` and the esbuild-based
  optimizer moves to oxc (the deprecation warnings already appeared when the
  monorepo ran tests through a newer Vite). Migrate the option names as `vite@8`
  requires and confirm the OCCT-node `external` regex still excludes the Node
  branch from both the main and worker builds. *Verify:* `grep '@mechx' vite.config.ts`
  empty; `vite build` emits no deprecated-option warnings.
- [ ] **2.5 — Confirm `tsconfig.json` extends resolve.** `apps/cad-studio/tsconfig.json:2`
  `extends: "../../tsconfig.base.json"` now points at the repo-root base (0.4).
  *Verify:* path resolves.
- [ ] **2.6 — Install and prove green.** `pnpm install` at the repo root (resolves
  `@plastiq/*` via workspace, installs `opencascade.js`, `three`, `react`,
  `zustand`, `sql.js`, tailwind, vite). Then:
  - `pnpm -C apps/cad-studio run typecheck` → **exit 0**
  - `pnpm exec vitest run` → **24 files / 209 tests pass**
  - `pnpm -C apps/cad-studio run build` → `tsc --noEmit` + `vite build` succeed, and the worker chunk contains the OCCT wasm.
  *Verify:* all three commands pass; capture output. If the build emits the OCCT
  wasm, sanity-check the dev server renders the seeded box (`pnpm -C apps/cad-studio run dev`).

---

## Milestone 2.5 — Fix the CRITICAL reload-corruption bug (before E2E)

**Outcome:** the mate/joint ID-collision data-corruption bug is fixed on the
proven-green base, so the E2E port that follows actually exercises a correct
save→reload, and a dedicated regression test guards it. (Decision 6.)

- [ ] **2.5.1 — Fix the ID-collision** (`apps/cad-studio/src/store/store.ts`).
  `loadDocument`'s regex `/^[fi](\d+)$/` (`store.ts:508`) ignores `m`/`j` IDs even
  though `applyMate`/`applyJoint` mint `m${nextSeq}`/`j${nextSeq}` from the shared
  counter (`store.ts:396,417`). Fix: re-derive `nextSeq` from **all** typed IDs —
  widen the class to `/^[fimj](\d+)$/` **and** include `assembly.mates` +
  `assembly.joints` IDs in the scanned set (today only `features` + `instances` are
  scanned, `store.ts:503-506`). Apply with `Edit` (surgical), not a revert.
- [ ] **2.5.2 — Regression test** (`store.test.ts`): build `i1,i2` + mate `m3`,
  `toDocument` → `loadDocument`, then `applyMate`/`addInstance` and assert the new
  ID equals none of the existing IDs (today the next mate reissues `m3` — the trace
  in CADStudio.md §5.1). Confirm it fails before the fix, passes after.
- [ ] **2.5.3 — Confirm an E2E round-trips an assembly with a mate.** Read
  `mechx/e2e/cad-studio/save-reload.spec.ts` and `assembly-to-sim.spec.ts`: if no
  spec saves→reloads a document containing a mate/joint, the §5.1 path is NOT
  covered end-to-end. In that case, extend `save-reload.spec.ts` (or add a spec) to
  insert two instances, add a mate, save, reload, add another mate, and assert no
  duplicate IDs / correct mate count. *Verify:* documented finding + spec coverage exists.
- [ ] **2.5.4 — Green + commit.** `pnpm exec vitest run` (now ≥ 210),
  `pnpm -C apps/cad-studio run typecheck`. Commit `fix: re-derive nextSeq from all
  typed ids on load` (milestone commit, after asking).

---

## Milestone 3 — Port the Playwright E2E suite

**Outcome:** the 12 no-mock E2E specs run against the standalone app on :4177.

- [ ] **3.1 — Copy the specs** `mechx/e2e/cad-studio/*.spec.ts` (12 files:
  a11y, assembly-to-sim, box-select, feature-tree, gpu-pick, layout, pick-face,
  recovery, renders-solid, save-reload, simulate, sketch-to-solid) → `e2e/cad-studio/`.
  They import only `@playwright/test` and drive the app via the global hooks
  (`__cadStudioScene`, `__cadStudioGpuPick`, `__cadStudioLower`, `__cadStudioExport`,
  `__cadStudioSimulate` — exposed in `Viewport.tsx`), so they carry no monorepo
  internal imports. *Verify:* `grep -rn "from \"\\.\\./\\.\\." e2e/cad-studio` (or
  any `@mechx`/relative-monorepo import) returns nothing.
- [ ] **3.2 — Write a standalone `playwright.config.ts`** at the repo root,
  distilled from `mechx/playwright.config.ts` to just the `cad-studio` project
  (lines 50-58): `testMatch: /e2e\/cad-studio\//`, `baseURL: "http://localhost:4177"`,
  `webServer: { command: "pnpm --filter @plastiq/cad-studio exec vite --port 4177 --strictPort", url: "http://localhost:4177", reuseExistingServer: !process.env.CI, timeout: 180_000 }`,
  generous `timeout: 300_000` (first run loads the 48 MB OCCT wasm), `workers: 1`,
  `fullyParallel: false`. Drop the client/server/viewer projects and their
  webServers. *Verify:* `pnpm exec playwright --version` works after install.
- [ ] **3.3 — Run the suite.** `pnpm exec playwright install chromium` then
  `pnpm exec playwright test`. *Verify:* all 12 specs pass (no-mock: real OCCT
  worker, real three.js render, real sql.js persistence, real `@plastiq/sim`).
  Per project policy this is the true E2E gate — it must be green, not skipped.

---

## Milestone 4 — Rebrand to Plastiq

**Outcome:** no user-facing MechX identity; docs reflect the standalone repo.

- [ ] **4.1 — `apps/cad-studio/index.html:6`** `<title>MechX CAD Studio</title>`
  → `<title>Plastiq</title>`. *Verify:* grep.
- [ ] **4.2 — Rewrite `apps/cad-studio/README.md`.** Replace monorepo paths/scripts
  (`README.md:17-19` dead `docs/specs`/`docs/adr` links; `:82-100` `pnpm -C apps/cad-studio …`,
  `packages/cad/dist`, `just wasm`) with the Plastiq layout and commands. **Excerpt
  the load-bearing parts of SPEC-5 / ADR-0013 into the repo** (CADStudio.md §7 "How
  the SPEC-5/ADR references were identified") — they live in `mechx/docs/` and were
  never copied, so the links are dead; either inline a `docs/` excerpt or drop the
  links. *Verify:* no `mechx`/`../../docs` references remain in the README.
- [ ] **4.3 — Rename the storage keys (decision 8 — rename, no migration).**
  IndexedDB `DB_NAME = "mechx-cad-studio"` → `"plastiq-cad-studio"`
  (`apps/cad-studio/src/persistence/idb.ts:7`) and localStorage recovery key
  `"cad-studio:recovery"` → `"plastiq:recovery"` (`recovery.ts:21`). **No
  migration shim** — any locally-saved projects/recovery under the old keys are
  intentionally orphaned (accepted: no production users of the standalone app).
  *Verify:* grep shows the new key strings; a fresh load creates the new DB; the
  `recovery.test.ts`/`sqlite.test.ts` suites still pass against the renamed keys.
- [ ] **4.4 — Sweep residual MechX strings.** `grep -rin "mechx" apps packages e2e --include=*.ts --include=*.tsx --include=*.json --include=*.html --include=*.md`
  and rebrand user-facing/scope occurrences (leave the kernel's internal
  algorithm comments alone unless they leak the brand into the UI). *Verify:*
  grep reviewed; no MechX text reaches the rendered app.

---

## Milestone 5 — Fix the remaining 6 correctness defects (each with a regression test)

**Outcome:** the six defects from CADStudio.md §4–§5 that remain after the CRITICAL
one (fixed in Milestone 2.5) are corrected; every fix lands with a failing→passing
test. **Per project policy: no correctness fix is complete without a regression
test.** Apply fixes surgically (`Edit`), not by reverting.

> The CRITICAL mate/joint ID-collision (former 5.1) is fixed in **Milestone 2.5**.

- [ ] **5.2 — `nextSeq` excluded from undo/redo snapshots** (`store.ts:157-167`,
  `468-491`). `snapshot()` omits `nextSeq`, so undo→re-create produces ID **gaps**
  (verified independent of 5.1 — it drives the counter too high, not too low). Fix:
  include `nextSeq` in the history snapshot/restore (or move ID minting out of
  document state). *Regression test:* `add f1` → `undo` → `addFeature` asserts the
  ID is contiguous (no skipped `f2`).
- [ ] **5.3 — Positional rollback index** (`store.ts:82,237,250,292`). `rollbackIndex`
  is a bare array index that `removeFeature` (`:237-242`) and `reorderFeature`
  (`:250-259`) never adjust (verified). Fix: store the **feature id** to roll back
  before and resolve to an index at rebuild time. *Regression test:* set rollback
  at feature X, delete an earlier feature, assert rollback still targets X.
  (Adds the first-ever `setRollback` coverage — §6 gap.)
- [ ] **5.4 — Inconsistent assembly re-solve** (`store.ts:338-356`). `addMate`/
  `removeMate` call `solveAssembly()` but `removeInstance` and `toggleInstanceFixed`
  do not, leaving stale poses. Fix: re-solve after instance removal and fixed-flag
  toggle (match the mate path). *Regression test:* mate two instances, remove one,
  assert `assemblyResult` re-solves / poses update.
- [ ] **5.5 — Silent dress-up no-ops** (`Toolbar.tsx:224-225`, builders in
  `dressup.ts:31-61`). A `null` from `filletFeature`/`shellFeature`/etc. is a
  silent no-op. Fix: when a builder returns `null` (e.g. no edges/faces picked),
  set a user-visible status message via the store's `setStatus`. *Regression test:*
  unit-test the toolbar handler/helper path that, given an empty pick set, emits a
  status string instead of silently returning.
- [ ] **5.6 — No worker timeout** (`worker/bridge.ts:42-48`). A silently hung OCCT
  op leaves the pending promise forever. Fix: add a configurable timeout in
  `GeometryClient.send()` that rejects the pending entry (and clears it from the
  map) after N seconds; surface the rejection as a rebuild error in the UI.
  *Regression test:* a fake worker that never replies causes `build()` to reject
  within the timeout (not hang).
- [ ] **5.7 — Missing `circularPattern` toolbar button** (`Toolbar.tsx` CombineMenu
  `302-368`). The feature is fully implemented in rebuild (`rebuild.ts:324-342`)
  and has a tree icon (`FeatureTree.tsx:26`) but no creation button. Fix: add a
  CombineMenu button that adds a `circularPattern` feature (mirror the
  `linearPattern` button's wiring). *Regression test:* assert clicking it adds a
  well-formed `circularPattern` feature that `rebuildDocument` accepts (an existing
  rebuild test already covers the geometry — add the store/UI wiring assertion).
- [ ] **5.8 — Minor cleanups (LOW).** (a) `SceneController.ts:130,750-756` —
  refresh `devicePixelRatio` on resize, not just size. (b) `FeatureTree.tsx`
  header — correct the "drag-free reorder" wording to match the arrow-button-only
  reality. *Verify:* typecheck + existing tests stay green (no new test needed for wording).
- [ ] **5.9 — Full green after fixes.** `pnpm exec vitest run` (now > 209),
  `pnpm -C apps/cad-studio run typecheck`, `pnpm exec playwright test` all pass.
  *Verify:* capture counts; assembly save→reload E2E (`save-reload.spec.ts`)
  exercises the 5.1 path end-to-end.

---

## Milestone 6 — Wire the OCCT trim pipeline (build deferred)

**Outcome:** the trim mechanism is in-repo and runnable; the app keeps shipping
the full npm wasm until the trim is validated.

- [ ] **6.1 — Confirm `occt.build.yml` + `scripts/build-occt.md` are present**
  under `packages/cad/` (copied in 1.1). *Verify:* both files present.
- [ ] **6.2 — Add a `justfile` (or root npm script) `cad-occt` recipe** adapted to
  the new path:
  `docker run --rm -v "$PWD/packages/cad:/src" -u "$(id -u):$(id -g)" donalffons/opencascade.js:2.0.0-beta.b5ff984 occt.build.yml`
  (from `mechx/justfile:110-112`). The image tag MUST stay pinned to the npm
  version. *Verify:* recipe present; **do not run it now** (30–90 min, several GB).
- [ ] **6.3 — Document the deferred trim** as a follow-up in the README/`build-occt.md`:
  run `just cad-occt` → move `mechx-occt.{js,wasm,d.ts}` to `packages/cad/vendor/`
  → repoint `packages/cad/src/oc/init.ts` `initBrowser` (`init.ts:41-47`, the
  `locateFile` path) at the vendored wasm → re-run full vitest + E2E → measure
  gzip ≤ 3 MB (NFR-4). Note the bundle stays ~13 MB gzip until then (CADStudio.md §2.3, §7). *Verify:* documented.

---

## Definition of Done

- [ ] `pnpm install` succeeds from a clean checkout (no monorepo, no dangling symlinks).
- [ ] Toolchain is `vite@8` + latest `vitest`; `vite build` emits no deprecated-option warnings (rolldown/oxc migration done).
- [ ] `pnpm -C apps/cad-studio run typecheck` exits 0.
- [ ] `pnpm exec vitest run` passes with **> 209** tests (re-greened baseline + new regressions).
- [ ] `pnpm -C apps/cad-studio run build` produces a working bundle (OCCT wasm in the worker chunk).
- [ ] `pnpm exec playwright test` — all 12 cad-studio E2E specs green (no mocks).
- [ ] No `@mechx/*` import or user-facing "MechX" string remains (`grep -rin mechx apps packages e2e` reviewed); storage keys renamed to `plastiq*`.
- [ ] All 7 defects fixed, each with a regression test; the CRITICAL reload-corruption path (M2.5) is covered end-to-end by an assembly+mate save→reload E2E.
- [ ] OCCT trim pipeline present and documented; full wasm shipped for now.
- [ ] One atomic conventional-commit per milestone on `main` (first commit approved by the user).

## Risks / watch-items (from CADStudio.md §7)

- **Bundle size** stays ~13 MB gzip until the deferred trim runs (M6 follow-up).
- **Upgrade bundled with the move (decision 7)** — a broken build/test could be the
  extraction *or* the `vite@8`/`vitest` upgrade. Mitigate by re-greening the ≥209
  baseline immediately after `pnpm install` (M2.6) before piling on changes; expect
  rolldown `rolldownOptions` + oxc `optimizeDeps` migrations in `vite.config.ts` (M2.4).
- **Storage-key rename orphans local data (decision 8)** — accepted; no production
  users. Flagged here so it isn't mistaken for a regression during testing.
- **Single-shared-solid assemblies** and **storage quota** are pre-existing
  limitations, explicitly **out of scope** for this plan (note them for a backlog).

## Out of scope (backlog)
- Multi-part assembly library (different solids per instance).
- localStorage/IndexedDB quota handling.
- Actually running the OCCT trim Docker build (M6 wires it; running it is a follow-up).
- The kernel's own harness E2E (`playwright.cad.config.ts`) — not the app suite.
- Storage-key migration shim (deliberately skipped per decision 8).
