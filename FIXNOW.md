# FIXNOW — Deceptive / Partial / Silently-Failing Implementations

> **STATUS (2026-06-13): ALL findings below are RESOLVED.** Every F1–F10 and H1–H4
> item was fixed and the T1–T8 coverage gaps closed, each with a regression test.
> Gates green: typecheck · lint · build · 130 cad/sim + 376 app unit · 65 E2E (0 fail).
> See **Resolution status** below for the fix + test that closed each item. The
> finding descriptions are kept verbatim as the historical record of WHAT was wrong;
> they describe the code **before** the fix, not its current state.

**Product:** Plastiq is a browser-based, Fusion-style **parametric CAD studio** — sketch → solid → assemble → simulate — running entirely locally on an OpenCascade (OCCT) WASM kernel. Its marquee correctness promise is a **persistent typed-selection model**: a picked face/edge is stored as a signature that should re-resolve to *the same* topology after an upstream parametric rebuild (ADR-0013 / SPEC-4 FR-16). Several of the findings below cut directly against that promise.

This is a deliberately **narrow** audit: it lists only code that returns a **silent wrong result** or **swallows an error into stale/empty output presented as success**. Intentional, loudly-signalled graceful degradation (clear `throw`, status toast, disabled control, `localStorage` Map fallback in tests) was checked and **excluded** — see *Explicitly Cleared* at the end. There were **zero** TODO/STUB/FIXME markers in the source; every finding here is **semantic**, verified by reading the implementation, its callers, and its tests.

## How to read this

Each finding: **what it claims** (name/doc/test) · **what it actually does** (with `file:line`) · **what the user/caller sees when it fires** · **severity** · **confidence**. "Fix direction" is one line and intentionally light — this is an investigation, not a remediation plan.

| ID | Severity | Confidence | Category | Location | One-liner |
|----|----------|-----------|----------|----------|-----------|
| F1 | **High** | High | Contract gap (marquee feature) | `mesh/resolve.ts` | Persistent selection silently re-resolves to the *wrong* same-normal face/edge |
| F2 | **High** | High | Partial impl | `action/dressup.ts` | Fillet/chamfer/shell silently skip selections that don't resolve |
| F3 | **High** | High | Silent failure | `mesh/tessellate.ts` → `io/index.ts` | Faces with no triangulation dropped from mesh; incomplete glTF exported as success |
| F4 | **High** | Med (rare trigger) | Silent substitution | `lower/decompose.ts:170` | Concave part silently lowered to a single convex hull collider |
| F5 | **Medium** | High | Surprising convention | `action/pattern.ts:36` | Circular pattern over a *partial* angle uses an endpoint-excluded convention that under-fills the arc |
| F6 | **Medium** | High | Deceptive guard | `contextmenu/config.ts:378,389` | Cancelling a "Distance/Angle mate…" prompt silently applies a **0** mate |
| F7 | **Medium** | Med (reachability) | Fabricated value | `mesh/normals.ts:104` | `faceNormal` returns a hard-coded `[0,0,1]` on null triangulation |
| F8 | **Medium** | High (latent) | Silent substitution | `lower/component.ts:57` | Unknown material density silently falls back to water (1000 kg/m³) |
| F9 | **Low** | Low (gated) | Silent data loss | `persistence/sqlite.ts:102` | `save()` to a stale id resolves "saved" but writes nothing |
| F10 | **Low** | Med | Silent drop | `lower/decompose.ts:166` | Sub-tetrahedral V-HACD pieces dropped with no signal |

Plus 4 hardening items (H1–H4) and 8 test-honesty / coverage gaps (T1–T8) below.

## Resolution status (all ✅)

| ID | Fix | Regression test |
|----|-----|-----------------|
| F1 | `mesh/tagged.ts` `FaceRef.centroid`/`EdgeRef.midpoint` (optional) + `FaceGroup.centroid`/`TaggedEdge.midpoint`; `mesh/normals.ts` `faceCentroid`/`edgeMidpoint`; `mesh/resolve.ts` disambiguates same-normal candidates by closest position; threaded through `worker/protocol.ts`, `geometry.worker.ts`, `Viewport.tsx` | `tessellate.test.ts`: same-solid + **cross-rebuild** face disambiguation, edge-midpoint, legacy fallback |
| F2 | `action/dressup.ts` fillet/chamfer/shell throw when ANY selection fails to resolve (not only when all do) | `dressup.test.ts` partial-resolution throws |
| F3 | `mesh/tagged.ts` `TaggedMesh.droppedFaces` count; `tessellate.ts` counts dropped faces + edge loop resilient; `io/index.ts` `exportGltf` throws on a holey mesh | `tessellate.test.ts` droppedFaces=0 for a valid solid |
| F4 | `lower/decompose.ts` throws when a concave part yields no usable pieces (was a silent single-hull fallback) | existing notch test guards "no silent single hull" |
| F5 | `action/pattern.ts` endpoint-inclusive `angle/(count−1)` for a partial arc, `angle/count` only for a full 2π | `loftsweep.test.ts` partial-angle last copy at full angle |
| F6 | `contextmenu/config.ts` mate-distance/angle treat `null`/blank prompt as an explicit abort | `config.test.ts` Cancel/blank applies no mate |
| F7 | `mesh/normals.ts` `faceNormal` throws on null triangulation (no fabricated +Z); `faceFrame.ts` meshes the face first | `faceFrame.test.ts` un-meshed face → real normal |
| F8 | `lower/component.ts` `defaultLibrary` throws for an unknown material (no silent water density) | `export.test.ts` unknown material throws |
| F9 | `persistence/sqlite.ts` `save()` rejects on a 0-row UPDATE (`getRowsModified()`) | `sqlite.test.ts` save to a stale id rejects |
| F10 | `lower/decompose.ts` documented degenerate-only drop (zero volume) | `decompose.test.ts` kept colliders conserve volume |
| H1 | `action/{revolve,extrude}.ts` `IsNull()` result guard | existing happy-path feature tests |
| H2 | `action/extrude.ts` `extrudeToFace` doc states the perpendicular-planar exactness limit | `loftsweep.test.ts` non-perpendicular target characterization |
| H3 | `solid/solid.ts` `delete()` is genuinely idempotent (disposed guard) | `primitives.test.ts` double-delete no-throw |
| H4 | `assembly/solver.ts` `converged` flag + distinct `"did-not-converge"` verdict (gradient test separates conflict from non-convergence) | `solver.test.ts` converged/conflict |
| T4–T8 | rebuild draft test; `geometry.worker.core.ts` extracted + tested; `editFeature`/`spline2d` tests; `decomposerReady()` wired into the worker lower gate + tested | `rebuild.test.ts`, `geometry.worker.core.test.ts`, `editFeature.test.ts`, `spline2d.test.ts`, `decompose.test.ts` |

**Behavior-change note (expected):** F2 and F8 turn previously-silent degradation into a thrown/errored feature. A *saved* document with a multi-edge fillet where some edges no longer resolve will now show an errored feature on next rebuild (previously it rendered a silently-partial fillet). This is the intended fix — the partial result was the bug.

---

## Confirmed findings

### F1 — Persistent selection silently resolves to the WRONG same-signature face/edge — **High**

- **Where:** `packages/cad/src/mesh/resolve.ts:22-44` (`resolveFaceRef`), `:46-74` (`resolveEdgeRef`); signature types `packages/cad/src/mesh/tagged.ts:14-22`; header claim `tagged.ts:5-8`.
- **Claims:** *"the signature re-resolves **the same** topology after upstream edits"* (`tagged.ts:8`); the resolver doc says this *"is what lets a fillet/chamfer/shell re-resolve to the same topology after an upstream parameter rebuild"* (`resolve.ts:3-5`).
- **Actually does:** A `FaceRef` is **only** `{ normal }` (`tagged.ts:15-17`); an `EdgeRef` is **only** `{ faceNormals: [V3,V3] }` (`tagged.ts:20-22`). There is no position/index/area disambiguator. Resolution scores every candidate by normal alignment and keeps the best with a **strict** `if (d > bestDot)` / `if (score > bestScore)` (`resolve.ts:32`, `:62`) — so on a tie it keeps **whichever face/edge OCCT enumerated first**. Any part with two faces sharing an outward normal (a step, a boss, a rib, the two legs of an L, a symmetric pocket) or two edges sharing the same adjacent-normal pair (parallel slot edges, symmetric fillet edges) produces **identical signatures**, and the resolver cannot tell them apart — at capture time *or* resolve time.
- **User sees:** Pick the upper of two coplanar faces, run a fillet/shell/sketch-on-face, and the op is silently applied to the **lower** (first-enumerated) face instead. No error, no warning — a non-null, tolerance-passing match indistinguishable from a correct one. After a rebuild that reorders topology it can also silently flip to a different physical face/edge than originally selected.
- **Confidence:** High on the logic (a single normal provably cannot disambiguate two same-normal faces; the tie-break is deterministic-first). I could not measure from code how often a real rebuild reorders enumeration — but correctness does not depend on that, since same-normal elements are already indistinguishable.
- **Fix direction:** The signature needs a disambiguator beyond the normal (e.g. centroid position, area, or an enumeration-stable hash) so two same-normal elements resolve to distinct refs.
- **Corroborated by deceptive test T2** below — the FR-16 tests never exercise the same-normal case, which is exactly why this isn't caught.

### F2 — Fillet / chamfer / shell silently skip selections that fail to resolve — **High**

- **Where:** `packages/cad/src/action/dressup.ts:19-39` (`fillet`), `:41-68` (`chamfer`), `:70-107` (`shell`).
- **Claims:** *"Round **the picked edges**"* / *"Chamfer **the picked edges**"* / *"Hollow … opening **the picked faces**"* — plural, all selected elements.
- **Actually does:** Each loops the selections and only acts when the ref resolves: `const edge = resolveEdgeRef(...); if (edge) { maker.Add_2(...); added++; }` (`:24-29`, `:51-56`), `if (f) { list.Append_1(f); resolved.push(f); }` (`:75-79`). The `throw` fires **only when nothing resolved** — `if (added === 0)` (`:31`, `:58`), `if (resolved.length === 0)` (`:81`). `resolveEdgeRef`/`resolveFaceRef` return `null` for any ref below tolerance (`resolve.ts:41-43`, `:71-73`), which is exactly what a topology change after a parametric rebuild produces.
- **User sees:** Select 5 edges to fillet; after an upstream edit perturbs 2 of them, the body comes back filleted on 3 edges and **returned as success** — the other 2 silently un-filleted. For `shell`, a dropped open-face yields an enclosed cavity instead of an open shell. The dropped elements are precisely the high-value selections a parametric rebuild perturbs — i.e. the case the persistent-ref system exists to protect.
- **Confidence:** High.
- **Fix direction:** Throw (or surface a per-feature warning) when *any* requested element fails to resolve, not only when all do.

### F3 — Faces with no triangulation are dropped from the mesh; incomplete glTF exported as success — **High**

- **Where:** `packages/cad/src/mesh/tessellate.ts:85-94`; consumed by `packages/cad/src/io/index.ts:94-95` (`exportGltf`).
- **Claims:** *"Tessellate `solid` into a tagged mesh"* (`tessellate.ts:57-60`); `exportGltf` produces a *"self-contained glTF 2.0 document"* (`io/index.ts:89-93`). The `TaggedMesh` type (`tagged.ts:52-60`) has **no** field to express partiality.
- **Actually does:** When `BRep_Tool.Triangulation` returns null for a face, it emits a `console.warn(...)` and `continue`s, omitting that face's vertices/indices/face-group (`tessellate.ts:85-93`). The return value carries no dropped-face count or flag. A `console.warn` is not a programmatic signal — the renderer or `exportGltf` receives a structurally valid, shorter mesh and treats it as the complete geometry. The code's own comment says it wants to *"surface it rather than dropping geometry silently"* — but logging **is** dropping it silently from the caller's perspective.
- **User sees:** A rendered model or exported `.gltf` with one or more faces missing (a hole in the surface / an open mesh), reported as a successful export.
- **Confidence:** High. Frequency is bounded ("valid solids triangulate at this deflection, so this is rare") — but the silence when it fires is the finding.
- **Fix direction:** Add a `droppedFaces` count to `TaggedMesh`/the export result and have `exportGltf` (and the rebuild status) report a non-zero count.

### F4 — Concave part silently lowered to a single convex hull collider — **High** (rare trigger)

- **Where:** `packages/cad/src/lower/decompose.ts:168-170`.
- **Claims:** Header/doc promise *"several convex pieces for a concave part"* (`:1-6`, `:116-119`); `collidersFor` returns *"several convex pieces for a concave part. Never empty."*
- **Actually does:** Control only reaches line 145+ **after** the concavity gate (`:140`) has already classified the part as genuinely concave. If V-HACD then yields nothing that survives the usable-piece filter (`:166`), line 170 returns `colliders.length > 0 ? colliders : [wholeHull]` — i.e. the **single bulged convex hull** built at `:132-135`, the exact collider that fills the concavity the decomposition was meant to carve out. The comment frames this as a guard against "degenerate input," but it fires for any concave part where V-HACD produces no usable pieces. No throw, no log.
- **User sees:** A concave part (L-bracket, dished tray, C-clamp) collides in the simulator as if its pocket were solid. The manifest looks valid and passes `isSimManifest`; the caller cannot distinguish this from a correct decomposition.
- **Confidence:** High that the silent path exists; medium/low on real-world trigger frequency (how often a valid watertight concave mesh yields zero pieces passing `≥12 points && ≥4 faces` — likely rare, unbounded for thin/sliver geometry). Untested.
- **Fix direction:** When a part classified concave decomposes to zero usable pieces, surface it (throw or report) rather than silently substituting the filled hull.

### F5 — Circular pattern over a partial angle uses a surprising endpoint-excluded convention — **Medium**

- **Where:** `packages/cad/src/action/pattern.ts:36` (`const step = angle / count`).
- **Claims:** *"`count` copies of `base` evenly rotated about (origin, axis) **over** `angle`"* (`pattern.ts:26`).
- **Actually does:** With `step = angle / count`, copies land at `0, angle/count, … (count−1)·angle/count` — the last copy is at `angle·(count−1)/count`, never at `angle`. This is the **correct** convention for a full `2π` revolution (it avoids a duplicate at 0°/360°), but for a **partial** angle it spans only `(count−1)/count` of the requested arc. E.g. `count=4, angle=π` → copies at `0, π/4, π/2, 3π/4`, never reaching `π`. **This is a genuine "is the endpoint included?" ambiguity** — some CAD tools treat "over angle" as endpoint-inclusive (`angle/(count−1)`, the Fusion/SolidWorks convention), others as a step/increment. The code commits to one convention silently and applies it to both cases; it is likely-unintended for partial angles, not unambiguously "wrong geometry."
- **User-reachable (verified chain):** the feature is created with an editable `angle` param (`actions/registry.ts:171`: `params:{ az:1, count:4, angle: Math.PI*2 }`), read via `opt(f,"angle",Math.PI*2)` (`worker/rebuild.ts:363`), and `PropertiesPanel.tsx:104-112` renders an editable `NumberField` for **every** param including `angle`, committed in raw SI radians. So a user can set a partial angle and the partial-arc behaviour fires.
- **User sees:** A partial-angle pattern bunched into `(count−1)/count` of the requested sweep — surprising/likely-unintended, no error. The common full-circle default is correct.
- **Confidence:** High that the behaviour is as described; the "bug vs. convention" call depends on the intended "over angle" semantics.
- **Fix direction:** Decide the convention explicitly — `angle/(count−1)` for an endpoint-inclusive partial arc while keeping `angle/count` for a full `2π` — or document the param as "step angle" so the behaviour isn't surprising.
- **Masked by weak test T1** below (no test pins the angular convention at all).

### F6 — Cancelling a "Distance/Angle mate…" prompt silently applies a 0 mate — **Medium**

- **Where:** `apps/plastiq/src/three/contextmenu/config.ts:378-382` (`mate-distance`), `:389-391` (`mate-angle`).
- **Claims:** Menu items *"Distance mate…"* / *"Angle mate…"* — the trailing ellipsis promises a value dialog where **Cancel aborts**.
- **Actually does:** `const mm = Number(globalThis.prompt?.("Distance (mm)", "10")); if (Number.isFinite(mm)) cad().applyMate("distance", mm / 1000);`. On **Cancel**, `prompt` returns `null`; `Number(null) === 0` and `Number.isFinite(0) === true`, so a **0 mm** mate is applied and the assembly re-solves. Same for OK-with-empty-field (`Number("") === 0`). The `isFinite` check reads like an abort-on-cancel guard but does not catch the cancel case.
- **User sees:** They open the dialog, change their mind, hit Cancel — and a real 0-distance (or 0°) constraint is silently added and the parts re-pose. Recoverable via undo, but no error/feedback.
- **Confidence:** High on the mechanics. (In a non-browser/test env `globalThis.prompt` is undefined → `Number(undefined)=NaN` → safely skipped; the bug is specific to a real browser Cancel.)
- **Fix direction:** Capture the raw `prompt` return and treat `null`/`""` as an explicit abort before coercing to a number.

### F7 — `faceNormal` fabricates a `[0,0,1]` normal on null triangulation — **Medium**

- **Where:** `packages/cad/src/mesh/normals.ts:101-105`; reachable via `packages/cad/src/mesh/faceFrame.ts:14-15`.
- **Claims:** *"A face's outward unit normal (its FaceRef signature)"* (`normals.ts:97`).
- **Actually does:** When the face has no cached triangulation, returns a hard-coded `[0,0,1]` (`:104`) — a plausible-looking unit vector almost certainly wrong for the face, with no throw/null. `faceDatumPlane` (`faceFrame.ts:14`) calls `faceNormal` **without** an `ensureMeshed` guard (unlike `resolveFaceRef`/`resolveEdgeRef`, which mesh first at `resolve.ts:24`,`:48`). `faceFrame`'s doc discloses the curved-face approximation but says nothing about this null-triangulation default.
- **User sees:** A sketch-on-face whose datum plane silently points the wrong way (`+Z`) if invoked on a face that hasn't been triangulated; or a corrupted signature fed into resolution scoring.
- **Confidence:** High that the fabricated-default-as-success pattern exists; **medium** on live reachability — in the normal flow a solid is tessellated for rendering before a face can be picked, so the null path is hard to hit. The realistic trigger is `faceDatumPlane` on a not-yet-meshed face.
- **Fix direction:** Throw on null triangulation (callers already mesh first), or have `faceDatumPlane` `ensureMeshed` before reading the normal.

### F8 — Unknown material density silently falls back to water — **Medium** (latent)

- **Where:** `packages/cad/src/lower/component.ts:57` (`density: (material) => DENSITIES[material] ?? 1000`).
- **Claims:** `ManifestBody.mass` is documented as exact (*"Mass in kg (volume × material density)"*); the library doc admits *"falls back to ~water for unknowns."*
- **Actually does:** Any material key not in the 8-entry `DENSITIES` table (`:45-54`) — a typo, a casing mismatch (`"Steel"`), an exotic alloy — returns `1000` with **no throw and no log**, then feeds `mass = volume × 1000` emitted downstream as exact (`massprops` → `export`). For brass that is ~8.5× wrong.
- **User sees:** For a mis-specified material, body mass silently wrong by up to ~8.5×, presented as exact, no runtime signal.
- **Confidence:** High that the silent fallback exists. **Latent today:** the only production caller hard-codes `DEFAULT_MATERIAL = "structural-steel"` (`apps/plastiq/src/worker/lower.ts:25`,`:61`), a known key — so the fallback does not fire in the current app flow. But `defaultLibrary` is a public re-exported API (`packages/cad/src/index.ts`) taking an arbitrary string; severity becomes High the moment material selection is user-driven.
- **Fix direction:** Make `density` return `undefined`/throw for unknown keys (or log), so a mis-typed material is caught rather than silently massed as water.

### F9 — `sqlite.save()` to a stale id resolves "saved" but writes nothing — **Low** (gated)

- **Where:** `apps/plastiq/src/persistence/sqlite.ts:102-118`.
- **Claims:** *"Overwrite an existing project's document + optional thumbnail"* (`persistence/types.ts`).
- **Actually does:** Runs `UPDATE projects SET … WHERE id = ?` then `await persist()` unconditionally. If `id` matches no row, the UPDATE affects 0 rows, `persist()` succeeds, and `save()` resolves with no error — nothing was written. `projectsStore.save()` then sets status `"saved"` and writes a clean recovery snapshot.
- **User sees:** Believes the edit persisted; on reload it is gone.
- **Confidence:** Low — only fires if `currentId` is stale (e.g. the project was deleted in another tab/session). In the normal single-session flow `projectsStore` only ever passes ids from `create`/`open`, so it's effectively unreachable; I couldn't determine from code whether multi-tab/external deletion is a supported scenario.
- **Fix direction:** Check `db.getRowsModified()` after the UPDATE and reject (or fall through to INSERT) on 0 rows.

### F10 — Sub-tetrahedral V-HACD pieces dropped with no signal — **Low** (borderline)

- **Where:** `packages/cad/src/lower/decompose.ts:166` (`if (points.length >= 12 && faces.length >= 4) colliders.push(...)`).
- **Claims:** *"A usable convex piece needs ≥ 4 vertices and ≥ 4 faces"* — framed as keeping valid pieces.
- **Actually does:** Pieces failing the filter are discarded with no accumulation or signal. If *some* (not all) pieces are dropped, the compound collider under-covers the solid there, and sim inertia drifts toward the survivors (total `mass` stays exact — it comes from the real solid).
- **User sees:** A geometrically incomplete compound collider / subtly wrong rotational dynamics, no diagnostic.
- **Confidence:** Medium. **Borderline** — the dropped pieces are geometrically degenerate (a hull needs ≥4 vertices to be a real polyhedron), so discarding them is largely legitimate; the issue is only the silence and the unbounded sliver case. Listed for completeness; lower priority than F4.
- **Fix direction:** If dropped pieces represent non-trivial volume, fold them into the nearest kept hull or report the loss.

---

## Hardening / lower-confidence (do not fully meet the silent-wrong-result bar)

### H1 — `revolve`/`extrude` lack the result guard their siblings have — Low, low confidence
`packages/cad/src/action/revolve.ts:27-34` and `extrude.ts:62-67` call `.Shape()` and hand it straight to `new Solid(...)` with **no** `IsDone()`/`IsNull()` check — unlike `loft`/`sweep`/`dressup`, which all guard and throw. Both *do* reject the common degenerate inputs up front (zero angle / zero total height), and OCCT's prim builders typically `throw StdFail_NotDone` on degenerate-but-nonzero input (so this is **most likely loud, not silent**) — but if `MakeRevol`/`MakePrism` ever return a null shape instead, the user gets an empty `Solid` as success. Add an `IsNull()` guard for parity. (Could not determine OCCT null-vs-throw semantics from this repo.)

### H2 — `extrudeToFace` is exact only for a perpendicular planar target — Low-Medium
`packages/cad/src/action/extrude.ts:80-106` computes the pad height as the distance from the sketch plane to the target face's **centroid** projected onto the extrude direction (`:99`), then extrudes a straight prism. This reaches the face exactly only when the target is planar **and** perpendicular to the extrude direction; for an angled/curved target the flat-topped pad over/undershoots away from the centroid. The **doc-comment is honest** about the method (`:76-78`) — the gap is that the function *name* implies "terminate on the face," and the only test (`loftsweep.test.ts:87-106`) covers exclusively a perpendicular planar top, so the approximation on angled/curved faces is silent and untested.

### H3 — `Solid.delete()` "Idempotent-safe" doc is misleading — Low (doc accuracy)
`packages/cad/src/solid/solid.ts:18-21` is doc-commented *"Idempotent-safe"*, but `this.shape.delete()` has no double-call guard — a second `delete()` double-frees the OCCT shape (emscripten throws on use-after-free). It **throws** rather than silently producing a wrong result, so it does not meet the bar; flagged only because the doc claim is false.

### H4 — Assembly "over-constrained" verdict conflates conflict with non-convergence — Low-Medium
`packages/cad/src/assembly/solver.ts:268-274` derives the verdict from the final **residual magnitude alone** (`residNorm > 1e-5 → "over-constrained"`). There is no separate "did-not-converge" state and no check whether the Levenberg–Marquardt loop actually converged or merely exhausted its 200-iteration cap (`:238`). So a *consistent-but-hard* mate set (stuck in a local minimum, poor seed pose, or just needing >200 iterations) is reported to the user as `"over-constrained"` (`AssemblyTree.tsx:153-154`) — a claim about the mate graph that may actually be a numerics failure. Contrast the **sketch** solver, which reports true conflict/redundancy from PlaneGCS rather than inferring it from a residual. This does **not** meet the silent-wrong bar (the failure *is* surfaced as a non-`well-constrained` verdict — it never presents a failed solve as solved), but the label can mislead a user into deleting a valid mate. Note also that `solveAssembly` (`apps/plastiq/src/store/store.ts:607-612`) persists the best-fit poses as the new seed **regardless** of verdict — acceptable as "show best effort + flag it," but the drift is silent beyond the small verdict text.

---

## Test honesty & coverage gaps (false confidence on the green suite)

These matter because a passing suite is being used as proof of correctness; these tests assert the wrong thing or don't exist.

- **T1 — circular pattern test never checks angular placement.** `packages/cad/src/action/loftsweep.test.ts:74-84` asserts `length === 4`, volume preserved, and that copy[1]'s bbox differs from copy[0]'s — but never *where* any copy sits angularly, and only tests the `2π` case. It passes equally for `angle/count`, `angle/(count−1)`, or other conventions. Directly masks **F5**.
- **T2 — FR-16 resolution tests don't exercise the ambiguous case.** `packages/cad/src/mesh/tessellate.test.ts:65-96`: the FaceRef test checks the resolved face is `+Z` (`:79-80`) — but a box's `+Z` face is unique, so it never tests two same-normal faces. The EdgeRef test asserts only `expect(edge).not.toBeNull()` (`:93`) — it would pass even when the **wrong** edge resolves. Directly masks **F1**.
- **T3 — `extrudeToFace` tested only for a perpendicular planar top.** `loftsweep.test.ts:87-106`; the angled/curved approximation (**H2**) is untested.
- **T4 — `draft` feature untested.** The `draft` branch in `apps/plastiq/src/worker/rebuild.ts:283-304` has no test in `rebuild.test.ts`.
- **T5 — no `geometry.worker.ts` test at all.** The `export`/`facePlane`/`lower` message handlers and the single-body `effective` fallback that fabricates a `body0`/identity-pose instance for a bare part (`apps/plastiq/src/worker/geometry.worker.ts:67-84`) are exercised only indirectly; their correctness is unverified by code.
- **T6 — `editFeature.ts` untested.** `editSketchFeature`/`finishSketchFeature` (`apps/plastiq/src/sketch/editFeature.ts`) carry real store-glue logic with no test file.
- **T7 — `spline2d.ts` untested.** `catmullRomPoints` has no dedicated test (exercised only indirectly via hit-testing).
- **T8 — dead public export.** `decomposerReady` (`packages/cad/src/lower/decompose.ts:42`) is exported and re-exported but never called anywhere in app or test code.

---

## Explicitly cleared (checked, honest, NOT findings)

To keep this list honest, these were investigated and found to degrade **loudly** (clear `throw` / status / disabled control) or to be accurate:

- **Boolean ops** (`action/boolean.ts`) — return a `{ ok:false, error }` discriminated union / `cut` rethrows; never return an operand unchanged on failure.
- **Sketch constraint solver** (`packages/cad/src/sketch/solver.ts`) — builds real PlaneGCS primitives for all constraint kinds, calls `solve()`, and maps `Failed`/invalid → `"over-constrained"` (the caller is signalled). Genuinely solves.
- **Assembly mate solver** (`packages/cad/src/assembly/solver.ts`, `apps/plastiq/src/assembly/model.ts`) — a real Levenberg–Marquardt minimisation with a numeric Jacobian and rank-based DOF; it **does not present a failed/non-converged solve as success** (non-convergence → high residual → a non-`well-constrained` verdict surfaced in the assembly tree). A dangling mate ref resolves to component `-1` and **throws** rather than silently mis-posing. Cleared — but see **H4** for the verdict-labeling caveat.
- **`loft`/`sweep`** — build real `BRepOffsetAPI_ThruSections` / `MakePipeShell` (not interpolation), fully guarded with clear throws; **`transform`/`linearPattern`** exact and tested.
- **Mass properties** (`lower/massprops.ts`, `solid.ts:40-57`) — computed from the **real** OCCT solid via `VolumeProperties`, never from a hull.
- **Worker error path** — a rebuild failure surfaces as a typed per-feature error: `geometry.worker.ts:156` posts `{ok:false,error}` → `bridge.ts` rejects → `Viewport.tsx:194-200` shows `rebuild failed:` and marks the feature in the tree. Not swallowed.
- **Action registry / context menu** — export failures `setStatus("export failed…")` (`actions/registry.ts:83`, `AssemblyTree.tsx:451`); export buttons gated by `enabled: hasExporter`; mate items gated by `matePickCount === 2`.
- **`constructionGeometry.gizmo.tsx`** ("Datum sketches for now…") — correctly **hides** for face sketches (`if (!active || onFace) return []`); face-plane sketching is genuinely wired via `sketch-on-face`. The "for now" comment is honest, not a dead control.
- **Physics backends** (`packages/sim/src/backends/rapier.ts`, `ammo.ts`, `cannon.ts` — all three read directly) and **`sim/simulator.ts`** — real engines spawning real rigid bodies + colliders; the `console.warn`s drop orphaned constraints (missing body) with a clear diagnostic; the simulator steps real dynamics and reads live poses.
- **`measure`/`interference`/`section`** — each honestly documents itself (straight-line two-point distance; **bounding-box** broad-phase; clipping plane) and never claims to be exact solid analysis.
- **Persistence** — `recovery.ts` catch blocks are genuine best-effort (no false "saved" claim); `idb`/`sqlite` propagate request errors and `await persist()` after every mutation; round-trip is byte-identical in tests.

---

## Coverage of this audit (honest scope)

Deeply swept (read line-by-line — implementation + tests + callers): the entire `packages/cad` kernel (`action/`, `lower/`, `mesh/`, `sketch/`, `solid/`, `io/`, `oc/`, `assembly/`, `env/`, `unit/`, `math/`), `packages/sim` (engine + all three backends), the app's `worker/`, `sim/`, `viewport/`, `sketch/`, `persistence/`, `store/`, `actions/`, `ribbon/`, `three/contextmenu/`, `three/gizmos/`, and `app/assembly/model.ts`.

Also swept and **clean**: the GPU/raycast pick path — `apps/plastiq/src/three/{gpuPick.ts, Picking.tsx}` + the `viewport/colorId.ts` codec. The pick codec stores ids as `id + 1` (`colorId.ts:6-7`,`:21`) so a background miss (cleared black buffer) decodes to `null` rather than silently selecting "face 0"; all early-returns in `Picking.tsx` are honest miss→null guards, and the GPU-id / screen-space layers are documented by-design fallbacks, not silent substitutions.

**Not deeply swept** (presentational shells / R3F glue, read only where a finding's trace led in): `apps/plastiq/src/three/{Scene.tsx, Part.tsx, Viewport3D.tsx, SketchCamera.tsx, Section.tsx}` and the large React components (`App.tsx`, `AssemblyTree.tsx`, `Sketcher.tsx`). These are wiring/markup; the risk of a silent-wrong-*result* finding here is low, but they were not audited end-to-end.

---

*Investigation method: lexical sweep (0 TODO/STUB markers) → 6 parallel read-only cluster audits with intent-focused prompts → a 7th pass over the assembly/mate solver cluster → independent line-by-line verification of every reported candidate against source, callers, and tests. All `file:line` references in the findings were read directly, not inferred.*
