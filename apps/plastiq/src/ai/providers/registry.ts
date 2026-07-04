// SPEC-6 R1.4 — construct a ChatProvider from the user's settings (FR-1, FR-5).
//
// The agent loop (R2) depends only on this: pick a provider/model in settings ->
// `buildProvider` returns a ready ChatProvider. Pointing any OpenAI-compatible
// preset at a hosted proxy base-URL is purely a settings change (FR-5, proxy-ready).

import type { ChatProvider } from "./types.js";
import { AnthropicAdapter } from "./anthropic.js";
import { OpenAICompatAdapter } from "./openaiCompatible.js";
import { LlamaMlxAdapter, LLAMA_MLX_DEFAULT_BASE_URL } from "./llama-mlx.js";
import { MODEL_CATALOG, preflightModel, type ProviderId } from "./models.js";

export interface ProviderSettings {
  /** Catalog preset key, e.g. "anthropic" | "ollama" | "openai" (or a custom key). */
  providerKey: string;
  /** Which adapter to build. */
  providerId: ProviderId;
  model: string;
  /** Overrides the preset's default base URL (also the proxy hook — FR-5). */
  baseURL?: string;
  apiKey?: string;
}

/** Build the configured chat provider. Adapter constructors do no network I/O, so
 * this is safe to call eagerly (e.g. on a settings change). */
export function buildProvider(s: ProviderSettings): ChatProvider {
  const caps = preflightModel(s.providerKey, s.model);
  if (s.providerId === "anthropic") {
    return new AnthropicAdapter({
      apiKey: s.apiKey ?? "",
      model: s.model,
      ...(s.baseURL ? { baseURL: s.baseURL } : {}),
    });
  }
  if (s.providerId === "llama-mlx") {
    return new LlamaMlxAdapter({
      apiKey: s.apiKey,
      model: s.model,
      supportsVision: caps.supportsVision,
      baseURL: s.baseURL ?? MODEL_CATALOG[s.providerKey]?.defaultBaseURL ?? LLAMA_MLX_DEFAULT_BASE_URL,
    });
  }
  const baseURL = s.baseURL ?? MODEL_CATALOG[s.providerKey]?.defaultBaseURL ?? "http://localhost:11434/v1";
  return new OpenAICompatAdapter({
    baseURL,
    apiKey: s.apiKey,
    model: s.model,
    supportsVision: caps.supportsVision,
  });
}
