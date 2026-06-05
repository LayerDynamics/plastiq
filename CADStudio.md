# CAD Studio — Independence & Completeness Investigation

> **⚠ Superseded (historical).** This document is the original investigation of
> the *extracted-but-still-mechx-dependent* copy. It has since been acted on: the
> app was rebuilt as **Plastiq** — `@mechx/cad`/`@mechx/sim` were **replaced** (not
> vendored) by `@plastiq/cad` (opencascade.js + planegcs + a first-party mate
> solver) and `@plastiq/sim` (a pluggable Rapier/ammo.js/cannon-es layer), and
> **all seven §5 correctness defects were fixed with regression tests** (see R8).
> The implementation plan and its milestone log are in
> [`docs/plans/2026-06-05-plastiq-independent-app.md`](docs/plans/2026-06-05-plastiq-independent-app.md);
> the architecture overview is in [`README.md`](README.md). Read the sections
> below as the *starting-point analysis*, not the current state of the code.

> Deep code investigation of `/Users/ryanoboyle/cad-studio`, evaluating what must
> change to run as a standalone application, and the completeness/correctness of
> the existing implementation. Every claim is cited with `file:line`. Findings
> only — no code was modified.

---

## 1. Executive Summary

**What this product is.** CAD Studio is an **Onshape-class, fully client-side
parametric CAD editor** that runs entirely in the browser: sketch a 2D profile,
build an ordered feature history (extrude / revolve / cut / loft / sweep /
fillet / chamfer / shell / draft / pattern / mirror / boolean), select
faces/edges/vertices in 3D, assemble component instances with mates and
articulated joints, persist projects to an in-browser SQLite store with crash
recovery, and **simulate the result under gravity in a real Rust physics
engine** — no server involved. It is React + Zustand + Tailwind + three.js on top
of the `@mechx/cad` geometry kernel (OpenCascade.js / OCCT WASM), which runs in a
Web Worker. (`README.md:1-15`, `package.json:6`)

**The single most important finding.** This directory is a **byte-identical copy
of `/Users/ryanoboyle/mechx/apps/cad-studio`** (verified: `diff -rq` over `src/`
and every config file reports no differences). It was lifted out of the `mechx`
**pnpm monorepo** and **every workspace seam is now broken**:

- Its two core dependencies, `@mechx/cad` and `@mechx/sim`, are declared as
  `workspace:*` (`package.json:14-15`) and resolve through **dangling symlinks**
  (`node_modules/@mechx/cad → ../../../../packages/cad` → `/Users/packages/cad`,
  which does not exist).
- **Every other dependency is also a broken symlink** into the monorepo's pnpm
  store (`node_modules/three → ../../../node_modules/.pnpm/...` →
  `/Users/node_modules/.pnpm/...`, broken). The local `node_modules` is unusable
  as-is; a fresh install is mandatory.
- The build configs reach **above the app root**: `tsconfig.json:2` extends
  `../../tsconfig.base.json` (gone) and `vite.config.ts:32` sets
  `server.fs.allow: ["../.."]` (was the monorepo root).
- **No test, lint, or formatter config exists in this directory.** `vitest`,
  `typescript`, `eslint`, `prettier`, and `@types/node` are all absent from
  `package.json` — in the monorepo they are inherited from the root.

**Empirical correctness baseline.** The original at
`/Users/ryanoboyle/mechx/apps/cad-studio` is still intact and wired. Run there
(byte-identical source), it is healthy: `tsc --noEmit` **exits 0**, and
`vitest run` reports **209 tests across 24 files, all passing** (2.7s). So the
*logic* is sound and well-tested; the work to make it independent is almost
entirely **packaging and dependency-vendoring**, plus a short list of real (but
non-blocking) code defects documented in §5.

---

## 2. The Dependency Boundary (sizes the whole "make it independent" task)

The extraction surface is **shallow and well-defined**, which is the good news.

### 2.1 `@mechx/cad` and `@mechx/sim` are the only two workspace packages

Every `@mechx/*` import in `src/` resolves to exactly these two packages
(`grep "@mechx/" src/` — 20 import sites across worker, store, sketch, viewport,
assembly, sim). Critically, **neither package imports any other `@mechx/*`
package** (`grep -rn "@mechx/" packages/cad/src packages/sim/src` returns only a
header comment and a glTF `generator` string). So vendoring **these two and only
these two** fully closes the dependency graph.

**`@mechx/cad`** (`packages/cad/package.json`) — a large TypeScript geometry
kernel (~80 source files: `action/`, `assembly/`, `sketch/`, `lower/`, `io/`,
`oc/`, `material/`, `model/`, …). It is consumed **as raw TypeScript source**
(`"main": "src/index.ts"`, `"types": "src/index.ts"`) — there is no build step;
Vite/Vitest transpile it directly. Its only runtime dependency is
`opencascade.js` (`packages/cad/package.json:13`).

**`@mechx/sim`** (`packages/sim/package.json`) — a Rust physics core compiled to
WASM. Also consumed as source (`"main": "src/index.ts"`). The WASM artifact and
its JS glue are **committed** under `packages/sim/src/pkg/` (`mechx_sim_bg.wasm`,
`mechx_sim.js`, `mechx_sim.d.ts`), so it can be vendored **frozen**.

### 2.2 What the kernel imports from CAD Studio (none — clean direction)

The dependency is strictly one-way: CAD Studio → kernel. The kernel does not
import back into the app.

### 2.3 OCCT (OpenCascade) WASM provenance

CAD Studio currently runs against the **prebuilt full `opencascade.js` from npm**
(`opencascade.js@2.0.0-beta.b5ff984`, `package.json:16`); `dist/` already contains
`opencascade.full-*.wasm` (~the 48 MB raw / 13 MB gzip artifact). The custom
*trimmed* OCCT build (`packages/cad/occt.build.yml`) is **a build mechanism that
is not yet wired**: its own header states the symbol list "is finalized once the
kernel's OCCT symbol surface stabilizes (≈ M5). Until then, development runs
against the prebuilt FULL build." **Implication for independence:** you do *not*
need the custom OCCT/Docker build to ship — the npm package works. But you
inherit the **bundle-size problem** (NFR-4 budget is ≤3 MB compressed; the full
build is ~13 MB gzip), and an independent repo that wants the trim must also carry
`occt.build.yml` + the `just cad-occt` Docker pipeline (`packages/cad/scripts/build-occt.md`).

### 2.4 `@mechx/sim` WASM rebuild capability is lost on extraction

The committed `mechx_sim_bg.wasm` is rebuilt in the monorepo via `just wasm`
against the Rust sources in `mechx/crates/`. An independent CAD Studio repo that
vendors only `packages/sim` **keeps the runnable WASM but loses the ability to
rebuild it** (no Cargo crates, no `justfile`). This is acceptable if the sim is
frozen, but must be a conscious decision and documented.

---

## 3. Independence Checklist (what must change, concretely)

| # | File / area | Current (monorepo) state | Required change for standalone |
|---|-------------|--------------------------|-------------------------------|
| 1 | `package.json:14-15` | `@mechx/cad` + `@mechx/sim` as `workspace:*`; the monorepo is **not available** | **Decided (§7):** vendor `@mechx/cad` **source** into the new repo as an owned package and carry its OCCT build pipeline (row 13); consume `@mechx/sim` as a **prebuilt** package (frozen WASM, no Rust crates). Keep them as a local workspace so they stay TS-source consumable by Vite. |
| 2 | `node_modules/` (all) | Every entry is a dangling pnpm-store symlink | Delete and run a fresh install once deps are resolvable. Nothing in the current `node_modules` survives relocation. |
| 3 | `package.json` devDeps | **Missing** `typescript`, `vitest`, `eslint`, `prettier`, `@types/node` (inherited from monorepo root today) | Add them as direct devDependencies. Without them, `build` (which runs `tsc`), the README's `vitest run`, and the lint gate cannot execute standalone. |
| 4 | `package.json:31` vs root | App declares `vite ^6`; monorepo root declares `vite ^8` + `vitest ^4.1.7`; **installed** Vite is `6.4.2` (resolved via pnpm). Tests actually run under root's `vitest@4.1.7`. | Pin a single coherent Vite/Vitest pair in the app and verify the build + tests under it (version skew is currently masked by hoisting). |
| 5 | `tsconfig.json:2` | `extends: "../../tsconfig.base.json"` (gone) | Inline the base config (captured verbatim in §8) into a local `tsconfig.base.json` or directly into `tsconfig.json`. |
| 6 | `vite.config.ts:32` | `server.fs.allow: ["../.."]` pointed at the monorepo root so the dev server could serve `packages/sim/src/pkg/*.wasm` and the opencascade dist | Re-scope `fs.allow` to wherever the vendored `packages/` live relative to the new app root. |
| 7 | Test runner config | No `vitest.config.ts` in the app; root config (`mechx/vitest.config.ts`) uses `environment: "node"` and a workspace-wide `include` glob | Add a local `vitest.config.ts`. Note the root runs in **node** env (fine for the pure-logic tests, which is all that exist — see §6). |
| 8 | Lint/format | No `eslint.config.js` / `.prettierrc` in app (live at `mechx/eslint.config.js`, `mechx/.prettierrc`) | Copy/adapt if the lint gate in `README.md:88` is to be preserved. |
| 9 | **E2E tests** | The Playwright `cad-studio` project lives in `mechx/e2e/cad-studio` (served on `:4177`, `README.md:89`) — **not copied here** | Port the E2E suite. Per project policy on real E2E, this is a prominent gap: the headline-flow, no-mock E2Es that validate render→pick→sketch→extrude→rollback→mate→sim→save-reload do not exist in this directory. |
| 10 | `dist/` | Stale prebuilt artifact from the monorepo build (`dist/assets/*` incl. two OCCT wasm hashes) | Delete and rebuild after the move; do not ship the stale bundle. |
| 11 | `index.html:6`, `package.json:1-6` | Title/scope still "MechX CAD Studio" / `@mechx/cad-studio` | **Decided (§7): rebrand to "Plastiq."** Rename scope/title/README; if the vendored package names also change (`@mechx/*`→`@plastiq/*`), update all 20 `src/` import sites + `vite.config.ts` `exclude`/`external` in lockstep. |
| 13 | OCCT build (monorepo root) | `occt.build.yml` + `just cad-occt` Docker flow trim the kernel WASM; full build shipped today | **Decided (§7): carry the custom-build pipeline.** Port the `justfile` recipe + Docker config (currently at the monorepo root, not under the app) so the bundle can be trimmed toward the ≤3 MB NFR-4 budget. |
| 12 | `README.md:17-19, 82-100` | Links point at monorepo `docs/specs/SPEC-5…`, `docs/adr/0013…`; scripts use `pnpm -C apps/cad-studio …` and reference `packages/cad/dist` + `just wasm` | Rewrite for the standalone layout; vendor or excerpt the SPEC-5/ADR-0013 docs if they are to remain the source of truth. |

**Runtime WASM resolution is safe to relocate** (verified): all three WASM assets
are resolved by Vite `?url` imports, not hard-coded paths —
`opencascade.full.wasm?url` (`worker/geometry.worker.ts:6`), `sql-wasm.wasm?url`
fed to `initSqlJs({ locateFile })` (`persistence/index.ts:6,16`), and
`@mechx/sim`'s wasm via internal `import.meta.url`. Vite fingerprints and rewrites
these at build time, so they survive a domain/path change **once the dependency
symlinks are real**.

---

## 4. Completeness — README claims vs. implementation

Every headline capability in `README.md` was traced to real, non-stub code.
**No `TODO`, no `throw "not implemented"`, no placeholder returns were found in
`src/`.** Coverage by subsystem:

**Modeling / feature rebuild** (`worker/rebuild.ts`) — **complete.** A single
`switch` over feature type handles 18 live cases: `box`, `sketch`, `extrude`
(blind / two-sided / up-to-face / along-edge), `revolve`, `loft`, `sweep`, `cut`,
`fillet`, `chamfer`, `shell`, `draft`, `transform`, `mirror`, `linearPattern`,
`circularPattern`, `boolean` (against an inline primitive *or* a recursively-built
tool subtree), `importStep`; `placement` is a deliberate metadata no-op
(`rebuild.ts:122-402`). Persisted `EdgeRef`/`FaceRef` selections re-resolve on
every rebuild so dress-up survives upstream edits (`rebuild.ts:230-253`,
test `rebuild.test.ts:166-197`). Pre-D2 sketch back-compat is handled
(`rebuild.ts:142-145`). OCCT `Solid` handles are `.delete()`d in `finally` blocks
throughout — no obvious WASM leaks.

**Sketcher** (`sketch/`) — **complete.** All 12 tools
(line/rect/rect-center/circle/3-pt-circle/3-pt-arc/center-arc/polygon/slot/spline/point/select)
are implemented as gesture state machines (`sketchStore.ts:264-549`). Full
constraint set and all five dimension kinds map to the kernel solver via
`toSolverInput` (`model.ts:235-416`), including diameter→radius halving
(`model.ts:344`) and driven-reference skipping (`model.ts:251`). Live inference,
snapping, DOF counter, three-state verdict, and **driving→driven auto-demote on
over-constraint** (`sketchStore.ts:188-202`) are all present. Geometry helpers
(circumcircle, arc-midpoint, slot outline, Catmull-Rom) were checked against their
mathematical definitions and are correct.

**Typed 3D interaction** (`viewport/`) — **complete.** Ray picking with the
triangle→render-group→`faceId` mapping (`pick.ts:17-27`), a GPU colour-id
fallback gated on a ray-bounds miss (`SceneController.ts:487-557`,
`colorId.ts` encodes `id+1` so clear-black = miss), highlight by material-slot
swap with no re-tessellation (`highlight.ts:40-77`), rubber-band box-select
(`SceneController.ts:560-644`), transform gizmo writing a parametric placement
back (`SceneController.ts:438-443` → `placement.ts`), interactive SVG view cube
with 26 regions (`ViewCube.tsx`, `cubeView.ts`), standard views + fit, measure
tool, and one `InstancedMesh` per shared assembly solid
(`SceneController.ts:237-288`).

**Assemblies** (`store.ts`, `assembly/model.ts`) — **complete.** Instance
insert/remove, six mate kinds, articulated joints (revolute/prismatic/cylindrical/
fixed/ball/planar), and a pure-TS forward-kinematics drive for motion preview
(`model.ts:118-176`). Quaternion math (Hamilton product, axis-angle) verified
correct. The 3D mate solve runs inline on the main thread via the kernel's
`solveMates` (`store.ts:448-465`) — by design, so interaction stays live.

**Persistence** (`persistence/`) — **complete.** sql.js SQLite image persisted to
IndexedDB (`sqlite.ts`, `idb.ts`); full CRUD with thumbnails; 1500 ms debounced
autosave (`projectsStore.ts:16,35-60`); **byte-identical round-trip** asserted in
test (`sqlite.test.ts:81-88`); crash-recovery snapshots (incl. untitled work) to
localStorage with a dirty flag (`recovery.ts`, `projectsStore.ts:199-212`).

**Simulate & interchange** (`sim/simulator.ts`, `worker/lower.ts`) — **complete.**
`lowerAssembly` maps instances → a `Component` hierarchy and reuses the kernel's
`exportForSim` + `lowerJoints` rather than authoring a new manifest format
(`lower.ts:54-89`); non-lowerable joint kinds are skipped and reported
(`lower.test.ts:76-103`). The simulator spawns the manifest with a **fixed seed**
(`SEED = 1n`, `simulator.ts:37`) for determinism and inverts the COM composition
on read-back (`simulator.ts:20-34`, invariant tested `simulator.test.ts:14-46`).
glTF/STEP/IGES export and STEP import are wired through the worker
(`geometry.worker.ts:85-100`).

**The one genuine completeness gap:** a **`circularPattern` toolbar entry is
missing.** The feature is fully implemented in the rebuild engine
(`rebuild.ts:324-342`) and has a tree icon (`FeatureTree.tsx:26`), but there is
no button in the toolbar to create one — `linearPattern`/`mirror`/`boolean` have
buttons, `circularPattern` does not (`Toolbar.tsx`, CombineMenu `302-368`). The
capability is reachable only by loading a document that already contains it.

---

## 5. Correctness — verified defects

The codebase is healthy (209/209 tests pass in the wired original). The following
are **real defects found by reading the code**, ordered by severity. The first
was independently re-verified against the source.

### 5.1 CRITICAL — mate/joint IDs collide after save→reload (data corruption)

A single monotonic counter `nextSeq` mints **all** entity IDs: features `f<n>`,
instances `i<n>`, **mates `m<n>`** (`store.ts:396`), and **joints `j<n>`**
(`store.ts:417`). But `loadDocument` re-derives `nextSeq` from a regex that
matches **only feature and instance IDs**:

```ts
// store.ts:507-510 (verified)
const maxSeq = ids.reduce((m, id) => {
  const n = /^[fi](\d+)$/.exec(id);   // 'm' and 'j' are NOT matched
  return n ? Math.max(m, Number(n[1])) : m;
}, 0);
```

The code comment (`store.ts:501-502`) explicitly says "features `f<n>` +
instances `i<n>`" — mates/joints were added to the shared counter later and this
function was never updated. **Repro** (initial `nextSeq` is `1`, `store.ts:184`;
the counter is global, so IDs never repeat a number across types): from an empty
doc, `addInstance` → `i1` (nextSeq 1→2), `addInstance` → `i2` (→3), `applyMate`
→ `m3` (→4); save `{i1, i2, m3}`. On reload, `maxSeq` is derived from only
`[i1, i2]` = 2, so `nextSeq = 3`; the next `applyMate` is minted `m3`,
**colliding with the persisted `m3`**. Two entities then share an ID —
`removeMate`/`jointDrive` keying break. This silently corrupts any reloaded
assembly that contains mates or joints. **It is masked by tests** because the round-trip test
(`store.test.ts:251`) and the only mate test (`store.test.ts:167`, coincident
only) never persist-and-reload a mate. *Fix direction:* match `[fimj]` (or use
per-type counters / type-tagged IDs).

### 5.2 MEDIUM — `nextSeq` is excluded from undo/redo snapshots

`snapshot()` captures only `{features, params, assembly}` (verified
`store.ts:157-167` — no `nextSeq` field); `undo`/`redo` restore from it
(`store.ts:468-491`) and never roll `nextSeq` back. After `add f1` (nextSeq→2) →
`undo` (features empty, nextSeq still 2) → `addFeature`, the new feature is `f2`,
skipping `f1`. This produces **ID gaps**, not collisions (the counter only ever
moves too *high*, the opposite direction from §5.1, so the two are independent) —
and redo restores feature objects with their original IDs from the snapshot, so
existing data is not corrupted. The effect is cosmetic/contract drift against the
file's own "deterministic, reproducible IDs" header claim (`store.ts:1-5`).

### 5.3 HIGH — rollback index is positional and not adjusted on edits

`rollbackIndex` is a bare array index (`store.ts:82`). `removeFeature`
(verified `store.ts:237-242`) and `reorderFeature` (verified `store.ts:250-259`)
both mutate the feature array and neither touches `rollbackIndex`, so the
rollback bar silently retargets a different feature after any delete/reorder.
There is **zero test coverage** for `setRollback`
(`store.ts:292`). *Fix direction:* store the feature **id** to roll back before,
resolve to an index at rebuild time.

### 5.4 MEDIUM — inconsistent re-solve after assembly edits

`addMate`/`removeMate` call `solveAssembly()` (`store.ts:363,371`), but
`removeInstance` (`store.ts:338-347`) and `toggleInstanceFixed`
(`store.ts:349-356`) do **not**. Remaining instances keep stale solved poses
after an instance is deleted or its ground flag flips.

### 5.5 MEDIUM — silent dress-up no-ops

Toolbar dress-up handlers treat a `null` from the feature builder as a no-op with
no user feedback (`Toolbar.tsx:224-225`). The builders return `null` on invalid
selection — e.g. `filletFeature` with no edges picked (`dressup.ts:31-39`),
`shellFeature` with no faces (`dressup.ts:53-61`). Clicking "Fillet" with the
wrong selection does nothing and says nothing.

### 5.6 MEDIUM — no worker timeout (hang risk)

`GeometryClient` correlates requests by sequential id and rejects all pending on
`worker.onerror` (`bridge.ts:36-39`), but a **silently hung** worker (e.g. an OCCT
operation that never returns) leaves the promise pending forever — no timeout,
no abort (`bridge.ts:42-48`). The UI's rebuild/lower/export await would stall
with no recovery path.

### 5.7 LOW — `devicePixelRatio` set once, never refreshed

`SceneController` sets DPR at construction (`SceneController.ts:130`); `resize()`
updates size but not DPR (`SceneController.ts:750-756`), so moving the window to a
different-density monitor renders at a stale ratio. Noted as acceptable-for-M1 in
the code.

### 5.8 LOW — misleading "drag-free reorder" wording

`FeatureTree.tsx` header says "drag-free reorder" but only arrow-button reorder is
implemented; there is no drag-and-drop. Keyboard reorder (↑/↓, F2, Delete) does
work. Cosmetic/documentation only.

---

## 6. Test Coverage Map

**Baseline (run in the intact original):** `tsc --noEmit` exits 0; `vitest run`
→ **24 files, 209 tests, all green**. The 24 test files correspond exactly to the
24 `*.test.ts` files in `src/` (pure-logic modules).

**What is well covered (no mocks, real kernel/sim where relevant):**

- `worker/rebuild.test.ts` — 30+ cases across every feature type, profiles
  (circle/arc/slot/spline), patterns, booleans with modelled tools, EdgeRef
  survival on resize, back-compat, and error paths.
- `worker/lower.test.ts` — instance→body mapping, revolute→hinge, prismatic
  skip, no-instances error.
- `sketch/*.test.ts` (8 files) — solver bridge, all constraint/dimension kinds,
  inference priority, hit-testing, profile closure, transforms, all 12 tools.
- `viewport/*.test.ts` (9 files) — pure helpers: pick mapping, highlight state,
  measure, placement round-trip, views, cube regions, colour-id codec, dress-up
  builders, mesh build.
- `persistence/*` — SQLite CRUD/durability/byte-identical round-trip, recovery
  snapshot lifecycle.
- `assembly/model.test.ts`, `sim/simulator.test.ts` — solver bridge + joint FK;
  COM render-back invariant.

**Coverage gaps (these are where the §5 defects hide):**

- **No assembly persistence round-trip with mates/joints** — directly why §5.1
  ships green. `toDocument`/`loadDocument` are only tested with features+params
  (`store.test.ts:251`).
- **`setRollback` / rollback interactions: zero tests** (§5.3).
- `removeMate`, `removeJoint`, `toggleInstanceFixed` never directly tested; only
  `coincident` mate kind exercised (not `distance`/`angle`) (`store.test.ts:167`).
- **No DOM/component tests.** `Sketcher.tsx`, `Viewport.tsx`,
  `SceneController.ts`, `ViewCube.tsx`, all of `app/` have **no unit tests** — the
  root Vitest env is `node`, so React/three.js rendering is untested here. In the
  monorepo this is covered by the Playwright E2E project — **which was not copied
  into this directory** (see §3 #9). For a standalone app this is the largest
  testing risk: the entire interactive/rendering layer currently has **no
  automated coverage available in this repo**.

---

## 7. Risk Areas & Open Questions

### Risk areas

- **Bundle size (NFR-4).** Shipping the full `opencascade.js` wasm (~13 MB gzip)
  blows the stated ≤3 MB budget. The trim build exists but is unwired (§2.3).
- **Frozen sim.** Vendoring `@mechx/sim` keeps the runnable wasm but drops rebuild
  ability (no `crates/`, no `just wasm`) (§2.4).
- **Single shared solid in assemblies.** `lowerAssembly` and the instance layer
  assume all instances are clones of **one** part (`lower.ts:55-64`,
  `SceneController.ts:237-288`). A true multi-part library (different solids per
  instance) is not supported yet.
- **Storage quotas.** Recovery writes the whole doc to localStorage (~5-10 MB
  cap) and the SQLite image to a single IndexedDB key; neither checks quota
  (`recovery.ts:42-48`, `idb.ts:46-52`).

### Decisions (resolved with the project owner)

The original "open questions" have been answered. They are recorded here because
they materially change §2–§3:

1. **Dependencies will NOT be available from the monorepo — both must be brought
   into and owned by the new repo.** `@mechx/cad` (kernel source) is vendored
   into the standalone repo as a first-class package, **and the OCCT custom-build
   pipeline comes with it** (decision 3). `@mechx/sim` is **replaced with a
   prebuilt package** — the frozen WASM artifact is consumed as a published/local
   prebuilt dependency; the Rust `crates/` do **not** come along (decision 4).
2. **The app is rebranded to "Plastiq."** All MechX/`@mechx/*` naming
   (`package.json:1-6`, `index.html:6`, README, the `@mechx/cad-studio` scope)
   is renamed. Note the `@mechx/cad`/`@mechx/sim` **import specifiers in `src/`
   are an internal contract** — if the package names change to e.g.
   `@plastiq/cad`, all 20 import sites and the `vite.config.ts` `exclude`/
   `external` entries must change in lockstep (or keep the names and only rebrand
   the app shell).
3. **Carry the OCCT custom-build pipeline** (`occt.build.yml` + the `just
   cad-occt` Docker flow, `packages/cad/scripts/build-occt.md`) so the bundle can
   be trimmed toward the NFR-4 ≤3 MB budget rather than shipping the ~13 MB-gzip
   full build. This requires porting the relevant `justfile` recipe and Docker
   setup, which live at the monorepo root today, not under the app.
4. **Sim ships frozen as a prebuilt package** — no rebuildability in the new repo
   by design. The committed `packages/sim/src/pkg/*` is the artifact.

### How the SPEC-5 / ADR-0013 references were identified

These were **not** assumed or pulled from outside this codebase — they are named
in the files copied into this directory. `README.md:3` titles the app "MechX CAD
Studio (SPEC-5)"; `README.md:17-19` link `docs/specs/SPEC-5-cad-editor-ui.md`,
`docs/adr/0013-typed-3d-selection-and-placement.md`, and ADR-0012; and source
headers cite them throughout (e.g. the SPEC-5/FR-* tags in `store.ts:1-5` and
`worker/*` headers, ADR-0013 in `sketch/sketchStore.ts:2`). The **documents
themselves** live in the monorepo (`mechx/docs/`) and were not copied here, so in
the standalone "Plastiq" repo those README links are dead — either excerpt the
relevant spec/ADR into the repo or drop the links (they are design provenance,
not runtime dependencies).

---

## 8. Reference — captured for the move

**`tsconfig.base.json` that `tsconfig.json:2` extends (must be inlined):**

```jsonc
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "forceConsistentCasingInFileNames": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  }
}
```

**DevDependencies absent from `package.json` (inherited from monorepo root):**
`typescript`, `vitest`, `eslint`, `@eslint/js`, `typescript-eslint`,
`@playwright/test`, `prettier`, `@types/node`. (Source: `mechx/package.json`.)

**Source layout being extracted** (paths relative to repo, copied 1:1 from
`mechx/apps/cad-studio`): `src/{app,store,sketch,viewport,worker,persistence,assembly,sim}`
plus `index.html`, `package.json`, `vite.config.ts`, `tsconfig.json`, `README.md`.

**Original location (intact, use as the correctness oracle):**
`/Users/ryanoboyle/mechx/apps/cad-studio`; kernel at
`/Users/ryanoboyle/mechx/packages/cad`; sim at
`/Users/ryanoboyle/mechx/packages/sim`; E2E at `/Users/ryanoboyle/mechx/e2e/cad-studio`.

---

*Investigation method: byte-diff against the monorepo original; static read of all
60 `src/` files plus the two dependency packages' manifests and the OCCT build
config; four parallel read-only subsystem audits; and an empirical typecheck +
full `vitest run` executed in the intact original to establish a correctness
baseline. The §5.1 critical defect was independently re-verified against
`store.ts` source.*
