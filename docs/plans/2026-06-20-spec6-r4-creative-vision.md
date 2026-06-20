# Plan — SPEC-6 R4: Creative path (mesh documents) + vision

**Date:** 2026-06-20
**Spec:** `docs/specs/SPEC-6-ai-generation.md` → milestone **R4**
**Execution:** inline sequential · **TDD (test-first)** · CI deterministic-only
**Depends on:** R0–R2 (schema, providers, agent loop, panel)

## Goal

The creative path: text/image → a 3D **mesh body** persisted as its **own document kind**,
rendered alongside B-rep parts, via pluggable image-gen + 3D-gen providers behind a paid-job
confirm; plus user-routed vision (an attached image drives the parametric or creative path).

## Grounding + two refinements found while planning (verified)

- `Solid` (`packages/cad/src/solid/solid.ts`) is the only body type; no glB import
  (`io/index.ts` imports STEP only).
- **Refinement 1 — `importGltf`/`MeshBody` live in the APP, not the kernel.** `three` is an
  **app** dependency (`apps/plastiq/package.json`); `@plastiq/cad` deps are only
  `opencascade.js` + `planegcs`. Putting `GLTFLoader` in the kernel would add `three` to it.
  → place `MeshBody` + `importGltf` under `apps/plastiq/src/mesh/`.
  **Reconciled in spec (§5.1, decision 24) on 2026-06-20.**
- **Refinement 2 — mesh rendering is main-thread; no worker round-trip.** GLB parsing
  (GLTFLoader) and rendering are `three` (main thread); a mesh document does **not** go
  through `GeometryClient.build`/OCCT/`TransferMesh`. → the viewport gets a branch to render
  a mesh document directly; `worker/protocol.ts` is untouched. **Reconciled in spec
  (§6.5) on 2026-06-20.**
- Persistence is typed to `CadDocument`: `Project.doc` (`persistence/types.ts:23`),
  `ProjectRecordStore.getDoc/putDoc` (`:42-65`), `ProjectStore` (`:57-68`) — widening to a
  `kind`-discriminated union touches `types.ts` + `projectsStore.ts` + `idb.ts` +
  `sqlite.ts` + `memory.ts`.
- Viewport render entry: `apps/plastiq/src/viewport/buildMesh.ts`, `three/Scene.tsx`,
  `three/Part.tsx` (B-rep `TransferMesh` → THREE).

## Tasks

### T4.1 — `MeshBody` type + `importGltf` (in the app)

- **Files (new):** `apps/plastiq/src/mesh/meshBody.ts`,
  `apps/plastiq/src/mesh/importGltf.ts`, `importGltf.unit.test.ts` + a small real `.glb`
  fixture.
- **Test-first:** parsing the fixture GLB yields ≥1 `MeshBody` with non-empty
  positions/indices (and normals when present). Red first.
- **Implement:** `MeshBody = { positions, indices, normals?, material? }`; `importGltf`
  using three.js `GLTFLoader` (already a dep) → `MeshBody[]`.
- **Done when:** GLB fixture parses to correct mesh bodies.

### T4.2 — `kind`-discriminated persistence + mesh document kind + render branch

- **Files:** `apps/plastiq/src/persistence/types.ts` (+ `projectsStore.ts`, `idb.ts`,
  `sqlite.ts`, `memory.ts`); `apps/plastiq/src/viewport/buildMesh.ts` + `three/Scene.tsx`;
  a project-blob store for GLB bytes; tests: `persistence/*.unit.test.ts`,
  `buildMesh.unit.test.ts`.
- **Test-first:**
  - persistence: a `MeshDoc { kind:"mesh", bodies, source:{glbBlobId,…} }` round-trips
    through the in-memory + idb (fake-indexeddb) stores; a doc **without** `kind` still
    loads as parametric (back-compat). Red first.
  - render: `buildMesh` produces a `THREE.Mesh`/`Group` from a `MeshBody`.
- **Implement:** widen the persisted doc to `PersistedDoc = ({kind?:"parametric"} &
  CadDocument) | MeshDoc`; thread the union through all store backends; store GLB bytes as
  a project blob (parallels STEP-text reproducibility); add a viewport branch that renders
  a mesh document directly (bypassing OCCT). B-rep feature ops are simply **not offered**
  for a mesh document in the UI (FR-18 — no silent no-op).
- **Done when:** mesh docs persist/reload/render; parametric docs unaffected; back-compat
  load verified.

### T4.3 — Image-gen + 3D-gen providers + `create_mesh` (3 modes) + paid-job gate

- **Files (new):** `apps/plastiq/src/ai/meshgen/types.ts`,
  `apps/plastiq/src/ai/meshgen/fal.ts`, `apps/plastiq/src/ai/tools/createMesh.ts`,
  `createMesh.integration.test.ts` (opt-in/keyed — skips without a fal key; **not** in CI).
- **Test-first:** the paid-job confirm gate blocks a job until confirmed (unit, fake
  provider double of the R1-style interface); the keyed integration test (manual) runs a
  real image→3D job and ingests the GLB into a mesh document. Red first.
- **Implement:** `MeshGenProvider` (`submit`/`poll`) + `ImageGenProvider` (`generate`)
  interfaces (spec §6.5); `fal.ts` exposing Tripo / Meshy v6 / Hunyuan3D (selectable, no
  default — decision 6); `create_mesh` modes text→image→3D, image→3D, text→3D (decision 15);
  client **polling** (no webhook); route through the paid-job confirm + usage meter (FR-18a);
  on completion create a mesh document (T4.2).
- **Done when:** the gate works (unit); a real job produces a mesh doc (manual integration).

### T4.4 — Vision routing (image → parametric or creative)

- **Files:** `GenerationPanel.tsx` (attach + route toggle), `agentRunner.ts`,
  `anthropic.ts` (image blocks from R1); `agentRunner.unit.test.ts`.
- **Test-first:** an image routed to *parametric* on a vision-capable provider reaches
  `build_part` context as an image part; on a non-vision provider the parametric route is
  disabled with a message; routed to *creative* it reaches `create_mesh`. Red first.
- **Implement:** the attachment route toggle (FR-10a); gate parametric-vision on
  `provider.supportsVision` (FR-10b, R-9); creative route needs no LLM vision.
- **Done when:** both routes work; incapable-model case is guided, not silent.

### T4.5 — Verify spec ↔ implementation parity (spec already reconciled)

- **Files:** `docs/specs/SPEC-6-ai-generation.md` (§5.1, decision 24, §6.5).
- **Status:** the two refinements were already written into the spec on 2026-06-20
  (importGltf/MeshBody in the app; mesh rendering main-thread, no `TransferMesh` variant).
- **Do:** at implementation time, confirm the shipped layout matches and fix any drift
  (CLAUDE.md doc-accuracy).

## Milestone exit criteria

- Acceptance criteria 4 + 5: a routed image informs a parametric build on a vision model;
  the creative path (all three modes) produces a renderable/exportable **mesh document**
  behind a paid-job confirm, external dependency disclosed.
- Unit + deterministic mesh-import/render E2E (real GLB fixture) green in CI; keyed
  image→3D integration green when run manually; zero regressions.

## Risks specific to R4

- Persistence widening is the riskiest edit (touches all store backends) — back-compat test
  for `kind`-less docs is mandatory. (regression risk)
- External 3D providers are paid/network/possibly webhook-only — poll-capable default,
  confirm gate, honest UX (R-1, R-11).
- Vision+tools rarely coexist on local models → parametric-vision is effectively
  Anthropic/cloud only (R-9).

## Commit

`feat(app): SPEC-6 R4 — creative mesh documents + vision routing` (ask first).
