# FablesFindings — CAD Operations Audit

**Date:** 2026-07-16 (second pass — full-depth merge)
**Scope:** Why the CAD operations do not work as intended/expected in the running app — every gap, misimplementation, and incomplete implementation across the full product: sketch UI → feature store → geometry worker → `@plastiq/cad` (OCCT/WASM) → viewport → selection/gizmos → persistence/undo → AI/headless → assembly/sim/export.
**Method:** Ten deep investigations in two waves (kernel operation layer, app wiring, kernel infrastructure/mesh/IO, sketch subsystem, external research, document model/persistence, viewport interaction, parameter reachability, kernel numeric correctness with 33 live-OCCT repros, cross-package integration). Headline claims were independently re-verified against the code. Every claim carries a `file:line` citation.

**Ground truth at HEAD (`b87c520`), as audited 2026-07-16:**

- `npx vitest run packages/cad` → **86 files, 348 tests, all green.** The kernel is real OCCT and passes its own suite.
- `pnpm --filter plastiq test` → **302 files pass, 1 fails** (2 tests in `ai/CommandPalette.test.tsx` — §6 W6).
- `npx tsc --noEmit -p apps/plastiq/tsconfig.json` → **5 errors** → **`pnpm --filter plastiq build` is broken** (§2.3).
- 33 additional live-kernel numeric repros were run for this audit (all passed as *repros*, i.e. they demonstrate the defects and confirm the correct behaviors listed in §4.9).

**Remediation status (updated 2026-07-17, work in progress):**

- **§2.3 — FIXED.** `tsc --noEmit -p apps/plastiq/tsconfig.json` is clean and `pnpm --filter plastiq build` succeeds. Sweep now sweeps along the **picked edge chain** parametrically. See §2.3 below.
- **§6 W6 — FIXED**, and one *additional* pre-existing failure the audit missed (`app/capabilities.test.ts`) is also fixed.

**Verified gate status at 2026-07-17 (all four run this session, exit codes read):**

| Gate | Command | Result |
| --- | --- | --- |
| Kernel tests | `npx vitest run packages/cad` | **89 files, 389 tests — all green** (on the REBUILT wasm) |
| App tests | `pnpm --filter plastiq test` | **307 files pass, 0 fail** (2010 passed, 6 skipped) |
| Typecheck | `npx tsc --noEmit -p apps/plastiq/tsconfig.json` | **exit 0 — clean** |
| Lint | `pnpm run lint` (`--max-warnings 0`) | **24 errors — all deliberate**, see below |
| reconstruct service | `pytest services/reconstruct/tests` | **149 pass, 4 skip** |
| nurbs service | `pytest services/nurbs/tests` | **exit 0 — all pass** |

**Playwright e2e — RUN for the first time (2026-07-17), full 90-spec suite.** The audit predicted one stale spec (W3); the full run surfaced **13 failing**. **9 were stale/misdirected tests and are now FIXED** (each verified in isolation); **4 are genuine §2.6 half-migration bugs** (a real mouse drag on the sketch canvas builds no geometry) left for a focused sketcher pass; 1 is flaky under parallelism. A **new P0-class bug** surfaced in the process — the first extrude onto the starter box vanishes invisibly (§2.4). Detail in §13.8. The primitives + "Rectangle" wiring were **driven in a real browser** (screenshot-verified): the Primitives ribbon panel renders. §13.6's e2e coverage gaps are otherwise untouched.
- **§13.9 was WRONG and is retracted:** `tsc --noEmit` **is** enforced in CI for the app — `.github/workflows/ci.yml:35` runs `pnpm -r --if-present run typecheck`, and `apps/plastiq/package.json:12` defines `typecheck: tsc --noEmit -p tsconfig.json`. Verified by running the exact CI command (exit 0, `apps/plastiq` in scope). The audit inferred the gate must be absent "or §2.3 could not have landed"; in fact the gate exists and the red build merged past it. §2.3 needed no CI change.
- **THE WASM REBUILD IS DONE — §2.1 / §2.2 / I1 are NO LONGER BLOCKED (2026-07-17).** `just cad-occt` was run and the rebuilt trim is vendored (`vendor/occt/plastiq-occt.wasm`, 17.9 → 18.2 MB). The full cad suite is **green on the new binary: 88 files, 359 tests**. `oc/bindings.test.ts` (new) pins the symbols *at runtime* — a class can appear in the generated `.d.ts` and still throw an embind `UnboundTypeError` on first call, so presence in the type file is NOT proof. Now bound and callable: `BRepAdaptor_Surface` (+ `gp_Cylinder/Cone/Sphere/Torus`, `GeomAbs_SurfaceType`), `ShapeUpgrade_UnifySameDomain`, `BOPAlgo_ArgumentAnalyzer`, `BRepTools_History`, `Interface_Static`, `Standard_Failure`. Still absent: `BRepFeat_MakePrism` (up-to-face semantics, §14.7 — not yet needed).
  - **I1 correction — `Interface_Static` binds but embind exposes NO statics on it** (own properties are only `length|name|prototype`), so `Interface_Static.SetCVal("write.step.unit", …)` — the normal way to set OCCT's STEP units — **does not exist at runtime**. I1 must therefore **scale at the interchange boundary** (`io/index.ts`), not configure the kernel. `oc/bindings.test.ts` pins this so the fix is never "corrected" back into a call that silently does nothing.
- **§2.1 — FIXED (2026-07-17), except its medium-term item 3.** Items 1, 2 and 4 of §2.1's own outline are implemented and wired, not merely defined:
  1. **Analytic per-surface-type signatures** — `packages/cad/src/mesh/surface.ts` (new): `faceSurfaceSignature()` reads the real surface via `BRepAdaptor_Surface.GetType()` (plane → normal+origin; cylinder/cone → axis+axisPoint+radius(+semiAngle); sphere → centre+radius; torus → axis+centre+radii; else a `{kind:"other", type}` tag). `surfacesMatch()` compares only intrinsic quantities — axis SIGN is ignored and an axis POINT is compared by distance to the other's axis LINE, because OCCT may legitimately report either orientation and a different point on the same axis after a rebuild.
  2. **Wired into resolution** — `mesh/resolve.ts:59-70` matches the analytic surface as the PRIMARY path (faces), with edges matching via a `faceSurfaces` pair; refs persisted before `surface` existed keep working through an explicit LEGACY normal-first fallback.
  3. **Distance cap — done** (`centroidCap`, enforced for faces at `resolve.ts:87-89` and edges at `:163`), so a deleted face's ref now fails loudly instead of silently rebinding to an arbitrarily distant same-normal face.
  4. **Regression tests — done** (`mesh/surface.test.ts`, new): the hole wall's stored `normal` is proven to be meaningless residue; a hole-wall FaceRef **re-resolves across a rebuild** (the audit's repro, inverted) and **fails loudly when the radius changes**; planar faces and legacy `surface`-less refs still resolve; two coplanar walls of a stepped pocket are separated by centroid.
  - **Still open:** §2.1(3) derivation-based naming (`BRepTools_History` is now bound, so it is unblocked but unimplemented) — the audit's own "medium term" item.
- **NEW — the wasm rebuild polluted the package root and turned CI red (fixed 2026-07-17).** The OCCT builder's `WorkingDir` is its `/src` mount and it writes `plastiq-occt.{js,d.ts,wasm}` there; `justfile:39` mounted `packages/cad` **itself**, so the artifacts landed in the package root beside the committed `vendor/occt/` copies. `eslint.config.js:9` ignores only `**/vendor/**`, so the minified 260 KB bundle was linted → **lint exploded from 28 to 349 errors**. The three root files were byte-identical duplicates of the vendored ones (verified by sha256) and have been deleted. `just cad-occt` now runs the builder in a **staging dir** (`packages/cad/build/occt/`, gitignored) holding only a copy of the config, then copies the products into `vendor/occt/` — so the root can never be polluted again.
- **The prior remediation left BOTH CI gates red; both are now green.** `tsc --noEmit -p apps/plastiq/tsconfig.json` had **12 errors**: §2.1's work made `FaceGroup.surface` a REQUIRED field (`mesh/tagged.ts:62-78`) without updating the five app test fixtures that construct `FaceGroup`s by hand (`three/Picking.test.tsx`, `viewport/{buildMesh,highlight,matePick,pick}.test.ts`). Each fixture is a unit quad in z=0, so each now declares the truthful `{kind:"plane", normal:[0,0,1], origin:[0,0,0]}`. One further new lint error (`matePick.test.ts` — a `three` import used only as a type) is also fixed.
- **NEW — the audit never checked lint, and CI gates on it (`ci.yml:37`, `pnpm run lint`, `--max-warnings 0`).** `pnpm run lint` was **red at HEAD with 28 errors**, so CI was failing on two counts, not one. Four are now fixed (a vestigial `eslint-disable` naming `react-hooks/exhaustive-deps` — a rule never installed or configured in this repo, and the only such directive in the tree; two dead `no-useless-assignment` writes in `extrude.ts` / `rebuild.ts`; one `prefer-const` in `worldMap.ts`). **Exactly 24 remain (verified this session), and are deliberately left for §2.6 and §2.7**: 23 in `sketch/Sketcher.tsx` and 1 in `sketch/profile.ts`. They are not noise — they are precisely this audit's own dead-code inventory (`hitTest`, `scheduleDragSolve`/`flushDragSolve`, `scheduleHover`/`cancelHover`, `panBy`/`zoomAt`, `GridAndAxes`, `SketchGeometry`, `DragDrawPreview`, `InferenceOverlay`, and `profile.ts`'s `cur`, the vestige of the proper arc sampling §7 flags as "coarse"). The correct fix is to **wire them up** (§2.6 / §2.7), not delete them, so lint goes green only once those land.

---

## 1. Executive summary

Plastiq's CAD engine is not fake: extrude, revolve, boolean, loft, sweep, pattern, fillet/chamfer/shell/draft, STEP I/O, a real planegcs sketch solver, and a real Levenberg–Marquardt mate solver all exist with genuine OCCT calls, near-exemplary WASM-handle discipline, and substantive tests. The reason "none of the operations work as intended" is that **the product breaks in the seams around the kernel**, in four compounding clusters:

1. **The input layer is severed.** The sketcher's interaction layer is a half-finished migration — most constraints/dimensions can never be applied, drags don't re-solve, gesture tools corrupt geometry (§2.6, §2.7). In the 3D viewport, live selections silently go stale across rebuilds, the two click paths resolve different entities, right-clicking destroys the selection you built, and mate creation has **no input wiring at all** (§2.8, §2.9).
2. **The reference layer cannot survive edits.** Persistent face/edge references are mathematically degenerate on closed curved faces (verified by live repro), booleans never unify coplanar fragments, and on-face sketch frames spin 90° across a hard threshold (§2.1, §2.2, §4.8).
3. **The parametric promise is hollow.** Named parameters are a dead store field; the properties panel can't add any parameter creation didn't bake, leaving revolve axes, mirror planes, and pattern directions permanently unreachable; deps are decorative — deleting a sketch silently rebinds its consumers to another sketch; roll-back-and-insert silently swallows new features; `op:"new"` *destroys* prior geometry in a single-body model; the rebuild is all-or-nothing with lossy error attribution (§2.4, §2.5, §2.10).
4. **What you see is not what you save, export, or simulate.** Still open: exports silently drop the assembly (a mated assembly ships as one body, §2.11.2); AI/service applies commit unvalidated STEP; mesh edits bypass autosave and the unsaved-changes guard (§2.11, §2.12). Since fixed (2026-07-17): the production build compiles (§2.3 ✅), placements now compose into the sim manifest AND file exports — no more teleport-to-origin at Simulate (§2.11.1 ✅), and AI/ML applies preserve undo history (§2.12.1 ✅).

Detail: kernel per-op findings §4 (incl. live numeric results §4.8–4.9), app wiring §5, viewport §6, sketch §7, document model §8, parameter-reachability matrix §9, integration §10, infrastructure/IO §11, AI/headless §12, test-coverage gaps §13, industry research with sources §14.

---

## 2. Root causes, ranked (P0)

### 2.1 Persistent references are degenerate on closed curved faces — round geometry cannot survive a rebuild

**Where:**

- `packages/cad/src/mesh/normals.ts:73-96` — `normalFromTriangulation` builds a face's *entire persistent signature* from its area-weighted average triangulation normal. For a **closed** curved face (hole wall, cylindrical boss, 360° revolve, sphere) the true integral is zero; the radial components cancel and the stored value is normalized floating-point residue. The `|| 1` guard at `normals.ts:93` returns the degenerate near-zero vector instead of failing.
- `packages/cad/src/mesh/resolve.ts:25,53-58` — `resolveFaceRef` requires `dot(candidate, ref.normal) ≥ 0.999`. Noise dotted with noise ≈ 0, so **a closed curved face can never re-match its own ref** after the mesh changes.
- `packages/cad/src/mesh/resolve.ts:27,92-99` — `resolveEdgeRef` needs a summed adjacent-normal score ≥ 1.998; any edge bordering a closed curved wall (a hole rim, a boss edge) contributes ≈ 0 from that side and can never match.
- `packages/cad/src/mesh/faceFrame.ts:14-38` — same root: `faceDatumPlane` on a closed curved face returns a `DatumPlane` with `normal ≈ [0,0,0]` without error, so the worker's `facePlane` op (`apps/plastiq/src/worker/geometry.worker.core.ts:121-154`) hands the sketch UI a garbage frame.

**Live repro (real kernel):** a hole of r=8 mm stores wall signature `[0.899, −0.438, 0]`; rebuilding at r=9 mm produces `[−0.432, 0.902, 0]` — unrelated directions. The subsequent fillet correctly fails loudly: `fillet: 1 of 1 selected edge(s) did not resolve on the current body` (`packages/cad/src/action/dressup.ts:59-65`; chamfer `dressup.ts:125-131`, shell `dressup.ts:181-187`, draft `dressup.ts:245`).

**Why it feels like "nothing works":** within one session the identical cached triangulation reproduces the identical noise, so refs on curved faces *do* resolve at creation — users can create a fillet on a hole rim, and it is **guaranteed to break the first time any upstream parameter moves**, violating the module's own contract (`dressup.ts:1-3`). Sketch-on-face on curved geometry throws `the on-face plane's face was not found` (`apps/plastiq/src/worker/rebuild.ts:233-236`; loft sections `rebuild.ts:392-396`; sweep `rebuild.ts:443-445`).

**Secondary defect — silent wrong-face rebinding:** among normal-matches, nearest centroid wins with **no distance cap** (`resolve.ts:61,101`). When a boolean deletes the referenced face, the ref silently rebinds to *any* other face with the same normal, arbitrarily far away.

**Test gap that hid this:** every resolve test uses `makeBox` only (`resolve.smoke.test.ts:16`, `resolve.integration.test.ts:22,40`); the one persistence test (`packages/cad/src/action/edgecases.test.ts:744-763`) re-resolves a planar face on an *identical* box.

**Actionable outline:**

1. Per-surface-type signatures via `BRepAdaptor_Surface.GetType()`: plane → (normal, centroid); cylinder/cone → (axis dir, axis point, radius, area); sphere → (center, radius); torus → (axis, center, radii); fallback → (type, area, centroid, UV-bounds hash).
2. Distance cap on centroid disambiguation (scaled to model bbox) so a deleted face's ref **fails loudly** instead of rebinding.
3. Medium term: derivation-based naming (§14.1) — deterministic birth names + `Generated/Modified/IsDeleted` harvested per op into a merged `BRepTools_History`-style element map; geometric signature as fallback only.
4. Regression tests: ref on hole wall/rim → radius-changed rebuild must re-resolve; boolean deleting the target face must return null.

### 2.2 Booleans never unify coplanar faces — post-join selection silently operates on fragments — ✅ FIXED (2026-07-17)

**Resolution.** `boolean.ts` now runs the mainstream OCCT pipeline — `SetFuzzyValue` → `SetNonDestructive` → `Build` → `HasErrors` → `ShapeUpgrade_UnifySameDomain` — and the flush union is back to the **six** faces a 60×30×30 box actually has (measured: raw fuse 10 → unified 6). `resolveSelector(topFace)` now covers the whole 60×30 face, asserted by **area AND centroid** (a surviving fragment would sit at x=15 or x=45, so a fragment cannot pass); an L-shaped union is asserted NOT to over-merge, guarding the opposite error; a through-hole wall is now ONE analytic cylinder rather than two half-cylinders — which is exactly what §2.1's FaceRef then identifies by radius+axis. Tests: `packages/cad/src/action/boolean.test.ts` (11).

Three findings from doing it, each of which contradicts the audit's own outline:

1. **The convenience ctors build inside the constructor.** `BRepAlgoAPI_Fuse_3(a, b, range)` performs the boolean in `new`, so any `SetFuzzyValue`/`SetNonDestructive` after it is a **silent no-op**. The fix therefore uses the default ctor + `SetArguments`/`SetTools` + `Build(range)`.
2. **Fuzzy stays at 1e-7, and the audit's 1e-6 was measured and REJECTED.** `FuzzyValue()` on an unconfigured op reads **1e-7** — so `Precision::Confusion` is what every boolean has always run at, and setting it explicitly changes nothing (it states the contract instead of inheriting it). At the top of §2.2's suggested "1e-7…1e-6" range, OCCT stamps the fuzz onto the RESULT's tolerance and it propagates: the up-to-face pads' bounding boxes grew by exactly **6e-7 m per side**, reddening four kernel tests that assert micron-exact geometry. That is the §4.8 N1 mechanism three decades smaller, and trading the kernel's verified exactness (§4.9) for a decade of fuzz is a bad deal. Near-coincident operands are better served by `SetNonDestructive` + `UnifySameDomain`, which cost no precision.
3. **`NonDestructive()` defaults to FALSE**, so `SetNonDestructive(true)` is a real behavioural change (pinned by a test): the rebuild accumulator and the hole/pattern loops reuse one `Solid` across successive booleans and must not see it mutated underneath.

Also landed: **`unionAll`** fuses N operands in ONE pass — `rebuild.ts`'s pattern fold was pairwise, re-running the intersection machinery against the ever-growing accumulator once per copy (now `fusePatternCopies` delegates to it) — and `BooleanResult` reports **`lumps`**, since a cut CAN legitimately split a body: the count is surfaced, not rejected (rejecting is the over-strict behaviour §4.2 already flags in `extrudeToFace`).

**NOT done, and now proven impossible rather than assumed — the `BOPAlgo_ArgumentAnalyzer` pre-check.** Its base chain (`BOPAlgo_Algo` → `BOPAlgo_Options`) was added to the trim and it now **constructs**; but embind binds only `SetShape1`/`SetShape2`, because OCCT exposes every check mode as a `Standard_Boolean&` (C++ writes `analyzer.SelfInterMode() = Standard_True`) and a reference-returning accessor degrades to a **read-only getter**. Every mode defaults to `false`, so `Perform()` would analyse nothing and cheerfully report no faults — strictly worse than no pre-check, because it would LOOK like validation. Pinned by `oc/bindings.test.ts`. Likewise **OCCT's report text on failure**: `DumpErrors` needs a `Standard_OStream`, which is not bindable (the same limitation that keeps `Standard_Failure`'s message unreachable, §2.5.4) — errors are reported by operation name and stage instead.

**Was:** `packages/cad/src/action/boolean.ts:12-30` returned the raw `BRepAlgoAPI` result. **Zero** uses of `ShapeUpgrade_UnifySameDomain`, `SetFuzzyValue`, or `SetNonDestructive` anywhere in `packages/cad/src` (verified by grep).

**Live repro:** union of two flush 30 mm boxes → 10 faces, including **two coplanar +Z "top" faces**. `resolveSelector(topFace)` (`packages/cad/src/select/predicates.ts:110-124`) returns one fragment, so "shell opening the top", "fillet top edges", `largestPlanarFace`, `faceByNormal`, and any pre-union FaceRef act on **half the geometric face** — silent wrong results.

**Compounding gaps** (`boolean.ts:33-59`): no fuzzy tolerance, no `BOPAlgo_ArgumentAnalyzer` pre-check, no `BRepCheck_Analyzer` post-check, no `SetNonDestructive(true)`, binary-only API (N pattern copies fold pairwise in O(N) passes — `rebuild.ts:140-150`), no lump-count check (a cut splitting a body flows on as a compound while everything downstream assumes one solid).

**Actionable outline:** run `ShapeUpgrade_UnifySameDomain` after every boolean (compose its history into the ref map when 2.1(3) lands; needs the class in `occt.build.yml` → wasm rebuild); `SetFuzzyValue(1e-7…1e-6 m)` + `SetNonDestructive(true)`; surface the OCCT report text on `HasErrors()`; add an N-ary variant for pattern fusing; check result solid count; regression tests for flush unions, tangent cylinders, disjoint intersects.

### 2.3 The production build does not compile — and it proves a fictional feature — ✅ FIXED (2026-07-17)

**Was:** `apps/plastiq/package.json:10` gates `build` on `tsc --noEmit`. Five errors:

- `apps/plastiq/src/actions/registry.ts:312,331` — `Property 'edge' does not exist on type 'ContextTarget'`. `ctx.edge` was always `undefined` at runtime.
- `apps/plastiq/src/worker/rebuild.ts:642,649,655` — TS narrowed the accumulator `solid` to `null`/`never` in the `transform` case (assignment happens only inside the `replace` closure).

Dev mode (`vite`/esbuild) strips types without checking — why this shipped unnoticed.

**The sweep consequence (was):** the `ctx.edge` ternary could never be true, so Interactive Sweep *always* took the else-branch and swept the last sketch along a canned 3-point elbow (`[[0,0,0],[0,0,0.04],[0.03,0,0.07]]`), while its status text promised "use Properties path for custom spine".

**How it was fixed:**

1. **`never`-narrowing (root cause, not a per-site patch):** added a `currentSolid(): Solid | null` accessor beside `replace` in `rebuild.ts`. TS's control-flow analysis does not look into closures, so it pinned `solid` to its `null` initializer and narrowed guarded reads to `never`; reading through an accessor whose *declared* return type is `Solid | null` restores the truth. The `transform` case reads `currentSolid()`.
2. **Real edge-path sweep, parametric:** sweep now accepts `data.pathEdges: EdgeRef[]` — persistent refs **re-resolved against the current body every rebuild**, so the pipe FOLLOWS its edges when upstream parameters move them (baking world points at creation would not). Follows the existing `directionEdge` / `axisEdge` precedent; an unresolved path edge fails loudly, matching the dress-up contract.
   - Kernel: `buildWireFromEdges` (`packages/cad/src/sketch/spine.ts`) wires resolved edges via `MakeWire.Add_3` — connects regardless of pick order and preserves each edge's exact curve (an arc stays an arc instead of being chorded). `sweepAlongWire` (`packages/cad/src/action/loft.ts`) split out of `sweep` to accept an already-built spine.
   - App: `sweepAlongEdgesFeature` / `sweepFromSketchAlongPickedEdges` (`viewport/dressup.ts`); the `sweep` action (`actions/registry.ts`) now reads the real `ctx.picks` + `ctx.refs`.
   - The no-edges fallback is a straight 40 mm path (an honest, editable default); the status text no longer promises a nonexistent editor.
3. **Regression tests** (real OCCT, `worker/rebuild.test.ts`): a sweep along a picked vertical box edge measures **exactly** 4×4×20 mm, and after growing the box to `dz = 40 mm` measures **exactly** 4×4×40 mm — proving the spine re-resolves rather than staying baked. A second test asserts an unresolvable path edge throws.
4. **CI:** no change needed — the gate already existed (see the §13.9 retraction in the header).

**Still open, tracked under §9 (not §2.3):** a Properties **path editor** for a typed (non-edge) spine. §9's matrix already owns the `data.*` editor gap (`sections`, `path`, `selector`, `toolFeatures`). The part that made this a §2.3 *honesty* defect — a status text promising an editor that does not exist — is gone.

### 2.4 Single-body document model; "new body" destroys prior geometry

**Where:** `apps/plastiq/src/worker/rebuild.ts:195-811` folds every feature into one accumulator `solid`; `replace()` (`rebuild.ts:201-204`) deletes the previous solid. With `op:"new"` on extrude/revolve/loft/sweep (`rebuild.ts:297-311,359-372,410-426,478-494`), the new pad **permanently discards** everything built before it. No bodies list, no body references, no boolean between two existing bodies (the `boolean` feature rebuilds its tool from a feature *subtree*, `rebuild.ts:738-775`).

**User-visible:** "New body" deletes your part. A `placement`-moved body (`rebuild.ts:801-805`) mirrors/patterns/booleans in its **unmoved** local frame because the baked `transform` feature has no UI entry (`registry.ts:496-506` opens the placement gizmo only). Every mainstream CAD is multi-body with per-feature merge scope (§14.7).

**Actionable outline:** promote rebuild state to `Map<bodyId, Solid>`; features gain a target body; `op:"new"` creates a body; `boolean` picks two bodies; viewport renders all bodies; add a ribbon entry for baked `transform` (`packages/cad/src/action/transform.ts`, `rebuild.ts:628-660` already support it).

### 2.5 All-or-nothing rebuild with lossy error attribution — ✅ MOSTLY FIXED (2026-07-17; per-feature caching still wasm-gated)

**Where:**

- `rebuildDocument` throws on the first failing feature (`rebuild.ts:173,195-811`) — one bad fillet blanks the *entire* build.
- The UI attributes errors by regex `/feature '([^']+)'/` (`three/Viewport.tsx:245-251`). Raw OCCT failures thrown inside `fillet()`/`shell()`/`sweep()` have no prefix → no feature-tree badge (`app/FeatureTree.tsx:58-68`), and the catch never calls `setMesh`, so the **stale previous mesh stays on screen**. To the user: "I clicked fillet and nothing happened."
- Some kernel throws aren't `Error` at all — WASM `Standard_Failure` surfaces as a **number** (acknowledged `dressup.ts:38-40`), and a profile crossing the revolve axis throws with message **`undefined`** (live-verified; `revolve.ts:41` has no translation) → status text like `rebuild failed: undefined` / `rebuild failed: 5286968`.
- No per-feature shape caching: every edit replays the whole history from feature 0 (`Viewport.tsx:204-266`).

**Resolution — ✅ MOSTLY FIXED (2026-07-17); one sub-item is wasm-gated and stays open.**

1. **Per-feature isolation (Fusion timeline semantics) — done.** `evaluateDocument(oc, doc, isolate)` in `worker/rebuild.ts` now backs two contracts: `rebuildDocument` keeps FAIL-FAST (correct for internal sub-builds — a boolean's tool subtree, a pattern's tool features — and the headless CLI, where a half-built tool must never silently become geometry), and the new `rebuildDocumentIsolated` records a failed feature and skips it while the previous solid passes through untouched. One impossible fillet no longer blanks the model.
2. **Structured attribution — done.** The build response carries `statuses: {featureId, status: "ok"|"error"|"suppressed", message?}[]` (`worker/protocol.ts`, via `buildDocumentIsolated` → `GeometryClient.build` → `BuildOutcome`). **The `/feature '([^']+)'/` regex in `Viewport.tsx` is gone.** The store now holds `featureErrors: Record<FeatureId, string>` instead of a single `errorFeatureId` — isolation means several features can be errored at once (a failed sketch plus the extrude that needed it is the common cascade), and `FeatureTree`'s ⚠ badge now carries the feature's actual message as its tooltip.
3. **Stale mesh — done.** The catch path now clears the mesh, refs and mass-props. Leaving the previous geometry on screen after a failed rebuild is what made a broken op look like "nothing happened".
4. **`Standard_Failure` → message — PARTIALLY fixed; full decode is WASM-GATED.** New `packages/cad/src/oc/error.ts` (`describeOcctError`) replaces every `(err as Error).message` / `String(err)` on the build path, so `rebuild failed: undefined` and `rebuild failed: 5286968` are gone, and `featureErrorMessage()` guarantees every error names its feature even for a raw OCCT throw. **Reading OCCT's OWN message text is not possible in this build:** it needs either the `Standard_Failure` class bound (absent from `occt.build.yml`) or Emscripten's `getExceptionMessage` (absent — it needs `-sEXPORT_EXCEPTION_HANDLING_HELPERS`, and `occt.build.yml:143-151` documents that overriding `emccFlags` REPLACES the builder's known-good defaults and yields an unlinkable wasm). `Standard_Failure` has been **added to `occt.build.yml`** so the next `just cad-occt` unlocks it; until then `describeOcctError` degrades honestly ("the geometry kernel rejected this operation…") rather than leaking a pointer.
5. **Per-feature shape caching — STILL OPEN, wasm-gated.** Rebuilding from the first dirty feature needs `SetNonDestructive` (§2.2), which is missing from the trimmed build. Every edit still replays the whole history from feature 0.
6. **NEW follow-up this change introduces — handle leak profile (not yet addressed).** Isolation changes the *leak* profile, not just control flow. Fail-fast leaked a throwing feature's partial allocations **once** and then aborted the build; isolating means the user keeps editing in a long-lived worker, so every failed rebuild leaks whatever that feature allocated before it threw (the kernel functions each free their own temporaries in a `finally`, but a rebuild-case local — e.g. `pad` in the `extrude` case if `cutProfileHoles` throws — is not covered). No test can see a slow leak. Tracked, not fixed: revisit if the geometry worker OOMs during a long session with a persistently-failing feature.

**Regression tests** (real OCCT, `worker/rebuild.test.ts`): an unabsorbable 40 mm fillet on a 20 mm-thick box — `rebuildDocument` still throws (fail-fast preserved), while `rebuildDocumentIsolated` keeps the box at its **exact** unchanged volume and reports only `f2` as errored, with a message that names the feature and is not "undefined"; a second test pins suppressed reporting and the failed-sketch → extrude cascade. `ai/tools/buildPart.unit.test.ts` gains a test that the AI probe **rejects a document whose feature errored even though geometry survived** — isolation would otherwise have let the agent apply half-built geometry (a regression this change had to prevent).

### 2.6 The sketcher's interaction layer is severed (ADR-0014 half-migration)

The pure model layer is genuinely good — real planegcs solve with DOF/verdict/redundancy (`packages/cad/src/sketch/solver.ts:98-256`), an 18-kind constraint bridge (`apps/plastiq/src/sketch/model.ts:269-461`), over-constraint auto-demotion (`sketch/sketchStore.ts:270-299`), true arc/spline/circle wires (`packages/cad/src/sketch/sketch.ts:65-204`). But the user can barely reach it:

1. **Entity selection is impossible → most constraints/dimensions permanently disabled.** The only live selection path picks *points only* within a fixed 2 mm radius (`sketch/SketchScene.tsx:86-99`, verified). `hitTest` (`sketch/hit.ts:67`) is imported at `Sketcher.tsx:20` and **never called** (verified). `canApply` (`hit.ts:142-171`) needs entity ids, so horizontal/vertical/parallel/perpendicular/equal/concentric/tangent/midpoint/pointOnObject/symmetric buttons (`Sketcher.tsx:987-1046`) and radius/diameter/angle dims (`sketch/dim.ts:32-43`) **can never enable**. Only coincident and point-point distance are reachable.
2. **Dragging a point neither re-solves nor snapshots.** `SketchScene.tsx:139-150` → `movePoint` writes coordinates only (`sketchStore.ts:324-330`, verified); the rAF drag-solve machinery (`Sketcher.tsx:745-768`) has zero callers. The tests that would catch this are `describe.skip`'d (`Sketcher.perf.test.tsx:120-121` — "moves to SketchScene next"; the move never happened).
3. **Gesture tools delete reused user points → dangling refs and silent profile loss.** Clicks snap to existing points and pass `reusePointId` (`SketchScene.tsx:104-119`), but rectCenter (`sketchStore.ts:476-478`, verified), circle3 (`:508-529`), arcCenter (`:566-569`), polygon (`:587-590`), and slot (`:613-624`) drop "temp" gesture points with `points.filter(...)` — deleting a **pre-existing** point if it was snapped. Referencing entities are silently skipped in render (`SketchScene.tsx:210-213`), profile extraction nulls (`sketch/profile.ts:65-68`), constraints map to nonexistent solver ids (`model.ts:252-254`).
4. **The normal-to sketch camera is hardwired off.** `three/Scene.tsx:359` mounts `<SketchCamera frame={null} />` (verified) — the ortho rig (`three/SketchCamera.tsx:15-38`, `viewport/sketchCamera.ts:35-67`) never activates; users sketch in free-orbit perspective. Glyphs are positioned by a 2D affine tied to no camera (`Sketcher.tsx:326-335`), and the glyph SVG is `pointer-events-none` (`Sketcher.tsx:1099-1105`, verified) → **dimension edit/delete by clicking a glyph is dead** (editable only in the instant after creation, `sketchStore.ts:281`). `panBy`/`zoomAt` imported, never called.
5. **Precise numeric draw input is broken.** The hover pipeline has no caller (`Sketcher.tsx:769-782`) → cursor permanently `{u:0,v:0}`; typed values resolve against the origin with wrong sign inference (`sketch/drawInput.ts:115-132`); the input box is invisible before the first click (`Sketcher.tsx:675-681`).
6. **No entity/point deletion** (no `removeEntity` in `sketchStore.ts`, no Delete key `Sketcher.tsx:834-878`, no menu entry `config.ts:658-717`); **no trim/extend/offset/sketch-fillet/mirror; no projection of model edges into a sketch**. Shape tools emit no shape constraints — rectangles are 4 loose lines that skew on first solve (`sketchStore.ts:420-439,463-490`).
7. **Failed solves are applied anyway.** `apply_solution()` runs after `Failed`/`SuccessfulSolutionInvalid` (`solver.ts:232-233`); the store writes positions back regardless (`sketchStore.ts:664-681`) — violating the sketch spec's own §10.1 (`SPEC_For_SketchSystem.md:176-177`).

**Actionable outline:** finish ADR-0014 as a unit: route clicks through `hitTest`; call the existing drag-solve on pointer-move + snapshot on pointer-up; never delete `reusePointId` points; mount `SketchCamera` with the real frame and re-enable glyph pointer events; wire the implemented-and-tested `nearestSnap`/`segmentHint` (`sketch/infer.ts:32,89,127`); add delete + auto shape-constraints; restore last-valid on solve failure.

### 2.7 Profiles: the hole-in-plate case — ✅ CORE SYMPTOM FIXED (2026-07-17); some sub-items remain

**FIXED — a hole no longer breaks the whole sketch.** `sketch/profile.ts` `edgeLoop` now extracts **all** closed cycles and classifies them by **even-odd containment**: the single outer boundary becomes the profile, and loops inside it become **holes** — a full circle OR an inner **loop** of line/arc/spline segments (a rectangular/shaped hole, not just a drill). The `ProfileHole` type gained a `{kind:"loop"}` variant; `rebuild.ts` `cutProfileHoles` (and the revolve hole path) build each hole and subtract it (the existing per-hole boolean mechanism, extended to loops). So rect-in-rect / washer / any inner loop now builds a plate-with-a-slot instead of throwing `no buildable profile`.
- Tests: `sketch/profile.test.ts` (rect-in-rect → loop hole; outer picked by containment regardless of draw order; two disjoint OUTER regions still → null honestly); `worker/rebuild.test.ts` (real OCCT: a 40×30 plate with a 20×10 hole extrudes to the **exact** (outer − hole)×height volume, with more than a box's 6 faces).
- Bonus: the refactor removed `profile.ts`'s lone lint error (the dead `cur` vestige §2.7 itself flagged) — lint is now **23**, all in `Sketcher.tsx`.

**Design note:** this reuses boolean subtraction rather than `toFace` inner wires. `Sketch.toFace` (`sketch.ts:192-204`) still builds from ONE wire; the holes are cut as separate extruded tools, which is the mechanism the kernel already used for circular holes. Native `MakeFace.Add(reversedInnerWire)` would be marginally cleaner geometry but a larger, riskier change for no functional gain here.

**STILL OPEN (not addressed by this change):**
- **Multiple disjoint OUTER regions** (two separate rectangles in one sketch) → still `null` (honest failure — the `Profile` shape holds one boundary; a region list is a bigger change).
- **Nested islands** (a solid inside a hole) → `null` (rejected at depth ≥ 2).
- **Circle-outer with a circle hole** (circle-in-circle) still unbuildable — `soleCircle` handles only a lone circle; the outer must be a line/arc/spline loop.
- **No self-intersection detection:** a bowtie wire still passes `MakeFace` and extrudes into an invalid solid silently; `Solid.isValid()` exists (`solid/solid.ts:38-43`) but no production path calls it.
- **Endpoints coincident *by constraint*** (two distinct point ids) still leave degree-1 vertices → no profile (the degree-2 requirement); no coincident-endpoint merge at Finish.
- Hole containment for circles is still centre-only (`profile.ts`), so overlapping circle holes can sliver.

### 2.8 3D selection is unreliable: stale picks, three disagreeing pickers, right-click destroys selections

**Where (all in `apps/plastiq/src`):**

1. **Picks are never remapped or cleared across a rebuild.** The rebuild atomically swaps mesh + refs (`three/Viewport.tsx:211-243`), but `store.picks` survives (`store/store.ts:384-394` doesn't clear; `three/Picking.tsx:243-257` only re-highlights). Face/edge ids are OCCT exploration order (`packages/cad/src/mesh/tessellate.ts:96-147`); any topology-changing feature renumbers them. After a rebuild, the highlight paints whatever entity now owns the old id, and the next context-menu op resolves `ctx.refs.faces[oldId]` against the **new** table (`three/contextmenu/config.ts:120-123`, `viewport/dressup.ts:17-30`) — a dress-up can be authored against a different face/edge than the one visibly selected. FR-16 re-resolution exists for feature *data*, not the *live selection*.
2. **Right-click select-then-menu destroys edge/vertex selections.** `useCanvasRightClick.ts:103` resolves hits by raycast only; the GPU fallback (`:104-107`) covers `face|body` only, and there is **no** `screenNearest` px-tolerance fallback for edges/vertices — the very fallback left-click needed because edges "were effectively unselectable" (`Picking.tsx:280-283`). Edge raycast tolerance is 0.0015 m *world* (`viewport/pick.ts:65`). On a miss, `useCanvasRightClick.ts:125-127` runs `clearPicks()`: shift-click 3 edges, right-click slightly off one to fillet → **selection wiped**, empty-space menu shown. The primary multi-edge fillet path only works if the right-click lands within ~1.5 mm world of an edge *and* `selMode` is already `edge`.
3. **Left-click/hover ignore the selection mode.** `Picking.tsx:324-335` tries vertex → edge → face regardless of `selMode` (`screenNearest` hardcodes `"vertex"`/`"edge"`, `:284-304`), with no occlusion test (vertices render `depthTest:false`, `viewport/buildMesh.ts:112-118`): in face mode, a click within 14 px of any projected corner selects a hidden **vertex**. The TopBar mode selector (`ribbon/TopBar.tsx:13,47`) truly affects only body mode, box-select, and right-click resolution — three pickers disagree about the same click. Pick handlers also never check `e.button` (`Picking.tsx:339-343,375-442`) — right/middle clicks mutate selection and race the menu's own resolution.
4. **The TransformGizmo appears on ANY pick and moves the whole body.** `three/gizmos/transform.gizmo.tsx:27-28` shows it whenever `picks.length > 0` — including a face picked for shell. Handles anchor at the group origin (typically inside the part), so a click near center after any selection can grab an axis; mouse-up commits a placement (`:37-39`) — **an accidental body move from a selection click** (and a zero-delta drag still pushes an undo step). No numeric entry, no snapping; rotation pivots on the local origin (`viewport/placement.ts:12-14`).
5. **Assembly mode picks a hidden ghost.** With instances present, the base `<Part>` isn't rendered (`three/Scene.tsx:339`) but `<Picking part={part}>` (`:342`) still raycasts it; fit-to-view frames it (`Scene.tsx:204-212`); Measure measures it (`Picking.tsx:416-423`) — clicks where the invisible origin-posed part sits select invisible faces.

**Actionable outline:** clear or re-resolve `picks` through the new refs table on every rebuild (re-resolve via the persistent-ref signatures, or conservatively clear + status note); give the right-click path the same `screenNearest` fallback and stop clearing on miss; honor `selMode` in `entityHit` and filter buttons; gate the TransformGizmo on body-mode/explicit move; in assembly mode, retarget picking/fit/measure to instance groups.

### 2.9 Mate authoring is unreachable — `addMatePick` has no caller in the app — ✅ FIXED (2026-07-17)

**Where:** `store/store.ts:607` defines `addMatePick`; the only invocations are its unit test and the e2e spec driving the store seam directly (`e2e/plastiq/assembly-to-sim.spec.ts:53-54`) — verified by grep. `three/Picking.tsx` has no mate-mode branch; `useCanvasRightClick.ts` never records mate picks; `three/Assembly.tsx` renders instances with zero pointer handling.

**Consequence:** AssemblyTree's "Add mate → Picking 0/2" (`app/AssemblyTree.tsx:93`) can never advance; all six mate menu items (`config.ts:481-522`, enabled at `matePickCount === 2`) and the Joints "Add" button (`AssemblyTree.tsx:211,236`) are **permanently disabled for a real user**. The mate solver itself is real and wired (`store.ts:721` → `solveMates`, verdict/DOF surfaced) — the input path was simply never built. The e2e passes because it bypasses the missing wiring.

**Resolution — ✅ FIXED (2026-07-17).** Diagnosis confirmed exactly: `addMatePick` had zero app callers (only its own definition and the e2e driving the store seam).

1. **The input path now exists.** `Assembly.tsx` gives each instance an `onPointerDown` that resolves the hit and calls `addMatePick`. `Scene.tsx` arms it **only while `mateMode` is on**, so instances stay inert (and orbiting is unaffected) the rest of the time. `AssemblyTree`'s "Picking n/2" counter, all six mate menu items, and the Joints "Add" button are now reachable by a real user.
2. **Instance faces resolve to real B-rep faceIds.** `faceIdAt` was refactored to `faceIdOfMesh(mesh, faceIndex)` (`viewport/pick.ts`) so the triangle → render-group → faceId mapping serves an instance hit, not just the base part. Because an instance group is built from the same tagged mesh, the resulting `faceId` indexes the SAME `selectionRefs.faces` table `addMatePick` reads. (Note: the right-click path resolves only `{kind:"body", id:0, instanceId}` — it never resolved a faceId, which is why it could not be reused here.)
3. **Kept pure + testable.** The resolution lives in `viewport/matePick.ts` (`resolveMatePick`), following the `pick.ts` / `dressup.ts` idiom, so the previously-missing step is *tested rather than bypassed* — the point the old e2e missed. It rejects right/middle clicks, hits with no triangle, and triangles outside every face group.
4. **Picks are now visible.** New `MatePickGizmo` (`Scene.tsx`) marks both endpoints on the model, placed through each instance's LIVE rendered pose (mate-solved / exploded / simulating) since picks are stored instance-local. The two picks are coloured differently because a mate is directional (a → b). Previously the only feedback was the counter.
5. **Tests** (`viewport/matePick.test.ts`, 5 new): resolution of triangle → faceId + world point; button/no-triangle/out-of-range rejection; and an integration test driving the REAL store — two resolved instance clicks advance 0/2 → 2/2, `applyMate("coincident")` records the mate, **the solver publishes a verdict**, and the picks are consumed so the next mate restarts at 0/2. Plus: a pick whose faceId has no published ref is dropped.

**Still open:** an e2e that clicks the actual viewport canvas (the audit's third bullet). The unit+store tests above cover the resolution and store path; a Playwright drive of a real WebGL canvas click remains untested here — see §13.6.

### 2.10 The parametric promise is hollow: dead params, swallowed inserts, decorative deps

**Where (all verified):**

1. **Named parameters don't exist.** `CadDocument.params` (`store/types.ts:40`) + `setParam` (`store.ts:147,458-459`) have **zero** non-test callers; no UI section exists (whole `PropertiesPanel.tsx` read); no resolver exists — `rebuild.ts` reads only literal numbers (`rebuild.ts:63-75`); `doc.params` is threaded to one sub-rebuild (`rebuild.ts:689`) where it is equally unread (and `rebuild.ts:751` passes `{}`). Meanwhile the AI prompt **instructs the model** to "expose meaningful dimensions as named params so the user can edit them afterward" (`ai/prompt.ts:68`) — an affordance that is a dead store.
2. **Roll-back-and-insert is missing; adding a feature while rolled back silently does nothing.** `addFeature` always appends (`store.ts:388-392`, verified) while the build slices to the bar (`Viewport.tsx:110-115`) and the rebuild signature is computed on the **sliced** list (`Viewport.tsx:116-124`, verified) — a feature appended beyond the bar triggers no rebuild, no error, no status. Fusion/Onshape insert-at-the-bar semantics are absent. Rollback position is also not persisted (`store.ts:779-783,814-815`).
3. **Deps are decorative — deletion/suppression/reorder silently rebinds geometry.** ✅ **PARTIALLY FIXED (2026-07-17): the rebuild no longer rebinds.** `sketchForFeature` (`rebuild.ts`) now FAILS a consumer whose explicitly-named sketch is gone instead of falling back to an unrelated one: an explicit `data.sketchId` must resolve to an active sketch; a `deps`-named sketch that was DELETED (gone from the doc) or SUPPRESSED (a sketch feature that did not build) returns null → the feature errors loudly ("no sketch profile upstream"). The legitimate last-wins fallback survives ONLY for a feature that names no sketch at all (the ribbon path). Tests: `rebuild.test.ts` (delete/suppress/stale-sketchId all fail; no-deps still uses the last sketch). **Still open (store side):** `removeFeature`/reorder do not proactively validate or warn, and `FeatureTree`'s Delete key has no dependent check — the consumer now errors at rebuild rather than being blocked at edit time. Original finding: `removeFeature` never touches other features' `deps`/`data.sketchId` (`store.ts:425-435`); nothing validates deps; when the named sketch is missing, `sketchForFeature` **falls back to the most recent other sketch** (`rebuild.ts:179-193`). Delete or suppress Sketch A → its extrude silently rebuilds from Sketch B's profile — wrong geometry, zero error. Same on reorder above the dep (`store.ts:443-456`, `FeatureTree.tsx:149,161` have no dependency check); FeatureTree's Delete key removes with no confirm and no dependent check (`FeatureTree.tsx:317-319`). Most ribbon-created features carry **no deps at all** (`registry.ts:281,329,349-364,379-388,404-446,487-492`), so most documents live on this fragile fallback.
4. **No parameter validation between UI/AI and kernel.** ✅ **Count-cap PARTIALLY FIXED (2026-07-17):** `linearPattern`/`circularPattern` now reject `count > 10 000` in the kernel (one guard covering UI, AI probe, and headless), so the audit's `count: 1e6` fails loudly instead of freezing the single geometry worker. Test in `pattern.smoke.test.ts`. **Still open:** the broader param validation (`NumberField` finite-only, bare `z.number()`, per-type min/max/step bounds). Original finding: `NumberField` commits any finite number (`PropertiesPanel.tsx:29-33`); `updateParams` merges blindly (`store.ts:397-403`); zod uses bare `z.number()`; nothing caps `count` — `linearPattern count: 1e6` runs on the app's **single** geometry worker (AI probe path `ai/agentTurn.ts:107-116`) and freezes all interactive rebuilds without ever erroring.

**Actionable outline:** implement params end-to-end (UI table + expression resolution in `num()`/`opt()` before kernel dispatch) or remove the field and the prompt lie; make `addFeature` insert at `rollbackIndex` and advance the bar; on remove/suppress, either block with a dependents list or mark dependents errored — never fall back to `lastSketch` when deps named a specific sketch; add per-type param bounds (min/max/step in `store/featureUnits.ts`) enforced in panel, zod, and worker.

### 2.11 What you see is not what you export or simulate

**Where (all verified):**

1. **`placement` composes into nothing downstream** — ✅ **FIXED (2026-07-17).** One shared conversion (`viewport/placement.ts`, now runtime-THREE-free so the geometry worker imports it; pure Euler↔quat proven against THREE ground truth incl. gimbal lock): `placementPoseOf` poses the synthesized `body0` in `effectiveAssembly` AND seeds the viewport's `simBodies`, so Simulate starts the part exactly where the viewport shows it — and the drop-test ground/lift now compute from the posed manifest body. File export bakes the placement into the solid via kernel `rotate`/`translate` (`posePlacementForExport` in `geometry.worker.core.ts`) so STEP/IGES/glTF carry the posed part. The once-false `rebuild.ts` / `placement.ts` comments now state the true behavior. Live-OCCT tests (`geometry.worker.core.test.ts`): a placed box lowers with manifest COM = Rz(π/2)·localCom + 0.5 m, and its exported STEP round-trips through `importStep` with the composed COM. Was: The rebuild skips it *claiming* "composed into the sim manifest at export" (`rebuild.ts:801-805`) and `viewport/placement.ts:5-6` claims M4 composition — **both comments are false**. The only consumers are the viewport (`Scene.tsx:185-195`) and the edit UI (`PropertiesPanel.tsx:60`). `effectiveAssembly` synthesizes an **identity-posed** `body0` (`worker/geometry.worker.core.ts:52-69`, verified); `lowerAssembly` reads only instance poses (`worker/lower.ts:59-72`). Gizmo-drag a part to (0,0,0.5) → press Simulate → the part **teleports to origin** (`Viewport.tsx:54-62` renders manifest poses); drop-test ground/lift are computed from the un-posed body.
2. **File export ships ONE unposed body; the assembly is silently dropped.** The worker `export` op rebuilds features only (`geometry.worker.core.ts:103-120`, verified) — `req.doc.assembly` never consulted. A 3-instance mated assembly exports as one copy at the local frame; status reports "exported STEP" unconditionally (`registry.ts:96-119`). glTF is positions+indices only — no normals, materials, or node transforms (`packages/cad/src/io/index.ts:100-170`).
3. **`.assy` round-trip destroys mates and joints** — ✅ **FIXED (2026-07-18).** The `.assy` schema now carries the whole constraint graph: per-link `fixed` (ground flag) plus `mates`/`joints` referencing instances by flattened-instance index, fully validated at parse (kinds, indexes, valued-mate values, non-zero joint axes, limits) with bounds checked at realize. `assemblyToAssy` exports all of it (throws on a dangling instance ref rather than silently emitting a broken doc); `realizeAssembly` realizes it back and — when NO link declares `fixed` — grounds the FIRST instance, matching `addInstance`'s convention, so an imported assembly simulates anchored instead of free-falling. The import status now reports instance/mate/joint counts AND the honest caveat that all instances render the currently open part (`part` names still bind no geometry — the multi-part library remains a future milestone, now disclosed instead of silent). Round-trip test (`assy.test.ts`): fixed flags + a picked coincident mate + a valued distance mate + a limited revolute joint survive export→JSON→parse→realize exactly. Was: schema has no mates/joints vocabulary (`assembly/assy.ts:36-44,211-222`); import also grounds nothing (`assy.ts:172-190`) so an imported assembly **free-falls entirely** at Simulate (contrast `addInstance` grounding instance 0, `store.ts:548`); `.assy` `part` names bind no geometry — N instances all clone the currently open part (`assy.ts:6-7`, `lower.ts:45-72`), with no caveat in the import status.
4. **Editing during a running sim never invalidates it** — ✅ **FIXED (2026-07-18, auto-stop path).** Any document mutation while `simulating` now STOPS the sim with a status note ("simulation stopped — the document changed (press Simulate to rerun)"), mirroring the Stop action's exact state (workspace kept, so the user can rerun from the Simulate tab). Implemented at the store choke points, so every UI surface is covered without per-panel gates: `stopStaleSim` rides `pushHistory` (all undoable mutations — features, params, placement, instances, mates, joints), plus the history-less paths that still change what builds — `updateParams({history:false})` live drags, `undo`/`redo`, `loadDocument`/`replaceDocument`, and `setRollback` (the rollback bar). The viewport's existing `simulating` subscription tears the simulator down. Live sim CONTROLS (pause/step/rewind, `setSimExperiment` restart, joint-drive preview, selection) deliberately do NOT stop. Tests (`store.test.ts` §2.11.4 block, 6 cases). Was: Only context-menu actions gate on `!ctx.simulating` (`config.ts:137`); PropertiesPanel/FeatureTree/AssemblyTree have zero gates (grep verified by agent); rebuilds keep updating the rendered mesh mid-sim while the manifest/colliders stay stale; only `simExperiment` changes restart (`store.ts:709-714`).
5. **Joint frames go stale** — ✅ **FIXED (2026-07-18).** New pure `reanchorJoints(joints, oldInstances, newInstances)` in `assembly/model.ts`: a joint's baked world frame is physically attached to its PARENT instance, so when a solve re-poses that parent the frame rides along — express origin/axis in the old parent's local frame (via the pose conjugate), then re-world them under the new pose. `solveAssembly` applies it on every solve, so lowered constraints attach where the parts actually are. Joints whose parent didn't move return the SAME object reference (no float churn on repeated solves); a child-only move or an unknown parent leaves the frame untouched. Separately, `bodyMinMaxZ` now rotates each COM-local hull point by the body's spawn orientation before reading its world z, so experiment ground height is right for rotated instances (a tall slab laid on its side no longer gets the standing part's ground plane). Tests: `model.test.ts` (4 re-anchor cases incl. the rotation and identity-reference cases), `store.test.ts` (a real mate solve moves a joint's parent and the frame follows by the same delta), `experiments.unit.test.ts` (standing vs. 90°-rotated slab produce different, correct ground tops). **Still open from this item:** the mate solver itself does not treat joints as *constraints* (`solveMates` takes components+mates only), so a joint does not restrict how the solver may move its child — joints lower to sim constraints but do not participate in design-time mate solving. That is a solver-scope design gap, not a stale-frame bug. Was: `applyJoint` bakes world-frame origin/axis at creation (`store.ts:662-687`); `solveAssembly` re-poses instances but never re-anchors joints, and the mate solver ignores joints (`assembly/model.ts:205-229`) — lowered constraints attach at outdated frames (`lower.ts:78-91`). Experiment ground height uses COM + **unrotated** hull extents (`sim/experiments.ts:100-116`) — wrong for rotated instances.

**Actionable outline:** compose the placement pose into `effectiveAssembly`'s synthesized body and into every export (or refuse to export/simulate with an uncomposed placement and say so); export assemblies as posed compounds (STEP) / node hierarchies (glTF) or emit an explicit "assembly not included" warning; extend `.assy` with mates/joints + ground flag; gate document edits during sim or auto-stop with a status note; re-anchor joints after solve; rotate hull points in `bodyMinMaxZ`.

### 2.12 Destructive data paths: applies wipe undo; unvalidated commits; mesh edits unprotected

**Where (all verified or agent-cited):**

1. **Every AI/ML apply lands through `loadDocument`, which wipes undo history** — ✅ **FIXED (2026-07-17).** New history-preserving `replaceDocument` in `store.ts` snapshots the current document onto the undo stack BEFORE swapping, so accepting an AI/ML edit is a SINGLE undoable step. All five apply sites now use it (`ai/agentTurn.ts` build_part + ML apply, `three/contextmenu/mlActions.ts`, `ai/GenerationPanel.tsx` reconstruct + nurbs); `loadDocument` (which still wipes, correctly) is left only for project OPEN/recovery (`main.tsx`, `projectsStore.ts`). Both share one `docLoadState` helper so they cannot diverge on how a doc is loaded. Test (`store.test.ts`): a manual box survives an AI `replaceDocument` and one undo restores it; `loadDocument` still wipes. Was: (`store.ts:806-816`, verified: `past: [], future: []`) — `ai/tools/buildPart.ts:25`, `ai/agentTurn.ts:81,116`, `three/contextmenu/mlActions.ts:87` (which also sets `currentId: null`, detaching the open project), `ai/nurbs.ts:35`. One accepted AI edit makes an hour of manual edits un-undoable.
2. **Service STEP is committed destructively before validation.** `runReconstructBrep`/`fitMeshToCad` call `loadDocument` with the returned STEP un-parsed (`mlActions.ts:51`, `ai/nurbs.ts:67-70`); garbage STEP fails later in the worker (`rebuild.ts:777-799`) → empty viewport, no undo, source mesh discarded (`mlActions.ts:88-89`).
3. **Mesh-document edits bypass autosave, crash recovery, AND the unsaved-changes guard.** Mesh edits write `activeMeshDoc` (`Viewport.tsx:153-167`); `wireAutosave` subscribes only to cad+voxel stores (`persistence/projectsStore.ts:161-175`); `unsavedGuard.ts:37-48` never marks `"mesh edited"` dirty → close tab, all sculpt edits gone, no prompt.
4. **Stale timers cross projects:** autosave/recovery thunks read current state at fire time and are never cancelled by `open()`/`newProject()` (`projectsStore.ts:62-65,159,261-330`) — switching projects within 1.5 s drops pending edits and snapshots the *new* project as dirty.

**Actionable outline:** make AI/service applies go through a history-preserving `replaceDocument` (snapshot before swap); parse/validate STEP in the worker **before** committing and keep the mesh on failure; subscribe autosave/guard to `activeMeshDoc`; cancel pending persistence timers on project switch.

---

## 3. Why "NONE work": the compound failure chain

| User attempt | Where it dies | Finding |
| --- | --- | --- |
| Draw a rectangle → constrain it | constraint buttons never enable (points-only selection) | §2.6.1 |
| Drag to adjust the sketch | constraints visibly violated, no re-solve | §2.6.2 |
| Draw a circle snapped to an existing corner | corner point deleted; profile silently lost | §2.6.3 |
| ~~Plate with a hole (rect + inner rect)~~ | ✅ FIXED — the inner loop is classified as a hole; the plate builds with a real slot (exact volume) | §2.7 |
| Sketch on the XZ plane (by document/AI) | v-axis maps to −Z → Z-mirrored geometry | §4.8 N5 |
| Extrude works → extrude again with "new body" | first body destroyed | §2.4 |
| ~~Join two pads → shell/fillet the top~~ | ✅ FIXED — the boolean unifies same-domain faces, so `topFace` selects the whole joined face (10 faces → 6) | §2.2 |
| ~~Model anything round without the sketcher~~ | ✅ FIXED end-to-end — Primitives ribbon panel → cylinder/sphere/cone/torus; Op=cut bores a block with NO sketch feature in the document | §4.11 |
| ~~Export STEP and open it in another CAD~~ | ✅ FIXED — the file declared MM while carrying SI numbers, so a 20 mm part read as 0.02 mm; both boundaries now convert | I1 |
| Fillet a hole rim → change the hole radius | ref never re-resolves → feature errors | §2.1 |
| Shift-click 3 edges → right-click → Fillet | right-click miss wipes the selection | §2.8.2 |
| Select a face for shell → click near part center | TransformGizmo grabs the click → accidental body move | §2.8.4 |
| Fillet after any topology-changing rebuild | stale pick ids target different entities | §2.8.1 |
| ~~Add a mate (toolbar or menu)~~ | ✅ FIXED — clicking instance faces in mate mode records picks (0/2 → 2/2), marks them in 3D, and solves | §2.9 |
| ~~Any raw kernel failure (tight radius, axis-crossing profile)~~ | ✅ FIXED — the feature is badged with its own message, the rest of the model still builds, and no stale mesh is left on screen | §2.5 |
| ~~Sweep along a selected edge~~ | ✅ FIXED — sweeps the picked edge chain, re-resolved each rebuild | §2.3 |
| Sweep along a drawn path | spine position silently ignored (WithContact=false) | §4.8 N2 |
| Loft three sections | UI hardwired to last two sketches | §5 W4 |
| Edit an AI-generated part's hole diameter | AI sketches carry no `data.model` → un-editable by hand | §12 A1 |
| Change a revolve axis / mirror plane / pattern direction | param never baked → panel can't add it → unreachable | §9 |
| Define "wall = 2 mm" and reuse it | named params are a dead store field | §2.10.1 |
| Roll back → insert a feature | appended beyond the bar → silently invisible | §2.10.2 |
| Delete a sketch another feature uses | consumer silently rebinds to a different sketch | §2.10.3 |
| ~~Move a part → Simulate~~ | ✅ FIXED — the placement pose lowers into body0 AND seeds the sim render; exports bake it too | §2.11.1 |
| Export a mated assembly to STEP | one unposed body; assembly dropped, no warning | §2.11.2 |
| ~~Import `.assy` → Simulate~~ | ✅ FIXED — declared `fixed` flags apply (first instance auto-grounds when none declared); mates/joints round-trip | §2.11.3 |
| Apply an AI/reconstruct result | undo history wiped; garbage STEP → empty viewport | §2.12 |
| Sculpt a mesh 20 min → close tab | no autosave, no recovery, no prompt | §2.12.3 |
| ~~Ship it~~ | ✅ FIXED — `tsc` clean; production build succeeds | §2.3 |

---

## 4. Kernel operation layer (packages/cad)

All 348 package tests green; memory discipline near-exemplary (sole gap: `Solid.copy` can leak its copier on throw, `solid/solid.ts:30-35`). §4.8 adds the live numeric-repro results; §4.9 the verified-correct list.

### 4.1 extrude (`action/extrude.ts`)

- **P1** Options are only `back` + `direction` (`extrude.ts:15-20`). Missing vs standard (§14.7): draft-while-extrude, thin/surface extrude, up-to-vertex/up-to-body, through-all, symmetric flag, per-feature boolean result type with target selection.
- **P2** No guard that `direction` isn't near-parallel to the sketch plane — degenerate/self-intersecting output passes the only check (`IsNull`, `extrude.ts:86`); no `BRepCheck_Analyzer` on results.
- **P2** Negative-height semantics undocumented; validation only rejects `height + back === 0` (`extrude.ts:56`).

### 4.2 extrudeToFace (`action/extrude.ts:229-452`)

Genuinely strong (true trim, plane extension, curved-coverage witness, exact-volume tests). Remaining: **P1** `lumps !== 1` rejection (`extrude.ts:355-360,432-437`) forbids legitimately disconnected results; **P2** side selection via target-centroid projection can pick the wrong direction for wrapping faces (`extrude.ts:257-261`); **P2** planarity classified against a 1e-4-deflection mesh with `PLANAR_TOL = 1e-7` (`extrude.ts:106`). In the app, extrude-to-face **always unions** (`rebuild.ts:269-279`) — no "cut to face".

### 4.3 boolean (`action/boolean.ts`) — see §2.2

### 4.4 revolve (`action/revolve.ts`)

- **P1** No profile-crosses-axis check — surfaces as a raw wasm throw whose message is **`undefined`** (live-verified; `revolve.ts:41`). No thin, two-direction, or up-to-face revolve.
- **P2** `angle > 2π` silently wraps modulo 2π — live repro: 3π request → **exactly half** a full turn's volume, `IsValid()=true`, no warning.

### 4.5 loft / sweep (`action/loft.ts`)

- **P1** No section winding/`CheckCompatibility` harmonization — opposite-winding sections loft twisted/self-intersecting **silently**. No closed loft, vertex end-sections, or guide curves.
- **P1** Sweep ignores the spine's absolute position: `loft.ts:100` passes `WithContact=false` (verified) while `sketch/spine.ts:1,19` declares world coordinates and `rebuild.ts:429-495` passes editor world-space paths — live repro: path drawn at x=30 mm produced the solid **at the profile origin**. A user/AI drawing the path where the solid should appear gets it silently elsewhere.
- **P1** No scale/twist along spine; spine never from model edges (pairs with §2.3); modes limited to Frenet/corrected-Frenet.
- **P2** `loft.ts:51-52` — `Build()` without `IsDone()` before `Shape()` → opaque `Standard_Failure` instead of "loft failed" (sweep checks correctly, `loft.ts:102-105`).
- **P2** Sweep `transformed` transition on a 90° corner returns a self-intersecting solid as success — live repro: volume exactly half of `right`/`round` (mode is user/AI-exposed, `schema.ts:221`, `rebuild.ts:457-477`).

### 4.6 pattern (`action/pattern.ts`)

- ~~**P2** `circularPattern(angle=0, count>1)` → step 0 → N coincident copies…~~ ✅ **FIXED (2026-07-17).** Both `circularPattern` (angle=0) and `linearPattern` (spacing=0) now throw for `count > 1` — a degenerate step placed every copy on the base, and the fuse collapsed them back, so the pattern silently did nothing. `count === 1` (just the base) still needs no spacing/angle. Tests in `pattern.smoke.test.ts`.
- **P1** Patterns duplicate the whole body, not a feature (`toolFeatures` subtree at `rebuild.ts:687-707` is the partial workaround); no 2-direction grid; no instance suppression.
- **P2** Default-axis inconsistency: rebuild's revolve default axis is +Y (`rebuild.ts:323`) but circularPattern's is +Z (`rebuild.ts:722`).

### 4.7 dress-ups (`action/dressup.ts`)

- §2.1 hits all four via ref resolution.
- **P1 (live-verified)** Every shelled body carries **1 mm** edge/vertex tolerance: `MakeThickSolidByJoin(..., 1e-3, ...)` at `dressup.ts:206` (verified) is a mm-habit constant in a metres kernel — measured: edge/vertex tol 0.001 m (10,000× the 1e-7 baseline); `Solid.boundingBox()` pads exactly 1 mm/side; every downstream boolean/selection/export on a shelled body inherits mm-level slop. Should be ~1e-6.
- **P2** Silent parameter drops: `chamfer` with `distance2` but no `face` → silent symmetric chamfer (`dressup.ts:99-100`); `fillet` with `endRadius: NaN` → silent constant radius (`dressup.ts:37`).
- **P1** No tangent-edge-chain propagation for fillet; variable radius linear R1→R2 only (`dressup.ts:47`).
- **P2** No per-edge failure diagnosis; unabsorbable radius throws an opaque numeric `Standard_Failure` (`dressup.ts:38-40`; §14.3 for the probing pattern).
- **P2** Shell: negative thickness silently flips semantics (`dressup.ts:196`). Draft: no `AddDone()` check (`dressup.ts:254`); single-face API (rebuild loops sequentially, `rebuild.ts:604-620`); angle-sign semantics real but undocumented — measured: +5° **removes** material (exact wedge ±787.40 mm³), neutral origin respected; `DraftOptions` (`dressup.ts:232-240`) and the AI prompt say nothing about the sign convention.

### 4.8 Numeric/semantic defects found by live repro (33 runs, real vendored OCCT)

| # | Sev | Defect | Evidence |
| --- | --- | --- | --- |
| N1 | P1 | Shell tolerance 1e-3 m (1 mm) contaminates every shelled body | `dressup.ts:206` (verified); measured bbox pad exactly 1 mm/side |
| N2 | P1 | Sweep ignores spine position (`WithContact=false` vs world-coord contract) | `loft.ts:100` (verified); `spine.ts:1,19`; repro: solid at profile, not path |
| N3 | P1 | On-face sketch frame spins 90° when the face normal's X component crosses the hard 0.9 threshold | `faceFrame.ts:35-36` (verified); repro: 25°→27° tilt flips xAxis, dot = 0.0 |
| N4 | P1 | AI boolean legacy dims can never build + are never unit-converted (`data` vs `params` split) | `schema.ts:224-233` (verified) vs `rebuild.ts:754-761`; `convData` `schema.ts:351-356` |
| N5 | P1 | XZ datum plane maps sketch v to **−Z** (normal +Y, xAxis +X → yAxis [0,0,−1]) | `env/plane.ts:24-26,39-41` (verified); repro: rect v∈[0,10] extrudes z∈[−10,0]; XY/YZ fine; interactive sketcher self-consistent (`sketch/worldMap.ts`) but document/AI authoring gets mirrored geometry; prompt documents nothing about plane axes |
| N6 | ✅ FIXED | Revolve now REJECTS |angle| > 2π (was: silent mod-2π wrap, 3π → half volume). Full turn accepted, negative legal | `revolve.ts:20-31`; `revolve.smoke.test.ts` |
| N7 | P2 | Sweep `transformed` transition on 90° corner → self-intersecting solid as success | repro volumes: right 4712.4 / round 4676.6 / transformed 2356.2 mm³ |
| N8 | P2 | Axis-crossing revolve profile throws raw wasm exception, message `undefined` | `revolve.ts:41` |
| N9 | P2 | Draft sign semantics undocumented (+ removes material) | `dressup.ts:232-240`; measured ±787.40 mm³ wedge |
| N10 | P2 | `inspectGeometry` mixes SI and mm in one payload (centroid/midpoint metres; radius/area/length mm) | `ai/tools/inspectGeometry.ts:232-245` |

### 4.9 Verified numerically correct (live, exact values — important calibration)

Extrude oblique `direction` normalized, `height` along the direction (vol A·h/√2 exact), `back` collinear; `cutProfileHoles` uses identical height/back/direction (oblique subtract exact); revolve radians/right-hand rule/off-origin axis/Pappus + torus exact, negative angle mirrors; **the entire mm↔SI unit chain is clean** — `featureUnits.ts` tables match every `num()/opt()` read one-to-one; panel/gizmo/AI converter/placement all convert correctly; registry defaults genuinely SI. Mirror normalizes non-unit normals (gp_Dir), off-origin planes exact; rotate radians/RH/pivot exact. linearPattern unitizes direction; circularPattern respects origin, partial-arc endpoint-inclusive (Fusion convention), full-turn exclusive. Shell inward/outward geometry exact (only the tolerance N1 is wrong). Draft neutral origin respected. Torus tessellates 1 group/0 dropped; 0.02 mm sliver kept; hollow-cube volume/COM/STEP-round-trip exact. `offsetPlane` + along +normal.

### 4.10 selection kernel (`select/predicates.ts`, `select/topology.ts`)

- **P1** `tangentFaces` seed matching has no distance threshold — stale seed snaps to nearest centroid anywhere and grows the wrong selection silently (`predicates.ts:158-177`).
- **P2** `topFace`/`bottomFace` tie-break uses exact float equality on mesh-derived normals — tessellation jitter can flip which coplanar candidate wins (`predicates.ts:113-123`; pairs with §2.2).
- ~~**P2** `allEdges` includes cylinder **seam** edges…~~ ✅ **FIXED (2026-07-17).** `allEdges`, `verticalEdges` and `edgesParallelTo` now exclude seam edges (both adjacent face ids equal). A seam is not user-selectable and feeding it to MakeFillet failed the WHOLE op, so "fillet all edges" was a trap on any body with a hole/boss/fillet. Test (`predicates.unit.test.ts`): a bored body has a seam, allEdges omits it, and filleting the result builds a valid solid.

### 4.11 primitives / transform / solid / assembly solver

- ~~**P1** Box is the only primitive~~ — ✅ **FIXED (2026-07-17).** `makeCylinder` / `makeSphere` / `makeCone` / `makeTorus` (`solid/primitives.ts`), each placeable via a `gp_Ax2` (origin + axis) with an optional partial sweep angle. Round geometry no longer depends on the sketcher at all — "bores a block with a primitive cylinder, no sketcher involved" is now a test. Volumes asserted exactly (πr²h, 4/3πr³, frustum, Pappus 2π²Rr²), and each primitive's curved face reports the exact analytic surface a §2.1 FaceRef re-resolves it by. Degenerate inputs are rejected rather than built (self-intersecting torus, equal-radii "cone", zero radius). Needed `BRepPrimAPI_MakeOneAxis` (their shared base) in the trim: a derived class cannot be CONSTRUCTED unless its whole base chain is bound — the leaf alone throws `UnboundTypeError` at first call, which is exactly how an under-listed class survives a green suite. Tests: `solid/primitives.test.ts` (18). **Still kernel-only — no ribbon/AI surface yet (see below).**
- ~~**P1** No scale operation~~ — ✅ **FIXED (2026-07-17).** `scale(oc, solid, factor, centre?)` in `action/transform.ts`. Uniform only, deliberately: `gp_Trsf` models a similarity transform and a non-uniform scale is not one — per-axis factors via `gp_GTrsf` turn circles into ellipses, degrading every analytic surface the kernel relies on (§2.1 signatures, fillets, offsets) into B-splines. Rejects `factor <= 0` (zero collapses the solid to a point; negative silently inverts orientation — OCCT complains about neither). It is also what I1's interchange boundary uses.
- **The primitives are WIRED END-TO-END, not kernel-only (2026-07-17).** They were briefly kernel-only — the same shape of gap as §2.9's unreachable `addMatePick` — and are now reachable by a real user:
  - **Evaluator:** `cylinder` / `sphere` / `cone` / `torus` feature types (`worker/rebuild.ts`), with `data.op` = `join` (default once a body exists) | `cut` | `intersect` | `new`, mirroring the extrude convention. **`cut` is the payoff: subtracting a cylinder IS a bore, with the sketcher out of the loop entirely** — a test builds a bored block from a document containing NO sketch feature.
  - **Ribbon:** a new "Primitives" panel in the Solid tab. Selection-driven per the C6 convention — a picked face supplies the origin (its centroid) and axis (its normal), so "select a face → Cylinder" lands a boss, or a bore with Op=cut.
  - **§9 compliance, deliberately:** every param is baked at creation — `ox/oy/oz`, `ax/ay/az` and `angle` included, even at their defaults — because `FeatureEditor` iterates ONLY `Object.entries(feature.params)`, so a param creation omits can NEVER be added by the panel later. This is the exact defect that leaves mirror's `ny/nz/oy/oz` and revolve's axis permanently unreachable (§9); the primitives do not repeat it.
  - **Units:** rows in `featureUnits.ts` LENGTH/ANGLE tables, so the properties panel's mm/deg display and the AI mm→SI converter both work automatically (they read that single source). Axis components are unitless scalars and are correctly in neither table.
  - **AI:** zod arms for all four in `ai/tools/schema.ts`, with optional placement + `data.op`.
  - Tests: `worker/rebuild.test.ts` (7) — exact analytic volumes through the evaluator, the no-sketch bore, a joined boss, a non-default (+X) axis, `angle >= 2π` meaning a FULL solid rather than a degenerate wedge (the ribbon's baked default), and a degenerate torus failing loudly.
  - **Not done:** no gizmo for radius/height (the `featureGizmo.ts` drag contract), and no primitive entries in the right-click context menu — both are §6/§9 surface gaps, not §4.11 ones.
- **P2** `volume()` on open shells/compounds returns garbage without error (`solid/solid.ts:46-52`) and is used as a success proxy (`extrude.ts:350,419`).
- Assembly solver is a real LM solver (numeric Jacobian, rank DOF, teleport-regression suite). **P1** local minima reported "over-constrained", no multi-start (`solver.ts:309-323`); **P1** joints impose no kinematic constraint in the solve (`lower/joints.ts:31-38` consumes them only for physics); no tangent/lock mates or limits. **P2** O(mates × 6·free²) forward-difference Jacobian; `distance` residual non-differentiable at 0 (`solver.ts:121-122`).

---

## 5. App wiring (ribbon/registry/worker plumbing)

The pipeline is real and single-sourced: gesture → `actions/registry.ts` → `useCadStore.addFeature` → coalesced build (`three/Viewport.tsx:204-266`) → `GeometryClient` RPC 120 s timeout (`worker/bridge.ts:57-75`) → worker `handleRequest` never throws (`geometry.worker.core.ts:76-176`) → `rebuildDocument` → transferable mesh → r3f. Headless CLI (`headless/nodeBuild.ts:165-183`) and AI `build_part` (`ai/tools/buildPart.ts:96-111`) use the **same** evaluator. Worker OCCT init memoized with failure-reset (`geometry.worker.ts:24-32`).

| # | Sev | Finding | Evidence |
| --- | --- | --- | --- |
| W1 | ~~P0~~ ✅ FIXED | Production build failed typecheck (5 errors). `tsc` clean; `pnpm --filter plastiq build` succeeds | §2.3 |
| W2 | ~~P0~~ ✅ FIXED | Sweep ignored the picked edge. Now sweeps the picked edge chain via parametric `data.pathEdges` (re-resolved each rebuild); false status text removed. Typed-path editor remains open under §9 | §2.3 |
| W3 | P1 — **CONFIRMED + WIDER** | Stale e2e spec clicks now-disabled demo Loft/Sweep buttons → Playwright timeout. **Verified by running the suite (2026-07-17): 21 pass / 6 fail.** W3 is real, but it is one of SIX failures, and the dominant cause is a *different* stale locator — `getByTestId("feature-menu").getByText("Sketch", {exact:true})` now matches the sketchLauncher widget and opens the sketcher, unmounting the Solid tab so the next `add-extrude` click waits out its 240 s timeout. Seven specs use that locator. See §13.8 | `e2e/plastiq/cad-features.spec.ts:271-313`; `ribbon/WorkspacePanel.tsx:96`; `extrude-guard.spec.ts:21-29` |
| W4 | P1 | Loft UI hardwired to last two sketches; evaluator handles N sections | `registry.ts:275`; `rebuild.ts:375-427` |
| W5 | P1 | Baked `transform` has no UI entry → geometry ops act in unmoved frames | `registry.ts:496-506`; `rebuild.ts:628-660,801-805` |
| W6 | ~~P1~~ ✅ FIXED | 2 failing tests: palette filters by `enabled(ctx)`; loft predicate needs ≥2 sketches; test seeded none. Tests now seed two profile-carrying sketches (satisfying the real product gate). A *third* pre-existing failure the audit missed — `app/capabilities.test.ts`, whose `stubAllPresent()` did not stub `localStorage` (absent from this jsdom, so the probe correctly reported it missing) — is also fixed. Suite now fully green | `ai/CommandPalette.test.tsx`; `app/capabilities.test.ts` |
| W7 | P1 | `booleanBody` reads `params.depth` off a sketch that never carries it → tool always 0.05 m | `registry.ts:485-486` |
| W8 | P2 | (superseded by §2.8.1 — live picks stale across rebuilds) | `Viewport.tsx:216-243`; `store.ts:384-395` |
| W9 | ~~P2~~ ✅ FIXED | Error feedback missed raw kernel throws (no badge, stale mesh). Now structured per-feature `statuses`; regex attribution removed; stale mesh cleared | §2.5 |
| W10 | P2 | Vertex selection mode has no consuming operation | `three/Picking.tsx:53-63,148-172,330` |
| W11 | P2 | Stale module header claims picking/gizmos/sketch camera "not wired here yet" — all are wired | `Viewport.tsx:5-7` vs `three/Scene.tsx:293,319,342-351` |

`src/timeline/` is five zero-byte scaffold files imported nowhere (intentional per project owner — do not delete; the live "timeline" is FeatureTree + rollback).

---

## 6. Viewport interaction layer (three/, viewport/)

P0 items are in §2.8/§2.9. Remaining findings:

- **P1** FeatureEditGizmo arrow uses the wrong axis/anchor for on-face sketches and explicit deps: `featureEdit.gizmo.tsx:244-259` walks to the most recent sketch *by index* (not `deps`) and returns null for face-derived sketches → defaults to XY/Z (`:34-48`) — a vertical-face extrude gets a Z arrow while the solid grows along the face normal. Typing/scrub still work.
- **P1** Fit-to-view ignores mesh bodies (`Scene.tsx:204-212` uses `builtPart` + cloud only) — in a mesh doc it frames the default 0.1 m box.
- **P1** Right-click in mesh/cloud mode always clears the mesh sub-selection before showing the `ml-*`/`cloud-*` menu (`Scene.tsx:293,319` mount `part={null}` → `pickAt` misses → `clearPicks()`, `useCanvasRightClick.ts:125-127`).
- **P1** Camera/navigation: no orthographic toggle for the main camera (fixed perspective 45°, `Viewport3D.tsx:34`); view cube is a static isometric SVG — only Top/Front/Right + 3 edges + 1 corner clickable, and it does not rotate with the camera (`viewport/ViewCube.tsx:47-78`); no zoom-to-selection; fixed 0.4 m grid (`Scene.tsx:336`).
- **P1** Measurement is two-click point distance only (`viewport/measure.ts`; `Picking.tsx:416-423`): no edge length/face area/angle/entity-distance; dead against mesh docs/instances.
- **P1** Datum/preview gaps: sketch-plane quad and construction geometry not drawn for face sketches, no arcs/splines in construction display, offset gizmo display-only (`three/gizmos/plane.gizmo.tsx:4-30`, `constructionGeometry.gizmo.tsx:4-25`, `offset.gizmo.tsx:4`); **no persistent user datum planes anywhere**; no ghost previews — ops commit immediately with defaults, and a failing default (3 mm fillet too big) lands as a broken feature.
- **P1** Menu/ribbon asymmetry: loft/sweep/mirror/patterns/booleanBody/transform/import/export exist only in the ribbon (never selection-driven); `sketch-on-face`, `shell-outward`, `revolve-about-edge`, `cut-along-edge`, `cut-two-sided`, feature-history ops exist only in the menu (`ribbon/ribbonConfig.ts:38-111,188`). Extrude/cut/revolve are **not offered when right-clicking a face** (guards `kind empty|body`, `config.ts:171-223`) — the most natural CAD gesture.
- **P2** Hover over empty space inside the part bbox does a full GPU-id render + readback per pointermove (`Picking.tsx:305-319`); box-select has no window/crossing distinction and selects occluded entities (`Picking.tsx:379-406`, `viewport/pick.ts:48-55`); section silently falls back to an axis X-cut if `picks[0]` is an edge (`config.ts:592`); mate distance/angle values use `prompt()` (`config.ts:499-521`); context-menu anchor in mesh mode can be far from the cursor (`useCanvasRightClick.ts:52-60`).

**Verified healthy:** group→faceId mapping + unit tests (`viewport/pick.ts:17-27`); per-face vertex blocks → no GPU-id bleed (`tessellate.ts:118-136`); id+1 encoding; GPU picker state save/restore (`three/gpuPick.ts:88-107`); shared picker ref-counting (StrictMode-safe); candidate cache invalidated per rebuild; refs table swapped atomically with the mesh; highlight idempotency; measure math; section plane + cap fill; placement pose convention pinned; select-then-menu preserves an existing multi-select when clicking inside it; doc-mode menu filtering; heterogeneous multi-select (face+edge two-distance chamfer) works; `runContextAction` honors `enabled()`.

---

## 7. Sketch subsystem

Root causes in §2.6/§2.7. Additional findings:

- **P1** Loop closure is point-id identity only — endpoints made coincident *by constraint* leave degree-1 vertices → no profile, Finish disabled, no diagnostic (`profile.ts:57-63`).
- **P1** Dangling constraint refs silently dropped from the solve set (`model.ts:288-289,341-343` `if (l)` guards) — spec §10.3 requires marking + recovery.
- **P1** The whole inference/snap module is disconnected: `nearestSnap`/`segmentHint`/`lineHint` (`sketch/infer.ts:32,89,127` — implemented, tested, 187 lines) referenced only by dead code; the live path has a crude inline snap (fixed 0.002 m radius, zoom-independent; H/V only at 0.001 m; no midpoint/centre/grid; no snap markers).
- **P1** No parameters/expressions in dimensions (spec §4.4).
- **P2** arcCenter sweeps CCW only (`model.ts:174`); self-intersection never detected (spec §9.2); hole containment centre-only with coarse arc sampling (`profile.ts:130-136,165`); spline display (Catmull-Rom, `SketchScene.tsx:252-255`) ≠ kernel (C2 B-spline fit, `sketch.ts:144-150`); worker `facePlane` resolves against the full-document build while rebuild resolves at the sketch's history position (`geometry.worker.core.ts:121-155` vs `rebuild.ts:228-243`) — editing frame ≠ build frame for early sketches; large dead-code inventory in `Sketcher.tsx` (GridAndAxes :42, SketchGeometry :149, DragDrawPreview :1159, InferenceOverlay :1189, pan/drag refs :633-641, `hitTest` import :20).

---

## 8. Document model: store, undo, rollback, persistence

Root causes in §2.10/§2.12. Additional findings:

- **P1** No document schema version/migration for the doc payload itself (`store/types.ts:38-42`; container-level versions exist: SQLite `user_version` `persistence/sqlite.ts:39,101-125`, IDB v2 `persistence/idb.ts:17`). Unknown feature types fail loudly per-feature (good, `rebuild.ts:806-807`) but there is no newer-version detection.
- **P1** Undo history is a full structured clone per edit, capped at 100 — including multi-MB `importStep.data.step` text (`store.ts:260-279`): 100 steps × 8 MB import ≈ hundreds of MB. `geometrySignature` also `JSON.stringify`s the whole feature list (incl. STEP text) on every doc-affecting change (`Viewport.tsx:119-124,264`) — O(doc size) per keystroke.
- **P1** Finish-sketch-with-consumer is two undo steps (orphan sketch after one Cmd+Z) (`sketch/editFeature.ts:53-63`).
- **P1** No export/import of the parametric document itself — geometry-only export + `.assy`; a document is trapped in this browser's IndexedDB (`store.ts:779-783`; `registry.ts:523-527`).
- **P2** No-op edits on nonexistent ids still push history (`store.ts:397-423`); recovery snapshot deleted immediately on recover (`projectsStore.ts:459`); `loadAssemblyModel` re-implements `pushHistory` inline with its own literal cap (`registry.ts:162-181`); undo leaves dangling selection anchors (render-safe); autosave captures a WebGL `toDataURL` thumbnail every 1.5 s while editing (`projectsStore.ts:345`).

**Verified healthy:** ID discipline (single counter, re-derived on load, undo-restores `nextSeq`, all tested); undo coverage/coalescing for what it covers (gizmo single-step writes); rollback anchor-by-id reconciliation across remove/reorder/undo/redo; persistence integrity (save-to-deleted rejects, split-store migration idempotent, save failures surface and preserve the dirty snapshot); crash recovery for parametric/voxel/pointcloud/mesh *documents* with content-addressed STEP payloads and no geometry fabrication on loss; the rebuild dirty-tracking subscription design itself.

---

## 9. Parameter reachability (the editing-surface matrix)

**Systemic mechanism:** `FeatureEditor` iterates **only `Object.entries(feature.params)`** plus three injected keys (`back`, `radius2`, `distance2`) (`PropertiesPanel.tsx:386-400`, verified). The panel can never ADD a param the creation action didn't bake, and there is no editor for `data.*` beyond six specific widgets (op, boolean-op, ruled, shell direction, sweep mode/transition, deps) and the attach-refs buttons. The rebuild evaluator consumes ~20 `opt()`-defaulted params and ~15 `data` keys.

Legend: PANEL = editable; GIZMO = also drag-editable (7 types × 1 param, `featureGizmo.ts:22-30`); CREATE = baked at creation, never editable after; AI = only via build_part/headless; **UNREACH** = consumed by rebuild but no surface can set it in that flow.

| Feature | Param/key (rebuild.ts) | Reachability |
| --- | --- | --- |
| box | dx dy dz (:210) | PANEL (creation: seed or AI only — no UI "box" action) |
| sketch | data.profile (:213) | Sketcher only **iff data.model exists** — AI/sample-rect sketches: **UNREACH** (§12 A1) |
| sketch | data.model, data.plane (:219,:226) | Sketcher Finish writes all three (`editFeature.ts:45`) |
| extrude | height (:285) | PANEL+GIZMO (absent on toFace extrudes → **UNREACH** there) |
| extrude | back (:286) | PANEL injected (**dead field** on toFace extrudes — rebuild :269-279 ignores it) |
| extrude | data.op (:297) | PANEL select |
| extrude | data.direction (:256) | **AI-only** |
| extrude | data.directionEdge / data.toFace (:259,:268) | CREATE → no editor/removal; toFace locks the feature into to-face mode |
| ext/cut/rev/sweep | data.sketchId (:184) | **AI-only**, undocumented; **silently overrides** the panel's deps select |
| ext/cut/rev/sweep/bool | deps (:187) | PANEL select (first dep only) |
| revolve | angle (:321) | PANEL+GIZMO |
| revolve | ox oy oz ax az (:322-323) | **UNREACH from UI** — creation bakes only `{angle, ay:1}` (`config.ts:233-236`); axis cannot be tilted or moved |
| revolve | data.axisEdge (:324) | CREATE → no editor |
| loft | data.sections (:379) | CREATE → **no editor**; delete + re-run is the only recourse |
| loft | data.ruled (:412), data.op | PANEL |
| sweep | data.profile/path/plane (:434-455) | CREATE → **no editor** (status text promises one — §2.3) |
| sweep | data.mode/transition (:457-458) | PANEL selects |
| cut | depth/back (:514-515) | PANEL+GIZMO / PANEL |
| fillet | radius/radius2 (:545-547) | PANEL+GIZMO / PANEL |
| fillet/chamfer | data.edges (:155) | PANEL attach (replace-only; **no clear** → can never return to selector) |
| dress-ups | data.selector (:157) | **AI-only**; panel shows misleading "no edge/face refs" (`:319-323`); silently overridden by explicit refs |
| chamfer | distance/distance2/data.face (:557-567) | PANEL — the one fully reachable dress-up contract |
| shell | thickness/direction/faces (:577-579) | PANEL — healthy |
| draft | angle (:603) | PANEL+GIZMO |
| draft | data.pull/neutralOrigin/neutralNormal (:600-602) | CREATE → no editor; re-attach keeps stale kinematics (`PropertiesPanel.tsx:191-199` vs `dressup.ts:238-244`) |
| transform | all 10 params (:633-650) | **AI/headless-only** entirely |
| mirror | ox..oz nx..nz merge (:666-669) | Face-created: PANEL. Default-created (`registry.ts:364`): only `nx, ox, merge` baked → **ny nz oy oz UNREACH** — arbitrary mirror plane impossible |
| linearPattern | count spacing dx (:682-684) | PANEL; **dy dz UNREACH** on default creation (`registry.ts:388`) |
| linearPattern | data.toolFeatures (:687) | **AI-only** |
| circularPattern | count angle az (:721-729) | PANEL; **ox oy oz ax ay UNREACH** on default creation (`registry.ts:444`) |
| boolean | data.op (:747) | PANEL select — **display shows "subtract" for op-less features while rebuild defaults to union** (`PropertiesPanel.tsx:143-146` vs `rebuild.ts:747`) |
| boolean | data.toolFeatures (:748) | CREATE → no editor — the subtract tool's height is frozen forever |
| boolean | params dx..tz (:755-760) | AI-only, and **the AI schema documents them in `data`** (§4.8 N4) |
| importStep | data.step/stepRef (:786) | CREATE by design — healthy |
| placement | tx..rz | PANEL + gizmo — healthy |
| document | doc.params | **Consumed by nothing; no UI** — yet `prompt.ts:68` instructs the model to use it (§2.10.1) |

**Fix altitude:** `FeatureEditor` should surface each type's known param schema (`store/featureUnits.ts` LENGTH/ANGLE tables already enumerate them) with rebuild's defaults, plus editors for the load-bearing `data` keys (sections, path, selector, toolFeatures). `FEATURE_SECONDARY_PARAMS` (`featureGizmo.ts:37-46`) — the documented T16 secondary-edit contract — has **zero consumers**.

---

## 10. Cross-package integration

Root causes in §2.11. Per-flow status:

| Flow | Status | Evidence |
| --- | --- | --- |
| Placement → viewport pose | HEALTHY | `Scene.tsx:185-195`; `placement.ts:37-46` |
| Placement → sim manifest | ✅ FIXED — `placementPoseOf` poses `body0` (worker) + seeds `simBodies` (viewport), same shared helper | §2.11.1 |
| Placement → STEP/IGES/glTF | ✅ FIXED — `posePlacementForExport` bakes the pose via kernel rotate/translate; STEP round-trip test | §2.11.1 |
| Assembly (instances+poses) → sim manifest | HEALTHY | `lower.ts:45-97`; `lower/export.ts:47-85`; e2e assembly-to-sim |
| Assembly → STEP/glTF export | **MISSING** (§2.11.2) | `geometry.worker.core.ts:103-120` |
| Mates UI → kernel solver | ✅ FIXED — instance pick handler wired (`Assembly.tsx` → `viewport/matePick.ts` → `addMatePick`); solver was always real (`store.ts:721`) | §2.9 |
| Joints UI → sim constraints | ✅ FIXED — frames re-anchor to the moved parent on every solve (`reanchorJoints`); joints still don't constrain the mate solve itself | §2.11.5 |
| `.assy` import → live assembly | ✅ FIXED — grounds (declared or first-instance fallback); status reports counts + clone-parts caveat | §2.11.3 |
| `.assy` export | ✅ FIXED — full constraint graph (fixed/mates/joints) round-trips; dangling refs throw | §2.11.3 |
| BOM | HEALTHY | `BomSection.tsx:17` → `deriveBOM` |
| Mesh doc → CAD ops | ISLAND — bridges are network services only (:8000 reconstruct, :8003 nurbs) | `mlActions.ts:38-73`; `registry.ts:681-689` |
| OBJ/STL/GLB disk import | **ABSENT** — the app cannot import a mesh file at all (`.step`, `.assy`, point clouds only) | `registry.ts:145,202`; `GenerationPanel.tsx:1334` |
| Service STEP → parametric doc | Shape healthy; **destructive ordering** (§2.12.2) | `reconstruct.ts:63-65`; `nurbs.ts:67-70` |
| Voxel sculpt → MeshDoc → services | HEALTHY | `registry.ts:621-679` |
| Sim render-back (COM→group) | HEALTHY | `sim/simulator.ts:21-34,99-112` |
| Edit-during-sim invalidation | **MISSING** (§2.11.4) | no `simulating` gates in panels; `store.ts:709-714` |
| Desktop (Tauri) export | UNVERIFIED/likely broken — blob-anchor downloads, no download plugin in `tauri.conf.json` | `registry.ts:108-114`; `apps/desktop/src-tauri/` |

Also: code throughout cites "SPEC-5 FR-11/FR-33/…" but **no SPEC-5 document exists** in `docs/specs/` (SPEC-6…13 only) — the placement-composition claims live solely in the two false code comments.

---

## 11. Infrastructure, IO, and lowering

**Verified healthy:** vendored wasm artifacts exist with provenance; OCCT init memoization + failure-reset (`oc/init.ts:61-73`); Vite dev+build wasm paths (`vite.config.ts:25-37`); tessellation defaults sane for metres (1e-4 m deflection, `tessellate.ts:29-30`) with REVERSED-winding handling and dropped-face/edge accounting (`tagged.ts:84-109`); glTF export refuses incomplete tessellations (`io/index.ts:105-109`); the 2026-07-03 FableFindings ground/fixed-flag P0 is **fixed** (`lower/component.ts:31-33`, `lower/export.ts:51,80`, `lower/export.fixed.test.ts`); joints/mass props lower in SI with loud unknown-material errors.

| # | Sev | Finding | Evidence |
| --- | --- | --- | --- |
| I1 | ~~P1~~ ✅ FIXED | **STEP/IGES units — the 1000× interop error is gone (2026-07-17).** Confirmed exactly as reported: a 40×30×20 mm box exported as `CARTESIAN_POINT('',(0.,0.,2.E-02))` under `SI_UNIT(.MILLI.,.METRE.)` — "0.02 mm" for a 20 mm feature. Both boundaries now **scale** (m→mm on export, mm→m on import) rather than configure OCCT: `Interface_Static` binds but exposes **no embind statics**, so `SetCVal` does not exist at runtime, and the audit's suggested fix is unavailable (pinned by `oc/bindings.test.ts`). Needed a new kernel `scale` op (§4.11's other P1). Tests assert what is IN the file (largest coord 40, not 0.04; declared unit MILLIMETRE) + a 2 m beam writing 2000 mm — a self-round-trip **structurally cannot** catch this, which is why `io.test.ts:17` never did. **Cross-service:** `services/{reconstruct,nurbs}/occ_step.py` deliberately mirrored the old broken convention and now emit honest mm; `reconstruct/nurbs_delegate.py` converts mm→m on read (it round-trips STEP between the two services and failed by 1000³ ≈ 1e9 until fixed); a nurbs test that PINNED the defect (`test_step_coordinates_are_raw_metres_unscaled`) now pins the correction. reconstruct 149 pass, nurbs suite exit 0. | `io/index.ts`; `action/transform.ts`; `io/io.test.ts` |
| I2 | P1 | `importStep` collapses everything via `OneShape()` — multi-root assemblies become one compound; names/colors/structure lost | `io/index.ts:49` |
| I3 | P2 | Worker `facePlane` resolves against the full-document build; rebuild resolves at the sketch's history position → editing frame ≠ build frame for early sketches | `geometry.worker.core.ts:121-155` vs `rebuild.ts:228-243` |
| I4 | P2 | Doc/config drift: dead `occtNode` external + stale comment (`vite.config.ts:11-16,27,31`); stale STATUS in `occt.build.yml:8-11` contradicting PROVENANCE.md; stale `Viewport.tsx:5-7` header | cited |
| I5 | P2 | `ManifestBody` carries no inertia tensor (mass/com/colliders only) — contract implicit | `lower/manifest.ts:18-34` |
| I6 | P2 | Manifest gravity hardcoded `[0,0,-9.81]` | `lower/export.ts:16` |

---

## 12. AI and headless surface

- **A1 (P0)** AI-generated (and sample-rect) sketch geometry is un-editable by any manual surface: the prompt mandates sketch+extrude for round shapes (`ai/prompt.ts:30-39`), but AI sketches carry `data.profile` only, never `data.model`; "Edit sketch" is gated on `data.model != null` (`config.ts:389`, `editFeature.ts:18`); sketches have no params so the panel shows "No editable parameters." A user cannot change an AI part's hole diameter by hand — only by re-prompting.
- **A2 (P0)** The AI contract promises post-hoc editability that doesn't exist (`prompt.ts:68` → dead `doc.params`, §2.10.1).
- **A3 (P1)** Boolean schema/`params` split + missing unit conversion (§4.8 N4); zod accepts the broken shape.
- **A4 (P1)** build_part apply = `loadDocument` → undo wipe (§2.12.1).
- **A5 (P1)** No magnitude bounds; pathological counts freeze the single shared geometry worker without erroring (§2.10.4).
- **A6 (P2)** Boolean op display lies for op-less features (§9 matrix); stale `data.model` desync — manual "Edit sketch" after an AI edit reopens the stale model and Finish silently reverts the AI's profile (`editFeature.ts:50`); schema still accepts sweep `mode:"fixed"` (`schema.ts:220`) silently remapped (`rebuild.ts:460`); `draft` schema omits `selector` and extrude/cut/revolve omit `sketchId` — works only because buildPart converts the original input, not the zod copy (`buildPart.ts:71-75`), and will hard-reject under the grammar-constrained backend (`nodeBuild.ts:40-97`); prompt says "reference by index" but build_part has no index referencing (`prompt.ts:85` vs `toolDefs.ts:87`); CommandPalette truncates tool errors at 200 chars (`CommandPalette.tsx:294`); `inspectGeometry` unit mixing (§4.8 N10).

**Verified healthy:** buildPart atomicity chain (validate mm → convert → SI gate → off-store probe → apply) with real-OCCT integration tests; the mm↔SI choke-point with exact round-trip tests; inspectGeometry real area/length/classification; every prompt-taught selector exists in the kernel; headless session parity, capped runs, CLI exit-code contract.

---

## 13. Test coverage gaps (why green suites hid a broken product)

1. **No dress-up test touches curved geometry** — every fixture is a box (`dressup.test.ts:21-29`); §2.1 invisible.
2. **No re-resolve test across a topology-changing rebuild** (`edgecases.test.ts:744-763` re-resolves a planar face on an identical box).
3. **No boolean test with flush/coplanar bodies or post-boolean selection**; no tangent-solid or disjoint-intersect failure modes.
4. **The sketch interaction layer is untested end-to-end** (SketchScene handlers, `reusePointId` corruption, drag-without-solve — its tests are `describe.skip`'d, glyph pointer-events, solve-failure writeback, `frame={null}` mounting).
5. **No multi-loop / washer / self-intersection / coincident-closure profile tests.**
6. **Viewport:** zero coverage for transform-gizmo *drag*→placement commit (`gizmos-transform-view.spec.ts:35` skips it), featureEdit arrow drag, right-click on an edge/vertex, mate picking through the viewport (e2e bypasses via store seam — structurally cannot catch §2.9), box-select in edge/vertex/body modes, stale-picks-after-rebuild, hover-highlight correctness, mesh-doc canvas menu, pick button-filtering.
7. **Store:** add-while-rolled-back (§2.10.2), `setFeatureDeps` (no test at all), dangling-deps removal/suppression (§2.10.3), history eviction, autosave/recovery timer staleness, mesh-edit dirty gap.
8. **e2e reality:** most feature specs drive geometry through `__cadStore.loadDocument`/`__plastiqViewport` seams — real OCCT, but not clicks/dialogs (`cad-dressup.spec.ts:61-134`). **Zero e2e coverage:** file export (nothing touches `__plastiqExport`), `.assy` import/export, placement→sim/export consistency, joints through a real sim, editing-during-sim, STEP import from the disk picker, BOM, sweep-with-selection, multi-sketch loft, booleanBody, mirror/pattern-from-selection.

   **MEASURED 2026-07-17. A first PARTIAL run (timed out ~27 specs in) showed 6 failures; the FULL 90-spec run showed 13 across two waves.** The audit predicted ONE stale spec (W3). Nine were **stale/misdirected tests and are now FIXED**; four are **genuine product bugs** confirmed by driving the real UI. None are regressions from this session — `extrude-guard.spec.ts:6` PASSES while asserting `getByTestId("add-extrude")` is enabled and clicking it, which proves the ribbon (including the new Primitives panel) renders correctly.

   **FIXED (9 specs — stale/misdirected, each re-verified in isolation):** extrude-guard:21, a11y:11, recovery:12, feature-tree:32, feature-tree:74 (all clicked the stale `feature-menu > "Sketch"` text, which now OPENS the sketcher instead of injecting a profile — repointed at the newly-surfaced "Rectangle"/`act-sample-rect` profile injector); sketch-to-solid:31 + feature-edit-gizmo (helper) (asserted a 5-face prism but extrude now JOINS the seed box invisibly — see the **P0 note below**; start from an empty doc); cad-features:271 (clicked C4-removed demo Loft/Sweep — seeds two real profiles); assembly-to-sim:32 (expected 2 sim bodies, got 3 — the default drop-test experiment injects a ground slab; asserts 3, and the physics passes); context-menu:129 (asserted the DEAD Sketcher-local menu testid via a synthetic event on a pointer-events-none svg — the LIVE menu opens on a real canvas right-click as `canvas-context-menu` and genuinely offers the sketch constraints).

   **STILL FAILING — real §2.6 bugs, NOT fixed (4 specs):** `sketch-drag-draw:40/50/60` and `sketch-precise-input:114`. A real mouse press-drag-release on the sketch canvas builds **zero** geometry. This is a confirmed §2.6 HALF-MIGRATION, not stale scaffolding: the tests came from `fbb3172 feat(sketch): click-drag-release drawing`, `Sketcher.tsx:462` defines a live `DRAG_DRAW` tool set, and `Sketcher.perf.test.tsx:120` records "SVG pointer path removed — drag coalescing **moves to SketchScene next**" — a move that never happened. `SketchScene.tsx` has `onPointerDown`→`clickAt` (click-to-draw works) but **no `onPointerUp` and no drag gesture**, so a press fires one `clickAt` and the release does nothing; the intended `dragDraw`/`DragDrawPreview`/`scheduleDragSolve` machinery in `Sketcher.tsx` is all dead (no callers) because the SVG that drove it is now `pointer-events-none`. Fixing it is genuine §2.6 work (cross-component: SketchScene must drive the gesture, the Sketcher overlay must render the preview) and is left for a focused §2.6 pass. `sketch-precise-input:114` is a DISTINCT mechanism (§2.6.5 typed-coordinate input), diagnosed separately, also unfixed.

   **FLAKY (not a code bug):** `simulate-backends:23` (rapier/ammo/cannon) PASSES all three backends in isolation but fails under full-suite parallelism — backend-wasm/resource contention, not something this session touched.

   **NEW P0-CLASS BUG found while fixing the above — the first extrude onto the starter box VANISHES.** The default session seeds a box so the viewport isn't empty. Because extrude now joins the current body by default (§2.4/C1), a sketch drawn on XY (z=0) and extruded UP lands ENTIRELY INSIDE that box, so the union is still the box — `faceCount` stays 6, the pad is invisible. Live-measured through the real app: box 3.2e-5 m³ before, 3.2e-5 m³ after — the extrude removed/added nothing a user can see. This is the audit's central "I did the operation and nothing happened" symptom, hit on the very FIRST thing a new user does (draw + extrude), and it is only WORKED AROUND in the tests (they now start from an empty doc). The real fix is §2.4 (multi-body, or first-solid-is-a-new-body, or an empty default document) — tracked there, surfaced here because of how early and universal it is.

   | # | Spec | Why it fails |
   | --- | --- | --- |
   | 1 | `a11y.spec.ts:11` (ARIA + keyboard feature tree) | stale `feature-menu` pattern (below) |
   | 2 | `assembly-to-sim.spec.ts:32` (mate → lower → sim) | fails in 1.5 s — **not** a timeout; unexamined |
   | 3 | `cad-features.spec.ts:271` (ribbon loft + sweep) | **W3, confirmed** — clicks now-disabled demo buttons → 4 min timeout |
   | 4 | `context-menu.spec.ts:129` (sketcher constraints) | 7 s fail; likely the §2.6 severed-sketcher surface |
   | 5 | `extrude-guard.spec.ts:21` (extrude with a profile) | stale `feature-menu` pattern → 4 min timeout |
   | 6 | `feature-edit-gizmo.spec.ts:173` (typed height preview) | stale `feature-menu` pattern → 4 min timeout |

   **The dominant root cause is a stale locator, and it generalises W3.** Specs do `getByTestId("feature-menu").getByText("Sketch"|"Extrude", { exact: true })`. `feature-menu` is the panel titled **"Create"** (`ribbon/WorkspacePanel.tsx:96`), whose first item is the **`sketchLauncher` widget** — so `getByText("Sketch", {exact:true})` now matches the LAUNCHER and OPENS the sketcher. The contextual Sketch tab then auto-selects (`ribbonConfig.ts` `contextual: "sketch"`), the Solid tab unmounts, and the spec's next `add-extrude` click waits 4 minutes for a button that is no longer mounted. `extrude-guard.spec.ts:26`'s own comment — "Quick-add Sketch injects a default rectangle profile **without the sketcher**" — records the behaviour it was written against; the quick-add is now `sketch-rect`, whose label is not exactly "Sketch". Seven specs use this locator (`a11y`, `cad-features`, `feature-tree`, `extrude-guard`, `feature-edit-gizmo`, `recovery`, `sketch-to-solid`), so the blast radius is larger than the four that happen to fail today.

   **Cost note:** each stale-locator spec burns the full 240 s timeout, so a red suite takes ~15 min mostly waiting. `assembly-to-sim` (1.5 s) and `context-menu` (7 s) fail fast and are *different* bugs — they deserve separate diagnosis and have not had it.
9. ~~**`tsc --noEmit` is not enforced in CI** for the app (or §2.3 could not have landed).~~ **RETRACTED 2026-07-17 — this claim was false.** CI *does* enforce it: `.github/workflows/ci.yml:35` runs `pnpm -r --if-present run typecheck` and `apps/plastiq/package.json:12` defines `typecheck`. Verified by running the exact CI command: `apps/plastiq` is in scope and it exits 0. The red build merged past an existing gate rather than through a missing one — the audit's "or §2.3 could not have landed" was an unsound inference. PropertiesPanel suites don't cover the boolean display-default mismatch, sweep selects, draft attach, deps-vs-sketchId precedence; schema tests have no NaN/huge-value/boolean-location cases; draft has no AI integration test.
10. Loft winding mismatch, sweep spine-position (N2), sweep transformed-transition (N7), shell tolerance (N1): none tested. (Revolve angle wrap N6 + pattern degenerate-step §4.6 are now fixed AND tested — 2026-07-17.)

---

## 14. How the mainstream implements what's missing (research, with sources)

1. **Topological naming.** FreeCAD 1.0 fixed its decade-old problem with per-op *element maps*: derivation-encoded names (`Face6;:M2;FUS;:T1:5:F`) harvested from each op's `Generated/Modified/IsDeleted`, hashed long names, lineage-walking recovery ([realthunder's algorithm](https://github.com/realthunder/FreeCAD_assembly3/wiki/Topological-Naming-Algorithm), [Ondsel](https://www.ondsel.com/blog/toponaming-problem-is-history/)). Onshape stores references as re-evaluated *queries* over deterministic operation-derived IDs ([forum](https://forum.onshape.com/discussion/16911/how-does-the-identity-tracking-rebustness-system-work)). OCCT primitives: `BRepTools_History` (mergeable) + per-builder history ([spec](https://dev.opencascade.org/doc/occt-7.9.0/overview/html/specification__boolean_operations.html)). Minimum viable: deterministic birth names + harvested history + geometric fallback — retrofitting later cost FreeCAD a decade.
2. **Boolean robustness.** `BOPAlgo_ArgumentAnalyzer` pre-check → `SetFuzzyValue` + `SetNonDestructive(true)` (+ glue mode) → `HasErrors()/HasWarnings()` → `BRepCheck_Analyzer` → `ShapeUpgrade_UnifySameDomain` (history composed into the element map) ([boolean spec](https://dev.opencascade.org/doc/occt-7.9.0/overview/html/specification__boolean_operations.html), [fuzzy ops](https://dev.opencascade.org/content/fuzzy-boolean-operations), [shape healing](https://dev.opencascade.org/doc/overview/html/occt_user_guides__shape_healing.html)).
3. **Fillet failure handling.** OCCT gives no pre-analysis ([MakeFillet](https://dev.opencascade.org/doc/refman/html/class_b_rep_fillet_a_p_i___make_fillet.html)); best practice is build123d's probe pattern — extract faulty contours, probe remaining edges singly, report which edges fail at radius r, optionally bisect down ([build123d #1224](https://github.com/gumyr/build123d/issues/1224)). Variable radius via evolution laws and tangent contours are native.
4. **Sketch solving.** Plastiq already ships the right solver (planegcs). Missing is UX plumbing: DOF counter, fully-constrained color state, conflicting/redundant listing — data planegcs already returns ([planegcs wasm](https://github.com/Salusoft89/planegcs), [SolveSpace tech](https://solvespace.com/tech.pl), [FreeCAD GCS](https://deepwiki.com/FreeCAD/FreeCAD/3.1.2-constraint-system-and-gcs-solver)).
5. **opencascade.js practice.** replicad is the reference: `WrappingObj` + scoped GC registry, `faceGroups {start,count,faceId}` triangle-range maps for picking, `IsDone`/status checks with descriptive throws ([replicad](https://github.com/sgenoud/replicad), [ocjs memory](https://github.com/donalffons/opencascade.js/discussions/186)). Plastiq's disposal already matches; missing: exception decoding (numeric `Standard_Failure` → message) and cancellation via worker-respawn ([ocjs #172](https://github.com/donalffons/opencascade.js/issues/172)).
6. **Rebuild architecture.** Cache each feature's output shape; rebuild = replay from first dirty; failed features skipped and marked (Fusion 360 yellow/red timeline markers, [Autodesk](https://www.autodesk.com/support/technical/article/caas/sfdcarticles/sfdcarticles/Resolving-Timeline-Warning-or-Errors-in-Fusion-360.html)); Onshape's Repair Manager diffs against the last healthy regeneration and propagates reference fixes ([Onshape blog](https://www.onshape.com/en/blog/tackling-history-based-errors-parametric-cad-repair-manager)). Never all-or-nothing.
7. **Standard operation parameter surfaces** ([Onshape extrude](https://cad.onshape.com/help/Content/PartStudio/extrude.htm); Fusion/SolidWorks near-identical): extrude = result type (new/add/remove/intersect + merge scope) × end condition (blind, up-to-next, up-to-face+offset, up-to-body/vertex, through-all) × symmetric/second-direction × draft × thin; revolve = full/one-dir/symmetric/two-dir + result types; loft = ordered profiles + guides + per-end conditions + closed; sweep = orientation control + guide + thin. OCCT covers up-to semantics via `BRepFeat_MakePrism`; most hobby kernels ship blind-only — Plastiq is at that level today.

---

## 15. Open questions (not determinable from code)

1. Which failing flows the user hit first — §3 assumes sketch-first usage; AI-first usage makes §2.1/§2.2/§2.5/§12 dominate.
2. Whether persisted documents rely on current `op:"new"` replace semantics or the XZ −Z mapping (migration concerns for §2.4 and §4.8 N5 — fixing N5 changes existing documents' geometry).
3. **FULLY ANSWERED 2026-07-17 — the rebuild reproduces, and the gate is gone.** The trimmed build is confirmed to be what actually loads: `occt.build.yml`'s STATUS comment ("development + tests run against the FULL prebuilt opencascade.js") was **stale and wrong** — `src/oc/init.ts` loads the vendored `vendor/occt/plastiq-occt.wasm` in both Node and the browser (I4 confirmed; **that comment has now been corrected**). `just cad-occt` **was run successfully** on this machine (Apple Silicon, Docker 16 GB, image `donalffons/opencascade.js:2.0.0-beta.b5ff984`) despite the monolithic-LTO-under-QEMU concern PROVENANCE raises, and the resulting 18.2 MB trim is vendored and **green across all 359 kernel tests**. All previously-missing symbols except `BRepFeat_MakePrism` are now bound AND verified callable at runtime (`oc/bindings.test.ts`) — see the remediation header. The one surprise: `Interface_Static` binds but carries **no embind statics**, so I1 must scale at the boundary rather than configure OCCT.
4. Desktop (Tauri) export behavior — blob-anchor downloads without a download plugin are typically silent no-ops in WKWebView; needs a live check (§10).
5. Real-session frequency of the 120 s worker-timeout path (`bridge.ts:57-75`) — no telemetry.

---

*Investigation artifacts: live-kernel repro suites (33 tests) for §2.1/§2.2/§4.8 ran from the session scratchpad (not committed); logs beside them. Prior audit: `FableFindings.md` (2026-07-03) — its P0 "ground/fixed flag never lowered" is verified fixed (§11); its other findings were not re-audited here.*
