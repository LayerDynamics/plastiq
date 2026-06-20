# Plan — SPEC-6 R5: Persistence, hardening & tests

**Date:** 2026-06-20
**Spec:** `docs/specs/SPEC-6-ai-generation.md` → milestone **R5**
**Execution:** inline sequential · **TDD (test-first)** · CI deterministic-only
**Depends on:** R0–R4

## Goal

Persist the AI conversation per project, lock in the full no-mock test pyramid (always-on
deterministic E2E in CI; model-in-the-loop E2E local/manual), and ship accurate docs.

## Grounding (verified)

- Project persistence backends: `apps/plastiq/src/persistence/{projectsStore,idb,sqlite,
  memory}.ts`; `Project = { meta, doc }` (`types.ts:23`).
- AI state: `apps/plastiq/src/ai/aiStore.ts` (settings/usage from R1/R2).
- CI: `.github/workflows/ci.yml` (unit/integration in Node; Playwright E2E served on
  `:4177`). Test scripts: `pnpm test:unit|test:integration`, `pnpm e2e`.

## Tasks

### T5.1 — Per-project conversation/trace persistence

- **Files:** `apps/plastiq/src/ai/aiStore.ts`; a conversation store (reuse
  `persistence/idb.ts` patterns; **separate** IDB store from `projects`);
  `aiStore.unit.test.ts`.
- **Test-first:** a conversation (messages + tool/build trace) saves under the active
  project id and reloads on project switch; switching projects shows the right history;
  deleting a project clears its conversation. Use `fake-indexeddb` (devDep). Red first.
- **Implement:** persist a linear per-project conversation + generation trace (decision 14,
  FR-20); load on project open; clear on project delete. (No branching — out of scope §13.)
- **Done when:** conversation round-trips per project.

### T5.2 — Full deterministic E2E (always-on, no model)

- **Files:** `apps/plastiq/e2e/*.spec.ts` (extend R2.6/R3.3 fixtures); CI already runs `e2e`.
- **Test-first:** end-to-end, **no LLM**, via the real tool handlers with fixed inputs:
  create → edit → dress-up by predicate → dress-up by ref → import a real GLB into a mesh
  document → export. Assert rendered geometry, timeline, mesh render, autosave, and
  back-compat load of a `kind`-less doc. Red first where coverage is missing.
- **Implement:** any remaining test hooks so each path is driveable deterministically.
- **Done when:** the deterministic E2E covers every real component except the model and is
  green in CI.

### T5.3 — Model-in-the-loop E2E (local Ollama) + opt-in keyed Anthropic

- **Files:** `apps/plastiq/e2e/llm.spec.ts` (gated); a short README note on running it.
- **Test-first:** against a **real local Ollama** + a tool-capable model, a prompt
  produces a building part (prompt→tool→document→render) — a legitimate no-mock E2E;
  **skips cleanly** when Ollama is unreachable so CI stays deterministic (decision: Ollama
  local+manual, CI deterministic-only). An **opt-in** keyed Anthropic variant covers the
  hosted + vision path (skips without `ANTHROPIC_API_KEY`). Red first.
- **Implement:** the gated specs + skip guards + run instructions.
- **Done when:** the Ollama E2E passes locally; both skip cleanly in CI; CI stays green and
  deterministic.

### T5.4 — Docs

- **Files:** `README.md` (an "AI generation" section), in-product help strings
  (`OLLAMA_ORIGINS`, BYO-key warning, external-service disclosure), and keep
  `docs/specs/SPEC-6-ai-generation.md` in sync with what shipped.
- **Do:** document setup (provider/key/Ollama), the no-server vs external-service split,
  and how to run the local/keyed E2E. Re-read the spec and fix any drift from
  implementation (CLAUDE.md doc-accuracy rule).
- **Done when:** README + help accurate; spec matches the code.

## Milestone exit criteria

- Acceptance criteria 7 + 8: conversation persists per project; deterministic E2E green +
  always-on in CI; local-Ollama LLM-boundary E2E green when run; zero regressions across
  the whole suite (`pnpm test`, `pnpm e2e`, `pnpm typecheck`, `pnpm lint`).

## Risks specific to R5

- E2E flake at the model boundary is why the Ollama run is local/manual, not CI-blocking
  (R-2/R-3); CI proves the deterministic pipeline.
- Conversation store must be isolated from the `projects` store so AI history can't corrupt
  a CAD document (separate IDB store).

## Commit

`feat(app): SPEC-6 R5 — per-project AI history + E2E pyramid + docs` (ask first).
