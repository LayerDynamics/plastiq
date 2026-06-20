# Plan — SPEC-6 R3: Selection (dress-up faces/edges)

**Date:** 2026-06-20
**Spec:** `docs/specs/SPEC-6-ai-generation.md` → milestone **R3**
**Execution:** inline sequential · **TDD (test-first)** · CI deterministic-only
**Depends on:** R0–R2 (schema, providers, build_part loop)

## Goal

Let the AI target faces/edges for dress-up features (fillet/chamfer/shell/draft, on-face
sketch) two ways: (a) a cheap **structured-ref feedback loop** (`inspect_geometry` returns
enumerated faces/edges as text; AI picks by index), and (b) a durable **selector-predicate
layer** resolved at rebuild that survives parameter changes.

## Prerequisites / grounding (verified)

- Tagged mesh carries the selection signatures: `FaceGroup { normal, centroid }` and
  `TaggedEdge { faceNormals, midpoint }` — `packages/cad/src/mesh/tagged.ts:21-58`;
  surfaced on `TransferMesh.faceGroups`/`edges` — `worker/protocol.ts:13-36`.
- Dress-ups consume concrete refs today: `rebuild.ts` resolves `data.edges`/`faces`/`face`
  via `resolveFaceRef`/`resolveEdgeRef` before calling `fillet`/`chamfer`/`shell`/`draft`.
- Ref types: `FaceRef = { normal, centroid? }`, `EdgeRef = { faceNormals:[V3,V3],
  midpoint? }` (`mesh/tagged.ts:21-35`).

## Tasks

### T3.1 — `inspect_geometry` tool (TaggedMesh → text) + index→ref mapping

- **Files (new):** `apps/plastiq/src/ai/tools/inspectGeometry.ts`,
  `inspectGeometry.integration.test.ts`.
- **Test-first (real OCCT):** build a known solid (e.g. a box) → `inspect_geometry` returns
  6 faces with correct normals/centroids and the expected edges; the returned indices map
  back to `FaceRef`/`EdgeRef` that `resolveFaceRef`/`resolveEdgeRef` re-resolve on that
  solid. Red first.
- **Implement:** build the current doc (reuse `GeometryClient.build`), serialize
  `faceGroups`/`edges` into the structured text shape in spec §6.3 (index, normal,
  centroid/midpoint, area/length, planar/cylindrical hint); keep an index→ref map so the
  client writes real refs into the feature `data` (FR-11/FR-12).
- **Done when:** enumeration + index→ref mapping verified against real geometry.

### T3.2 — Selector-predicate layer in the kernel + rebuild integration

- **Files (new):** `packages/cad/src/select/predicates.ts`,
  `packages/cad/src/select/predicates.unit.test.ts`; edit `packages/cad/src/index.ts`
  (export) and `apps/plastiq/src/worker/rebuild.ts` (resolve before dress-ups).
- **Test-first (real OCCT):** on a box, `topFace` resolves to the +Z face; `verticalEdges`/
  `edgesParallelTo([0,0,1])` resolve to the 4 verticals; `largestPlanarFace` picks the
  biggest; `faceByNormal` matches within tol. After a param change that rescales the box,
  the same predicate re-resolves to the corresponding face/edges. Red first.
- **Implement:** `resolveSelector(oc, solid, selector) → FaceRef[]|EdgeRef[]` for the
  `Selector` union in spec §6.4; export from the kernel; in `rebuild.ts`, when a dress-up's
  `data` carries a `selector`, resolve it against the freshly-built solid **before**
  invoking the op (FR-13/FR-14). Extend the R0 authoring schema to accept `selector`.
- **Done when:** predicates resolve correctly and survive a parameter change.

### T3.3 — AI dress-ups via both paths (end-to-end)

- **Files:** `prompt.ts` (dress-up guidance: prefer predicates, else `inspect_geometry`);
  deterministic E2E fixture; `buildPart.integration.test.ts` additions.
- **Test-first:**
  - *Integration:* a doc with a `fillet` carrying `data.selector = {kind:"topFace"}` builds
    a filleted solid; a doc with a `fillet` carrying concrete refs (from `inspect_geometry`)
    builds the same. Red first.
  - *Deterministic E2E:* inject (no model) a box→fillet-by-predicate doc and a
    box→chamfer-by-ref doc; assert both render and the predicate one re-resolves after a
    param edit.
- **Implement:** prompt guidance; wire `inspect_geometry` into `agentRunner`'s tool set;
  ensure `build_part` accepts both `selector` and concrete-ref dress-up `data`.
- **Done when:** both selection routes produce correct dress-ups; predicate survives edits.

## Milestone exit criteria

- AI (real provider) can fillet/chamfer/shell the intended geometry via both paths; a
  predicate-selected dress-up survives a parameter change (acceptance criterion 3).
- `pnpm test:unit` + integration (real OCCT) + deterministic E2E green; kernel tests green
  (`packages/cad`); zero regressions.

## Risks specific to R3

- Predicate ambiguity (e.g. two equally-large faces) — define deterministic tie-breaks in
  `predicates.ts` (e.g. lowest centroid) and test them. (R-5)
- Ref drift across large topology changes — the feedback loop is the fallback; document
  when each is preferred (spec §6.4). (R-5)
- Kernel export surface: keep `select/` additions minimal and covered by kernel unit tests
  against the trimmed OCCT wasm (a missing OCCT symbol fails loudly — README "OCCT trim").

## Commit

`feat(cad,app): SPEC-6 R3 — selection (inspect_geometry + selector predicates)` (ask first).
