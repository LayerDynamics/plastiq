# Code Review: Plastiq

### Summary

**Plastiq is a fully client-side, parametric, in-browser CAD editor**: sketch a 2D
profile, build an ordered B-rep feature history on a real OCCT-via-WebAssembly kernel,
select faces/edges/vertices in 3D, assemble components with mates and joints, persist
to an in-browser SQLite store with crash recovery, and drop the result under gravity in
a real physics engine — no server, no backend, no mocks. The engineering is genuinely
strong: rigorous OCCT embind memory management, a consistent "fail loudly, never
fabricate geometry" invariant, a well-designed persistent face/edge reference system,
and a heavy *real* test suite (≈735 unit/integration assertions against real wasm + 31
no-mock Playwright e2e specs).

Risk does **not** concentrate where a server app's would. There is no injection/auth/XSS
surface — security is clean by construction (parameterized SQL, a single narrow
file-import path, no DOM-HTML sinks, wasm from fixed bundler URLs). Instead, the defects
cluster in two places: **(1) the interaction layer**, where two user-facing features
(Measure, shift-click multi-select) are wired up to the UI but never actually do
anything, and a parametric *edit* (circle radius/diameter) silently fails to apply; and
**(2) the long-lived-process seams** — a wasm leak in the ammo backend, swallowed
persistence-write failures, and per-frame document deep-clones during gizmo drags. One
coverage-gate misconfiguration hides the entire React/R3F layer from the regression
floor. All Critical/High findings below were independently verified by reading the cited
code.

### Findings

#### Critical

<!-- - **Solved circle radii are computed then thrown away — radius/diameter edits and
  tangent/concentric resizing silently don't apply** (`apps/plastiq/src/sketch/sketchStore.ts:639-648`)
  — The sketch solver returns both solved point positions *and* solved circle radii
  (`packages/cad/src/sketch/solver.ts:233,249`: `return { points, radii, … }`), but
  `solve()` writes back **only** `result.points` (sketchStore.ts:643-646); `result.radii`
  is never consumed anywhere in production (grep-confirmed: the only readers of `radii`
  are `sketch/model.test.ts`). A circle entity's `radius` is set once at creation
  (sketchStore.ts:505) and never updated. So when a user adds a radius/diameter dimension
  and edits it (e.g. 20 mm → 50 mm), the solver honors it, DOF drops to 0, the UI reports
  "well-constrained" success — yet the rendered circle (`Sketcher.tsx`, `r={e.radius*…}`),
  the extracted profile that becomes the **actual extruded solid** (`profile.ts`,
  `radius: c.radius`), hit-testing, and inference all keep reading the stale 20 mm. The
  same silent failure hits `tangent`/`concentric` constraints that should resize a
  free-radius circle. This is wrong exported geometry presented as success — the worst
  failure mode for a CAD tool. **Fix:** in `solve()`, map `result.radii` back onto the
  circle entities in entity order (the same order `toSolverInput` emits them), parallel to
  the existing point write-back, and add a regression test asserting `entity.radius`
  reflects an edited radius dimension. -->

#### High

<!-- - **Measure tool is fully wired to the UI but never functional** (`apps/plastiq/src/three/Viewport.tsx:425-432`, `apps/plastiq/src/three/Picking.tsx:212-256`, `apps/plastiq/src/store/store.ts:396`)
  — `toggleMeasure` flips `measuring`, the readout renders ("Click two points to
  measure"), Welcome.tsx advertises the feature, and `measurePoints`/`formatMeasurement`
  (`viewport/measure.ts`) and `Picker.pickPoint` (`viewport/pick.ts:120`) all exist — but
  **no production code ever collects the two clicks or calls `setMeasureResult`**
  (grep-confirmed: `setMeasureResult` appears only at its interface/definition
  store.ts:131,396; `measurePoints` is called only from tests; `pickPoint`'s sole
  production caller is the right-click context menu, not measure). `Picking.tsx`'s `onUp` —
  the only click handler — never checks `store.measuring`. Toggling Measure shows the
  prompt forever and clicking just selects. Per "called-but-missing → implement, not
  remove," wire measure-click collection into `Picking.tsx` (raycast `pickPoint`,
  accumulate two points, set the formatted result). -->

<!-- - **Shift-click to add to selection silently does nothing** (`apps/plastiq/src/three/Picking.tsx:175-178, 216-240`)
  — `onDown` sets `boxStart` whenever Shift is held (line 177). On a shift-*click* with no
  drag, `onUp` enters the `if (boxStart)` branch (216), finds `moved === false`, nulls both
  `boxStart` and `downAt` (221-222), falls through, and is then caught by `if (!downAt)
  return` (240) — so the additive-pick path at line 254 (`store.pick(hit, additive)`) is
  never reached. Shift+click — the CAD-standard "add this entity to the selection" gesture
  — does nothing; only Ctrl/Cmd+click (which don't set `boxStart`) or a rubber-band drag
  actually extend a selection. Core multi-select correctness bug. -->

- **ammo backend leaks every per-spawn wasm allocation** (`packages/sim/src/backends/ammo.ts:37-82`, `209-228`)
  — `spawn()` allocates a `btDefaultCollisionConfiguration`, `btCollisionDispatcher`,
  `btDbvtBroadphase`, `btSequentialImpulseConstraintSolver` (lines 37-41), plus per body a
  `btCompoundShape`, a `btConvexHullShape` + one `btVector3` per hull vertex (52-59), a
  `btTransform` (66), two `btVector3` (68,74), a `btDefaultMotionState` (72), and a
  `btRigidBodyConstructionInfo` (76) — none stored on `this`. `dispose()` (209-228) frees
  only the bodies, the world, `this.tmp`, and `this.childTransform`; Bullet's
  `destroy(world)` does **not** cascade to the dispatcher/broadphase/solver/shapes/
  motion-states/construction-info (the world doesn't own them), so all of those leak on
  every spawn. The simulator re-spawns whenever the assembly changes, so this accumulates
  across a session in the long-lived tab. The asymmetry is the tell: `restore()`
  (176-202) frees its scratch in a `finally` and `dispose()` has a double-free guard — the
  ownership rules are clearly understood, making `spawn()` an oversight. ammo-only:
  rapier/cannon use GC'd JS objects; MuJoCo uses owning embind handles. (Related Medium:
  ammo's `pose()`/`snapshot()` each leak one `btQuaternion` per call from the
  return-by-value `getRotation()`, ammo.ts:140,153 — on the per-frame readout path.)

- **`updateParams` deep-clones the entire document on every gizmo/scrub drag frame**
  (`apps/plastiq/src/store/store.ts:315-321, 239-245`; `apps/plastiq/src/three/gizmos/featureEdit.gizmo.tsx:119-122, 143, 167-169`)
  — `updateParams` unconditionally prepends `...pushHistory(s)`, and `pushHistory`→
  `snapshot()` `structuredClone`s features + params + **assembly + assemblyResult** every
  call (239-245). The feature-edit gizmo writes through this on *every* drag tick:
  `onObjectChange` → `setSI` → `updateParams` (featureEdit.gizmo.tsx:119-122, bound at 143)
  and the scrub grip's `onPointerMove` (167-169). A single drag therefore (a) deep-clones
  the whole doc+assembly per frame and (b) floods the 100-entry undo history with
  intermediate frames, evicting real undo states and making undo replay frame-by-frame.
  History is capped so this is *not* unbounded growth — the cost is per-frame clone
  overhead plus history pollution. The `TransformGizmo` does it correctly: it writes only
  on `onMouseUp` (transform.gizmo.tsx:37-39, one undo step). Coalesce the feature-edit
  path the same way (write live with history suppressed; push one snapshot at drag end).

- **Persistence write failures are silently swallowed mid-edit, and `projectsStore` has
  no unit test** (`apps/plastiq/src/persistence/projectsStore.ts:140-180`) — `save()` and
  `saveAs()` set `status: "saving…"` *before* `await store.save(...)` (lines 147-148,
  166-169) with no try/catch. `store.save` genuinely throws when the project row was
  deleted in another tab (`sqlite.ts:120` rejects on `getRowsModified()===0`) and
  IndexedDB `put` can reject on quota. The autosave path invokes this as `void get().save()`
  (projectsStore.ts:58), so a rejection becomes an unhandled promise: the status line
  stays stuck on "saving…", there is no retry, and the user is never told their work
  didn't persist. This 230-line store (new/open/save/saveAs/rename/delete + autosave
  debounce + the crash-recovery clobber-prevention) is the only substantial app module
  with **zero** colocated test (vitest.config.ts:65 itself names it a known gap), and the
  failure path is untested at any level. Mitigating (worth stating, not a fix): because the
  clean recovery write runs *after* the await (153-160), a failed save leaves the prior
  *dirty* recovery snapshot intact, so a crash is still recoverable — but only by ordering
  luck. **Fix:** wrap the awaits, surface a "save failed" status, and add the regression
  test for the rejection path.

- **Coverage gate blanket-excludes the entire `.tsx` layer even though dozens of those
  components are unit-tested** (`vitest.config.ts:46-60`) — `exclude: ["**/*.tsx", …]`
  (line 46) is justified by a comment claiming these are "code the node unit-runner CANNOT
  execute." That is false for the many `.tsx` with colocated jsdom / R3F-test-renderer
  tests that *do* run in the node suite (`PropertiesPanel.test.tsx`, `AssemblyTree.test.tsx`,
  `FeatureTree.test.tsx`, every `three/gizmos/*.gizmo.test.tsx`, the Part/Picking/Section/
  Assembly guard tests). Their execution contributes **zero** to coverage, so the
  thresholds (and the quoted "lines 85.9%") measure `.ts` only — the whole UI/R3F layer is
  invisible to the regression floor and a UI regression cannot trip it. Compounding: line
  47 excludes `apps/*/src/viewport/SceneController.ts` **which does not exist** (the scene
  controller is `three/Scene.tsx`), and line 60 excludes `three/contextmenu/snapshot.ts`
  as "browser-only e2e" though `snapshot.test.ts` unit-tests its real exports in the node
  suite. **Fix:** scope the `.tsx` exclusion to the genuinely browser-only components
  (real-WebGL ones) and let the jsdom-tested components count; remove the dead
  `SceneController.ts` entry; un-exclude `snapshot.ts`.

#### Medium

- **`isSimManifest` validates structure but not numeric payloads** (`packages/cad/src/lower/manifest.ts:52-71`)
  — the documented trust boundary for a parsed/untrusted manifest checks array presence and
  a few `typeof` tags but never that `gravity`/`com`/`orientation` are numbers of the right
  arity, that `points.length % 3 === 0`, or that `faces` entries are index triples. `NaN`,
  wrong-length arrays, and non-integer face indices pass straight through to
  `@plastiq/sim`. (`@plastiq/sim`'s own `parseManifest`, manifest.ts:91-109, *does*
  validate finiteness — so harden the kernel-side guard to match.)

- **OCCT temporaries leaked on the operation failure path** (`packages/cad/src/action/dressup.ts:45,80,127,157`, `loft.ts:28,70`, `boolean.ts:18`)
  — when an op produces a null/empty shape these sites do `const shape = maker.Shape()`
  (an owned embind allocation) and then `throw`/`return {ok:false}` **without**
  `shape.delete()`. The kernel's own convention proves it's required (`extrude.ts:69-71`,
  `revolve.ts:37-39` delete before throwing on `IsNull()`). Reachable in normal editing
  (e.g. a fillet radius the local geometry can't absorb), so it accumulates in the
  long-lived worker. Several ops also lack `try/finally` around `Build`/`MakeThickSolid`,
  so a thrown `Standard_Failure` leaks makers/wires; adopt the closure-cleanup pattern
  (`dressup.ts` draft / `loft.ts` sweep already do this) uniformly.

- **Per-edge `computeBoundingSphere()` on every hover pointer-move** (`apps/plastiq/src/three/Picking.tsx:31, 163, 203`)
  — in edge/vertex mode each `onMove` that misses the raycast calls
  `screenNearest → selectionCandidates`, which calls `line.geometry.computeBoundingSphere()`
  for *every* edge plus projects all candidates — on every mouse move. Meaningful per-frame
  work on a part with many edges during plain hover. Cache the per-part candidate
  projections / bounding spheres or throttle (faces/bodies are already exempt via the
  mode guard at line 156).

- **Whole SQLite image re-serialized to IndexedDB on every mutation** (`apps/plastiq/src/persistence/sqlite.ts:44-46`)
  — `persist()` does `db.export()` (the entire DB — all projects + full data-URL PNG
  thumbnails) and writes the blob under one key after *each* save/create/rename/delete,
  with autosave firing every 1500 ms. Cost is O(total-DB-size) per edit burst, not
  O(changed-project); fine for a few small projects, degrades as the library grows.

- **`getOc()` memoizes a rejected init promise — a transient wasm-load blip bricks the
  worker until reload** (`apps/plastiq/src/worker/geometry.worker.ts:18`) —
  `ocPromise ??= initOcct({ wasmUrl })` caches the promise even on rejection with no
  `.catch`-and-reset, so every subsequent build re-awaits the same failure. Reset to
  `null` on failure so the next build retries.

- **Imported STEP text bloats the crash-recovery snapshot past the localStorage quota**
  (`apps/plastiq/src/worker/rebuild.ts:411-419`, `apps/plastiq/src/persistence/recovery.ts:42-48`)
  — imported STEP is stored verbatim in `feature.data.step` and `toDocument()` includes
  `data`, so the full text serializes into every debounced recovery snapshot. A multi-MB
  STEP exceeds the ~5 MB localStorage limit; `writeRecovery`'s `catch {}` swallows the
  `QuotaExceededError`, so recovery becomes a silent no-op for exactly the heavy documents
  whose loss would hurt most. At minimum surface/log the write failure; ideally
  externalize large `data.step` payloads.

- **"Conflicts — click to remove" lists non-removable driven dimensions** (`apps/plastiq/src/sketch/Sketcher.tsx:929-948`)
  — when over-constrained, the panel maps over *all* constraints because `SolveResult`
  carries no per-constraint conflict set; it shows driven/reference dimensions, which add
  no solver equation and can never be the conflict — clicking them removes nothing
  relevant and the conflict persists. Filter out `driven` constraints; ideally surface the
  conflicting subset from the solver.

- **Full constraint solve + unmemoized full re-render on every sketch drag tick** (`apps/plastiq/src/sketch/Sketcher.tsx:1010-1016, 693-700`)
  — dragging a point runs the full wasm solve and rebuilds the (unmemoized)
  `SketchGeometry`/`ConstraintGlyphs`/`GridAndAxes` subtrees per `pointermove`, and the
  hover path re-runs `inferAt`/`hitTest` allocating fresh candidates each tick. Fine for
  small sketches, unbounded for large ones. Coalesce solves to animation frames and memoize
  the pure render subtrees.

- **Cross-backend hinge contract divergence isn't surfaced in the interface doc** (`packages/sim/src/backends/rapier.ts:62-76`, `packages/sim/src/engine.ts:32`)
  — rapier-compat's `JointData.revolute` takes a single world axis with no per-body frame,
  so a hinge between differently-oriented bodies is only exact at identity orientation
  (the code documents this and the rotated-hinge test excludes rapier). cannon/ammo/MuJoCo
  express it correctly. A faithful, documented divergence — but the `PhysicsEngine`
  interface advertises full interchangeability without noting it. Also undocumented:
  `spawn()` is effectively single-use (no backend clears `bodies`/frees the prior world),
  and MuJoCo's `restore()` only accepts a snapshot it produced.

- **Stale test counts in a doc the README cites as the verification authority** (`packages/cad/vendor/occt/PROVENANCE.md:35`)
  — claims "288 unit + 15 browser E2E"; actual is ≈735 unit assertions and 31 e2e spec
  files / 65 `test()` blocks. Under the project's "docs 100% accurate" rule this is a
  concrete inaccuracy.

#### Low

- **`edgeId` not compacted while `faceId` is** (`packages/cad/src/mesh/tessellate.ts:134 vs 161`)
  — kept faces are contiguous `0..N-1` but a skipped edge leaves a gap in edge ids, and
  dropped *edges* are uncounted while `droppedFaces` is surfaced. No current consumer
  indexes edges positionally (selection re-resolves by signature), so impact is low — but
  it's a latent trap; compact `edgeId` and add a `droppedEdges` counter for parity.

- **O(n²) dedup / double per-point face re-filter in convex hull** (`packages/cad/src/lower/hull.ts:52-57, 108-131`)
  — `pts.some(...)` inside a loop over all points, plus re-`filter`ing the full face list
  twice per inserted point. Usually modest (coarse hull tessellation) but quadratic for a
  complex part's vertex cloud; a spatial hash removes the quadratic term.

- **Duplicated picker / GPU-fallback logic across two listeners** (`apps/plastiq/src/three/Picking.tsx:89-90, 246-251` vs `apps/plastiq/src/three/contextmenu/useCanvasRightClick.ts:34-35, 102-106`)
  — both independently instantiate their own `Picker` + `GpuPicker` and re-implement the
  raycast-then-GPU-id-fallback sequence, each holding a full-canvas `WebGLRenderTarget`.
  Redundant GPU memory and a two-copies-to-sync maintenance hazard; share one pick service.

- **Inline geometry allocated (and not disposed) in JSX for the plane outline** (`apps/plastiq/src/three/gizmos/plane.gizmo.tsx:51`)
  — `<edgesGeometry args={[new THREE.PlaneGeometry(SIZE, SIZE)]} />` builds a fresh
  `PlaneGeometry` per render while sketching and never disposes the argument geometry.
  Hoist to a module constant — exactly the allocation-in-render pattern the rest of the
  codebase carefully avoids.

- **Dead SVG view-cube superseded by the drei in-scene cube** (`apps/plastiq/src/viewport/ViewCube.tsx`, `apps/plastiq/src/viewport/cubeView.ts`)
  — grep-confirmed zero production imports (the drei `GizmoViewcube` replaced them); only
  their own tests reference them. Confirm intent, then remove both (and tests) so it
  doesn't imply two view-cube implementations exist.

- **`reset()` duplicates the entire initial-state literal** (`apps/plastiq/src/store/store.ts:714-748 vs 267-300`)
  — the default-state object is written twice; a shared `initialState()` factory prevents
  drift (a new transient field added to one but not the other silently breaks `reset`).

- **Exact floating-point zero comparisons in sketch geometry math** (`apps/plastiq/src/sketch/hit.ts:20`, `apps/plastiq/src/sketch/infer.ts:92, 133`)
  — `len2 === 0` / `du === 0 && dv === 0` test exact zero rather than an epsilon, unlike the
  `1e-9`/`1e-12` epsilons used elsewhere in the same modules; a near-zero segment slips past
  and feeds a near-singular normalization.

- **One-click project delete with no confirmation** (`apps/plastiq/src/app/ProjectsMenu.tsx:106-113`)
  — `remove(p.id)` deletes a saved project immediately; rename uses a prompt but the
  destructive delete (trash icon next to rename) doesn't confirm.

- **README overstates IGES/glTF as bidirectional interchange** (`README.md:26`) —
  `packages/cad/src/io/index.ts` exports `importStep` + `exportStep`, but only
  `exportIges`/`exportGltf` (no import). IGES/glTF are export-only; "interchange" reads as
  round-trip.

- **`ActionButton` silently renders nothing for an unknown action id** (`apps/plastiq/src/ribbon/ActionButton.tsx:20`)
  — `if (!def) return null;` means a typo'd/removed id just vanishes from the ribbon with
  no error; a dev-time warning would catch `ribbonConfig` drift.

### Strengths

- **OCCT embind memory discipline is genuinely strong.** Nearly every wasm allocation is
  paired with `.delete()`, getter sub-objects (`CentreOfMass`, `Triangle(i)`, `Node(i)`)
  are freed individually, the error-prone feature ops use `try/finally` so a thrown OCCT
  failure still frees the resolved face/props, and `Solid` guards double-free with a
  `disposed` flag. This is the hardest thing to get right in an OCCT-on-wasm kernel and it
  is *mostly* right — which is exactly why the spawn-side ammo leak and the
  null-result-path leaks stand out as oversights rather than the pattern.

- **The "fail loudly, never fabricate geometry" invariant is applied uniformly.**
  `faceNormal` throws rather than return a fabricated +Z; dress-up ops reject a *partial*
  edge/face resolve; `exportGltf` refuses a mesh with a hole; `collidersFor` throws rather
  than substitute a wrong-physics hull; `defaultLibrary` refuses an unknown material. For a
  kernel where silent geometry corruption is the worst outcome, this is exactly the right
  bias.

- **Security is clean by construction.** Parameterized SQL everywhere (no string-built
  queries — repo-wide grep confirms), a single narrow file-ingestion surface (STEP text →
  OCCT wasm sandbox; no glTF/IGES *import*, so no untrusted-JSON parse), MJCF generated
  with synthetic index names and finite-checked numeric formatters (injection-proof),
  zero DOM-HTML sinks (`dangerouslySetInnerHTML`/`innerHTML`/`eval`/`new Function` all
  absent), `loadDocument` `structuredClone`s named keys (no prototype-pollution path), and
  wasm loaded only from fixed bundler-resolved URLs. The only residual items are a Low
  STEP-import size cap and validating parsers for the persisted-JSON casts (latent).

- **The worker RPC and rebuild pipeline are robust by design.** `GeometryClient` matches
  responses by monotonic id, times out hung OCCT ops, and rejects *all* in-flight promises
  on dispose/error so callers never hang on a dead worker; the Viewport coalescer
  guarantees one in-flight rebuild plus a single trailing catch-up, structurally
  preventing the out-of-order-mesh race.

- **Undo/redo restores derived state in lock-step.** History snapshots capture `nextSeq`
  *and* `assemblyResult` alongside `assembly`, so undo doesn't skip ids or leave a stale
  mate verdict — both pinned by tests.

- **The physics layer's subtle math is correct *and* tested.** Body-local constraint
  frames are factored into shared helpers consumed by all four backends; mass-consistent
  compound colliders share one density via winding-independent `hullVolume`; MuJoCo's
  `cvel`→own-COM linear-velocity shift is correct and guarded by a finite-difference
  double-pendulum test; the lazy-forward `dirty`/`sync()` flag avoids both stale reads and
  redundant forward passes.

- **The test suite is real and the e2e tests are genuinely end-to-end.** Sampled specs
  drive the real app through real keyboard/DOM, run real OCCT in the real worker, and step
  real physics wasm — `simulate-backends.spec.ts` even asserts the *selected* backend is
  active so it can't silently fall back to the default. No mocked layers; not mislabeled
  integration. README headline claims verify exactly against code (18 feature ops, four
  backends, MuJoCo default, the OCCT-trim bundle sizes, Web Worker, headless-Node).

### Recommendations

Prioritized, highest-leverage first:

1. **Fix the silent radius-edit data-corruption bug** (Critical) — map `result.radii`
   back in `solve()` and add the regression test. This is the only finding that produces
   *wrong exported geometry while reporting success*; it should be fixed before anything
   else.
2. **Restore the two broken interaction features** — wire Measure clicks into
   `Picking.tsx` and fix the shift-click multi-select fall-through. Both are advertised,
   both do nothing today.
3. **Plug the long-lived-process leaks/failures** — track and free ammo's per-spawn wasm
   objects in `dispose()`; coalesce the feature-edit gizmo to one history entry per drag;
   wrap the `projectsStore` save awaits to surface failures, and give that store its first
   unit test (it owns autosave + crash-recovery and is currently untested).
4. **Restore the coverage gate's truthfulness** — stop excluding jsdom-tested `.tsx` from
   coverage, drop the non-existent `SceneController.ts` entry, and un-exclude the
   unit-tested `snapshot.ts`, so a UI regression can actually trip the floor.
5. **Harden the kernel trust boundaries and clean up** — validate numeric payloads in
   `isSimManifest`; adopt the closure-cleanup pattern across all feature ops so failure
   paths free OCCT temporaries; reset `getOc()` on init failure; cap STEP import size and
   surface recovery-snapshot quota failures.
6. **Reconcile the docs** — fix PROVENANCE.md test counts, the README "interchange"
   wording, and the stale vitest comment, per the project's accuracy rule.
7. **Lower-risk polish** — memoize the sketch render subtrees / throttle the per-move
   solve + hover scans, share one pick service between the two canvas listeners, hoist the
   plane-gizmo geometry, add a delete confirmation, and remove the dead SVG view-cube.
