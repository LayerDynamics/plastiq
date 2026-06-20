# Plan — SPEC-6 R2: Parametric generation & editing (headline)

**Date:** 2026-06-20
**Spec:** `docs/specs/SPEC-6-ai-generation.md` → milestone **R2**
**Execution:** inline sequential · **TDD (test-first)** · CI deterministic-only
**Depends on:** R0 (schema/convert), R1 (providers)

## Goal

The marquee path: a prompt produces — or **edits** — a validated `CadDocument` that builds
in the worker, renders in the viewport, lands in the timeline, and is editable via existing
parameter UI, driven by a bounded agent loop with a `build_part` tool. Plus the verified
unit-display fix so generated dimensions read in mm/deg.

## Prerequisites / grounding (verified)

- Programmatic injection that auto-rebuilds: `loadDocument()` `store.ts:688`,
  `addFeature()` `store.ts:310`; `Viewport.tsx:213` subscribes to `features`/`params` and
  schedules a coalesced `client.build(doc)` (`Viewport.tsx:168`).
- Worker client: `GeometryClient.build(doc, deflection?) → Promise<TransferMesh|null>`
  (`worker/bridge.ts`); throws/`{ok:false,error}` on per-feature failure
  (`worker/protocol.ts:82-94`; error strings from `rebuild.ts`).
- Command substrate for the palette: `actions/registry.ts` `runAction(id, ctx)`.
- Unit-display gap: generic editor renders raw SI `value={val}` —
  `apps/plastiq/src/app/PropertiesPanel.tsx:108`; `PlacementEditor` already converts
  (`/M_PER_MM`, `*DEG_PER_RAD`) at `:62-79`.
- Workspaces: `Workspace = "design"|"assemble"|"simulate"` (`store/types.ts:49`).

## Tasks

### T2.1 — `build_part` tool handler (validate → SI → atomic build → load)

- **Files (new):** `apps/plastiq/src/ai/tools/buildPart.ts`, `buildPart.integration.test.ts`.
- **Test-first (integration, real OCCT):** a valid authoring doc → handler →
  `useCadStore` features match + `GeometryClient.build` returns a mesh; an invalid doc
  returns a structured error result **and leaves the live store untouched** (atomic).
  Red first.
- **Implement:** validate with `authoringDocumentSchema` (R0) → `toCadDocument` →
  `cadDocumentSchema` → **off-thread `GeometryClient.build(doc)`** → only on success call
  `loadDocument(doc)` (spec §6.1 atomic apply, FR-21). On any failure return the zod/
  per-feature error string as the tool result (FR-7).
- **Done when:** success path renders; failure path is a no-op + returns the error.

### T2.2 — Edit mode (current doc as context)

- **Files:** `buildPart.ts`; `apps/plastiq/src/ai/agentRunner.ts` (created in T2.3);
  `buildPart.integration.test.ts`.
- **Test-first:** with a part open, the context handed to the model equals
  `toAuthoringDoc(currentDoc)`; a follow-up `build_part` that adds one feature yields the
  original + new feature (not a fresh doc). Red first.
- **Implement:** when a document is open, `agentRunner` injects `toAuthoringDoc(currentDoc)`
  (R0 inverse mapper) into context; `build_part` re-emits the **whole** updated doc
  (decision 13, FR-6a — no diff protocol).
- **Done when:** edit-from-context test green.

### T2.3 — `agentRunner` (tool loop, step cap, retry, cancel)

- **Files (new):** `apps/plastiq/src/ai/agentRunner.ts`, `agentRunner.unit.test.ts`.
- **Test-first:** with a scripted fake `ChatProvider` (a hand-written test double of the
  R1 interface — this is a unit test of the loop, not the model), assert: tool calls are
  dispatched to handlers; a validation error is fed back and retried up to the cap; the cap
  halts; an `AbortSignal` cancels mid-loop. Red first.
- **Implement:** the loop — call provider → on `tool-call` run the handler → feed result
  back → repeat until `answer_user`/cap; always-on step cap (FR-18a); bounded
  validation-retry (default 4, spec §6.1); `AbortSignal` cancellation (FR-21).
- **Done when:** loop/cap/retry/cancel covered.

### T2.4 — Parametric system prompt + Generation panel + command palette + usage meter

- **Files (new):** `apps/plastiq/src/ai/prompt.ts`, `prompt.unit.test.ts`,
  `apps/plastiq/src/ai/GenerationPanel.tsx`, `apps/plastiq/src/ai/CommandPalette.tsx`;
  wire into the Design-workspace layout (locate the panel container under
  `apps/plastiq/src/app/`); extend `aiStore.ts` (conversation/status/usage slices).
- **Test-first:** `prompt.unit.test.ts` asserts invariants — the prompt enumerates every
  feature type from `rebuild.ts`, states **mm/deg**, instructs edit-from-context, and the
  finish-with-`answer_user` rule (spec §6.7). Red first. (Panel/palette get R3F/RTL
  smoke tests in line with the repo's `@react-three/test-renderer` harness.)
- **Implement:** the prompt; a dockable `GenerationPanel` (prompt, stream, tool/build
  trace, error surface, usage meter) in the Design workspace; a `CommandPalette` quick-
  prompt that also searches `actions/registry.ts` (decision 18, FR-19); surface the
  Ollama `OLLAMA_ORIGINS`/tool-model guidance + the BYO-key warning here (spec §6.8).
- **Done when:** prompt invariants green; panel + palette mount and drive `agentRunner`;
  usage shows.

### T2.5 — Per-param unit display in the generic editor (FR-9a)

- **Files:** `apps/plastiq/src/app/PropertiesPanel.tsx`; `PropertiesPanel.unit.test.ts`.
- **Test-first:** a feature with a length param stored `0.04` (m) renders `40` (mm) and a
  committed `40` writes back `0.04`; an angle param shows degrees. Red first.
- **Implement:** classify each param as length/angle/count and convert for display+commit
  in the generic `FeatureEditor` (mirror `PlacementEditor`'s `M_PER_MM`/`DEG_PER_RAD` at
  `:62-79`); display-only — storage stays SI (FR-9a/FR-10).
- **Done when:** generated dimensions read in mm/deg; round-trip lossless.

### T2.6 — Blind end-to-end (no dress-ups yet)

- **Files:** `apps/plastiq/e2e/` (Playwright); a fixed known-good authoring doc fixture.
- **Test-first (deterministic E2E, no model):** inject a fixed authoring doc through the
  **real** `build_part` handler (not the LLM) → assert rendered geometry + timeline entries
  + autosave; then edit a param via the panel and assert re-render. Red first.
- **Implement:** whatever wiring the deterministic E2E needs (a test hook to invoke the
  handler with a fixture). This is the always-on E2E backbone (spec §10).
- **Done when:** deterministic E2E green in CI.

## Milestone exit criteria

- A prompt (real provider from R1) creates and **edits** a part that builds, renders, and
  is slider-editable in mm/deg; invalid output never corrupts the live doc.
- `pnpm test:unit` + `*.integration.test.ts` (real OCCT) + deterministic E2E green;
  typecheck/build/lint green; zero regressions.

## Risks specific to R2

- Atomic apply must build **off-thread first** — never `loadDocument` then discover a
  throw (would corrupt the live part). Enforced in T2.1 + tested.
- Unit-display change touches a shared panel — guard with the round-trip test (R-7).
- Local-model output quality varies — the retry loop + validation absorb most (R-2).

## Commit

`feat(app): SPEC-6 R2 — parametric generation + edit (build_part, agent loop, mm/deg UI)` (ask first).
