// SPEC-6 R1.4 — curated model catalog + tool-capability preflight (FR-5b, decision 22).
//
// Seeded from June 2026 research (SPEC-6 Appendix A). Tool calling is the gating
// requirement for build_part; most local Ollama models are NOT vision-capable, and
// reliable tool *selection* needs >=14B. The picker offers this list plus a free-text
// override; `preflightModel` warns when a chosen model isn't known to support tools.
//
// Two preflight layers (FR-5b/§6.9):
//   • `preflightModel` — the synchronous static catalog lookup (instant, offline).
//   • `probeModelCapabilities` — the async LIVE probe that supersedes it when it can
//     answer: Ollama's `/api/show` model metadata (its `capabilities` array), else a
//     minimal tools-enabled chat probe against the OpenAI-compatible endpoint (also
//     the llama-mlx path — the server speaks the same /v1 surface). Anthropic stays
//     on catalog truth (no cheap metadata endpoint; a probe would burn user tokens).
//     Offline/unreachable ⇒ the static catalog result — the probe never blocks.

import type { ChatProvider } from "./types.js";

export type ProviderId = ChatProvider["id"]; // "anthropic" | "openai-compatible" | "llama-mlx"

export interface ModelInfo {
  id: string;
  label: string;
  supportsTools: boolean;
  supportsVision: boolean;
}

export interface ProviderCatalogEntry {
  /** Catalog key (provider preset), e.g. "anthropic" | "ollama" | "openai". */
  key: string;
  /** Which adapter implements it. */
  providerId: ProviderId;
  label: string;
  /** Whether the user must supply an API key (Ollama does not). */
  needsKey: boolean;
  defaultBaseURL?: string;
}

export interface CatalogEntryWithModels extends ProviderCatalogEntry {
  models: ModelInfo[];
}

const claude = (id: string, label: string): ModelInfo => ({ id, label, supportsTools: true, supportsVision: true });
const ollamaModel = (id: string, label: string): ModelInfo => ({ id, label, supportsTools: true, supportsVision: false });
// llama-mlx-server grammar-backs tool calls, so even small MLX models emit
// well-formed build_part calls — tools are reliable regardless of size.
const mlxModel = (id: string, label: string): ModelInfo => ({ id, label, supportsTools: true, supportsVision: false });

export const MODEL_CATALOG: Record<string, CatalogEntryWithModels> = {
  anthropic: {
    key: "anthropic",
    providerId: "anthropic",
    label: "Anthropic (Claude)",
    needsKey: true,
    models: [
      claude("claude-opus-4-8", "Claude Opus 4.8 (quality)"),
      claude("claude-sonnet-4-6", "Claude Sonnet 4.6 (balanced)"),
      claude("claude-haiku-4-5", "Claude Haiku 4.5 (fast)"),
    ],
  },
  ollama: {
    key: "ollama",
    providerId: "openai-compatible",
    label: "Ollama (local, no key)",
    needsKey: false,
    defaultBaseURL: "http://localhost:11434/v1",
    models: [
      ollamaModel("qwen3", "Qwen3 (>=14B for reliable tools)"),
      ollamaModel("qwen2.5", "Qwen2.5 (>=14B for reliable tools)"),
      ollamaModel("llama3.3:70b", "Llama 3.3 70B"),
      ollamaModel("gpt-oss", "GPT-OSS"),
      ollamaModel("deepseek-r1:32b", "DeepSeek-R1 32B"),
      ollamaModel("glm-4", "GLM-4"),
      ollamaModel("llama3.1:8b", "Llama 3.1 8B (fast / dev)"),
    ],
  },
  openai: {
    key: "openai",
    providerId: "openai-compatible",
    label: "OpenAI (or compatible)",
    needsKey: true,
    defaultBaseURL: "https://api.openai.com/v1",
    // OpenAI model ids move fast — left to the free-text override + preflight.
    models: [],
  },
  "llama-mlx": {
    key: "llama-mlx",
    providerId: "llama-mlx",
    label: "llama-mlx-server (local MLX)",
    // Auth is on by default; the Bearer key is minted into the macOS Keychain.
    needsKey: true,
    defaultBaseURL: "http://127.0.0.1:11543/v1",
    // The server auto-discovers MLX models on disk (HF cache, LM Studio); these
    // are common mlx-community picks. Any served model works via the free-text
    // override + preflight.
    models: [
      mlxModel("mlx-community/Qwen2.5-14B-Instruct-4bit", "Qwen2.5 14B (quality)"),
      mlxModel("mlx-community/Qwen2.5-7B-Instruct-4bit", "Qwen2.5 7B (balanced)"),
      mlxModel("mlx-community/Qwen2.5-3B-Instruct-4bit", "Qwen2.5 3B (fast)"),
      mlxModel("mlx-community/Qwen2.5-0.5B-Instruct-4bit", "Qwen2.5 0.5B (dev/smoke)"),
    ],
  },
};

export interface PreflightResult {
  supportsTools: boolean;
  supportsVision: boolean;
  /** Set when the model can't (or isn't known to) tool-call — build_part may fail. */
  warning?: string;
}

/** Determine a model's capabilities for the picker + a tool-capability warning (FR-5b).
 * Curated models report their known caps; an uncurated (custom) model is allowed but
 * flagged as unverified, since tool calling is required for generation. */
export function preflightModel(providerKey: string, model: string): PreflightResult {
  const entry = MODEL_CATALOG[providerKey];
  const found = entry?.models.find((m) => m.id === model);
  if (found) {
    return {
      supportsTools: found.supportsTools,
      supportsVision: found.supportsVision,
      ...(found.supportsTools
        ? {}
        : { warning: `'${model}' is not known to support tool calling — generation (build_part) may not work.` }),
    };
  }
  return {
    supportsTools: true,
    supportsVision: false,
    warning: `'${model}' is a custom model not in the curated list — verify it supports tool calling (required for generation).`,
  };
}

// ── Live capability probe (FR-5b/§6.9) ──────────────────────────────────────────
// The async counterpart to `preflightModel`: actually asks the endpoint whether the
// selected model can tool-call, instead of trusting the static catalog.

/** How the probe settled: positively verified, positively ruled out, or unknown. */
export type ProbeVerdict = "confirmed" | "refuted" | "unverified";

/** What answered: Ollama's model metadata, a live tools-enabled chat probe, or the
 * static catalog (Anthropic truth, or the offline/unreachable fallback). */
export type ProbeSource = "ollama-metadata" | "chat-probe" | "catalog";

export interface ProbeResult extends PreflightResult {
  verdict: ProbeVerdict;
  source: ProbeSource;
}

export interface ProbeOptions {
  /** Effective endpoint override; absent ⇒ the preset's default base URL. */
  baseURL?: string;
  /** Sent as `Authorization: Bearer <key>` — only ever to the configured endpoint. */
  apiKey?: string;
  /** Caller-side cancellation (e.g. the selection changed) — abort the in-flight probe. */
  signal?: AbortSignal;
  /** Hard cap on the probe round-trip; default 5000 ms. */
  timeoutMs?: number;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

const PROBE_TIMEOUT_MS = 5000;

// A tools-unsupported rejection must mention tools/function-calling AND unsupport —
// e.g. Ollama's `"llama2 does not support tools"` — so an unrelated 4xx (bad key,
// unknown model) never refutes a model that may well tool-call.
const TOOLS_MENTION_RE = /tool|function[ _-]?call/i;
const UNSUPPORTED_RE = /does ?n[o']t support|not support(?:ed)?|unsupported|no support/i;

/** The Ollama native API lives at the server root, one level above the /v1 OpenAI surface. */
function isOllamaEndpoint(providerKey: string, baseURL: string): boolean {
  return providerKey === "ollama" || /(localhost|127\.0\.0\.1):11434/.test(baseURL);
}

/** Ollama `/api/show` metadata probe. Returns null when this endpoint can't decide —
 * an older Ollama without the `capabilities` field, a not-yet-pulled model (404), or
 * a non-JSON answer — so the caller falls through to the chat probe. Connection
 * failures throw (the caller's catalog fallback catches them). */
async function ollamaShowProbe(
  baseURL: string,
  model: string,
  headers: Record<string, string>,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<ProbeResult | null> {
  const root = baseURL.replace(/\/v1$/, "");
  const res = await fetchImpl(`${root}/api/show`, {
    method: "POST",
    headers,
    // `model` is the current field; `name` keeps pre-0.5 Ollama servers answering.
    body: JSON.stringify({ model, name: model }),
    signal,
  });
  if (!res.ok) return null;
  const data = (await res.json().catch(() => null)) as { capabilities?: unknown } | null;
  if (!Array.isArray(data?.capabilities)) return null; // pre-capabilities Ollama
  const caps = data.capabilities.filter((c): c is string => typeof c === "string");
  const supportsVision = caps.includes("vision");
  if (caps.includes("tools")) {
    return { supportsTools: true, supportsVision, verdict: "confirmed", source: "ollama-metadata" };
  }
  return {
    supportsTools: false,
    supportsVision,
    verdict: "refuted",
    source: "ollama-metadata",
    warning: `'${model}' does not support tool calling (per the endpoint's model metadata) — generation (build_part) will not work.`,
  };
}

/** Minimal tools-enabled chat probe against an OpenAI-compatible endpoint (max_tokens 1,
 * one trivial tool the model may or may not call). Success ⇒ tools accepted; an explicit
 * 4xx tools-unsupported rejection ⇒ refuted; any unrelated failure can't refute — keep
 * the catalog's answer (and its unverified note for custom models). */
async function chatToolProbe(
  baseURL: string,
  model: string,
  headers: Record<string, string>,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
  catalog: PreflightResult,
): Promise<ProbeResult> {
  const res = await fetchImpl(`${baseURL}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "ping" }],
      tools: [
        {
          type: "function",
          function: {
            name: "noop",
            description: "Capability probe — never executed.",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
      max_tokens: 1,
      stream: false,
    }),
    signal,
  });
  if (res.ok) {
    return { supportsTools: true, supportsVision: catalog.supportsVision, verdict: "confirmed", source: "chat-probe" };
  }
  const body = await res.text().catch(() => "");
  if (res.status >= 400 && res.status < 500 && TOOLS_MENTION_RE.test(body) && UNSUPPORTED_RE.test(body)) {
    return {
      supportsTools: false,
      supportsVision: catalog.supportsVision,
      verdict: "refuted",
      source: "chat-probe",
      warning: `'${model}' rejected a tools-enabled request — it does not support tool calling, so generation (build_part) will not work.`,
    };
  }
  return { ...catalog, verdict: "unverified", source: "chat-probe" };
}

/** LIVE tool-capability preflight (FR-5b/§6.9) — supersedes the static `preflightModel`
 * hint when the endpoint can actually answer:
 *   • Ollama endpoints: `POST /api/show` model metadata (`capabilities` ∋ "tools"/"vision");
 *     an older Ollama without `capabilities` falls back to the chat probe below.
 *   • Other OpenAI-compatible endpoints (incl. llama-mlx-server — same /v1 surface):
 *     the minimal tools-enabled chat probe.
 *   • Anthropic: catalog truth — every curated Claude supports tools+vision, and a custom
 *     id keeps the unverified warning (no cheap metadata endpoint; no tokens burned).
 * Never rejects and never blocks: offline/unreachable/aborted/timed-out ⇒ the static
 * catalog result as `verdict: "unverified"`. */
export async function probeModelCapabilities(
  providerKey: string,
  model: string,
  opts: ProbeOptions = {},
): Promise<ProbeResult> {
  const catalog = preflightModel(providerKey, model);
  const entry = MODEL_CATALOG[providerKey];
  if ((entry?.providerId ?? providerKey) === "anthropic") {
    const curated = entry?.models.some((m) => m.id === model) ?? false;
    return { ...catalog, verdict: curated ? "confirmed" : "unverified", source: "catalog" };
  }

  const fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const baseURL = (opts.baseURL?.trim() || entry?.defaultBaseURL || "http://localhost:11434/v1").replace(/\/+$/, "");
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}),
  };

  // One inner controller = the caller's signal ∪ the timeout, so both cancel the fetch.
  const controller = new AbortController();
  const onOuterAbort = (): void => controller.abort();
  if (opts.signal?.aborted) controller.abort();
  opts.signal?.addEventListener("abort", onOuterAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? PROBE_TIMEOUT_MS);
  try {
    if (isOllamaEndpoint(providerKey, baseURL)) {
      const viaShow = await ollamaShowProbe(baseURL, model, headers, fetchImpl, controller.signal);
      if (viaShow) return viaShow;
    }
    return await chatToolProbe(baseURL, model, headers, fetchImpl, controller.signal, catalog);
  } catch {
    // Unreachable / aborted / timed out — fall back to the static catalog answer
    // (with its unverified note for custom models). The probe never blocks the UI.
    return { ...catalog, verdict: "unverified", source: "catalog" };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onOuterAbort);
  }
}
