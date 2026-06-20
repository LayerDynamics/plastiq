# Plan — SPEC-6 R1: Provider layer (Anthropic / Ollama / proxy)

**Date:** 2026-06-20
**Spec:** `docs/specs/SPEC-6-ai-generation.md` → milestone **R1**
**Execution:** inline sequential · **TDD (test-first)** · CI deterministic-only
**Depends on:** R0 (deps installed)

## Goal

A vendor-neutral, streaming, tool-calling `ChatProvider` with three real adapters
(Anthropic direct, OpenAI-compatible incl. Ollama, proxy = base-URL re-point), a curated
model catalog with a tool-capability preflight, client-side key storage behind a
proxy-ready indirection, and a neutral first-run chooser. No agent loop or tools yet —
just the transport.

## Prerequisites / grounding (verified)

- Browser-direct Anthropic requires `new Anthropic({ apiKey, dangerouslyAllowBrowser:true })`
  (official docs; key is exposed to the browser — acceptable for the user's own key).
- Ollama exposes an OpenAI-compatible API at `http://localhost:11434/v1`; tool calling is
  native since Ollama ≥0.4; browser calls need `OLLAMA_ORIGINS` to include the app origin;
  ≥14B models for reliable tool selection (Appendix A).
- Adapter impl: `@anthropic-ai/sdk` for Anthropic; official `openai` SDK + `baseURL` for
  everything OpenAI-compatible (decision 23).
- Settings persist in IndexedDB (separate store from `projects`); existing IDB helper:
  `apps/plastiq/src/persistence/idb.ts`.

## Tasks

### T1.1 — Provider contract + usage accounting

- **Files (new):** `apps/plastiq/src/ai/providers/types.ts`,
  `apps/plastiq/src/ai/usage.ts`, `apps/plastiq/src/ai/usage.unit.test.ts`.
- **Test-first:** `usage.ts` accumulates input/output tokens + paid-job counts across
  turns and exposes a snapshot; assert accumulation + reset. Red first.
- **Implement:** `ChatProvider` (`stream(req) → AsyncIterable<StreamEvent>`,
  `supportsVision`, `supportsTools`), `ChatMessage` (text + optional image parts),
  `ToolDef`, `StreamEvent` (text-delta | tool-call | usage | done | error) — the contract
  in spec §5.2. `usage.ts` per spec §6.8.
- **Done when:** types compile; usage tests green.

### T1.2 — OpenAI-compatible adapter (Ollama-first)

- **Files (new):** `apps/plastiq/src/ai/providers/openaiCompatible.ts`,
  `apps/plastiq/src/ai/providers/openaiCompatible.integration.test.ts`.
- **Test-first (integration, real Ollama, local/manual):** against a running local Ollama
  with a tool-capable model, a prompt + one `ToolDef` yields a `tool-call` `StreamEvent`
  with parsed args. Gate the test to skip cleanly when `OLLAMA_HOST` is unreachable (so CI
  stays deterministic; the test is real, not mocked, when run). Red first (no adapter).
- **Implement:** wrap the `openai` SDK with configurable `baseURL`/`apiKey`; map
  `ToolDef`→`tools`, assemble streamed `tool_calls`, emit `StreamEvent`s; no key for Ollama.
- **Done when:** the gated integration test passes against a local Ollama; unit-level
  message/tool mapping has its own pure test.

### T1.3 — Anthropic adapter (+ vision)

- **Files (new):** `apps/plastiq/src/ai/providers/anthropic.ts`,
  `anthropic.integration.test.ts` (opt-in, keyed; skips without `ANTHROPIC_API_KEY`).
- **Test-first:** pure mapping unit test (our `ChatMessage`+`ToolDef` → Anthropic params:
  adaptive thinking, tools, image blocks) red first; plus the opt-in keyed integration
  test for a real streamed tool call.
- **Implement:** `@anthropic-ai/sdk` with `dangerouslyAllowBrowser:true`, adaptive thinking
  (`thinking:{type:"adaptive"}`), streaming, tools, image input; `supportsVision=true`.
- **Done when:** mapping unit test green; keyed integration test green when a key is present.

### T1.4 — Model catalog + registry + tool-capability preflight

- **Files (new):** `apps/plastiq/src/ai/providers/models.ts`,
  `apps/plastiq/src/ai/providers/registry.ts`, `registry.unit.test.ts`.
- **Test-first:** registry builds the correct adapter from a settings object; preflight
  flags a known non-tool model and passes a tool model; curated catalog matches Appendix A
  entries. Red first.
- **Implement:** `models.ts` curated catalog (Appendix A: Anthropic opus-4-8/sonnet-4-6/
  haiku-4-5; Ollama qwen3/qwen2.5 14–32B, llama3.3:70b, gpt-oss, deepseek-r1:32b, glm-4.x,
  llama3.1:8b) with `supportsTools`/`supportsVision` hints; `registry.ts` constructs the
  adapter + runs a cheap tools-enabled preflight (FR-5b) and surfaces a warning when the
  selected model can't tool-call.
- **Done when:** registry + preflight tests green.

### T1.5 — Settings store (proxy-ready) + neutral first-run chooser

- **Files (new):** `apps/plastiq/src/ai/settings.ts`, `settings.unit.test.ts`,
  `apps/plastiq/src/ai/aiStore.ts` (settings slice only this milestone).
- **Test-first:** settings round-trip through a fake-indexeddb (`fake-indexeddb` is already
  a devDep); a `keyResolver` indirection returns the BYO key now and is overridable by a
  proxy config later (no call-site change). Red first.
- **Implement:** persist provider/model/base-URL/keys in a dedicated IDB store (reuse
  `persistence/idb.ts` patterns); `keyResolver` indirection (decision 21); a neutral
  first-run state (no default provider — FR-5a). UI for this lands in R2.4 with the panel;
  here it's the store + logic + tests.
- **Done when:** settings persist/load; first-run returns "unconfigured"; keyResolver
  swappable.

## Milestone exit criteria

- `pnpm test:unit` green; gated `*.integration.test.ts` green against a local Ollama
  (manual) and skip cleanly in CI; `pnpm typecheck` + build green.
- A caller can: pick a provider/model in settings → `registry` returns a working
  `ChatProvider` → `stream()` yields text + tool-call events from a real model.

## Risks specific to R1

- Ollama CORS: document `OLLAMA_ORIGINS` must include the dev origin (`:5173`) and preview
  (`:4177`); surface in-product later (R2.4). (R-3)
- `dangerouslyAllowBrowser` warning is expected; the key is the user's own (R-4).
- Local tool-call streaming quirks (arg-chunk assembly) — covered by the integration test.

## Commit

`feat(app): SPEC-6 R1 — provider layer (Anthropic/Ollama/proxy) + model registry` (ask first).
