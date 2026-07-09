// SPEC-6 R1.4 — construct a ChatProvider from the user's settings (FR-1, FR-5).
//
// The agent loop (R2) depends only on this: pick a provider/model in settings ->
// `buildProvider` returns a ready ChatProvider. Pointing any OpenAI-compatible
// preset at a hosted proxy base-URL is purely a settings change (FR-5, proxy-ready).

import type { ChatProvider } from "./types.js";
import { AnthropicAdapter } from "./anthropic.js";
import { OpenAICompatAdapter } from "./openaiCompatible.js";
import { LlamaMlxAdapter, LLAMA_MLX_DEFAULT_BASE_URL } from "./llama-mlx.js";
import { MODEL_CATALOG, preflightModel, type PreflightResult, type ProviderId } from "./models.js";
import { localKeyResolver, proxyKeyResolver, type AiSettings, type KeyResolver } from "../settings.js";

export interface ProviderSettings {
  /** Catalog preset key, e.g. "anthropic" | "ollama" | "openai" | "llama-mlx" (or a custom key). */
  providerKey: string;
  /** Which adapter to build. */
  providerId: ProviderId;
  model: string;
  /** Overrides the preset's default base URL (also the proxy hook — FR-5). */
  baseURL?: string;
  apiKey?: string;
}

/** Decision-21 key indirection for adapter construction: pick how the adapter's API key
 * is resolved from the persisted settings. A hosted-proxy deployment — a base-URL
 * override with NO BYO key stored for the provider (the same "empty key + base URL"
 * state as the mesh-gen proxy) — resolves through `proxyKeyResolver` (the proxy injects
 * the key server-side); otherwise the user's BYO `localKeyResolver`. A stored key always
 * wins, so a keyed OpenAI-compatible endpoint behind a custom base URL keeps working.
 * Call sites thread this into `toProviderSettings` before `buildProvider`. */
export function keyResolverFor(settings: AiSettings): KeyResolver {
  const hostedProxy = Boolean(settings.baseURL) && !settings.apiKeys[settings.providerKey];
  return hostedProxy ? proxyKeyResolver() : localKeyResolver(settings);
}

/** Build the configured chat provider. Adapter constructors do no network I/O, so
 * this is safe to call eagerly (e.g. on a settings change).
 *
 * `probed` — a live `probeModelCapabilities` result (FR-5b/§6.9). When the caller has
 * one it SUPERSEDES the static catalog hint here (e.g. vision confirmed by Ollama's
 * model metadata threads into the adapter); absent ⇒ the synchronous catalog preflight. */
export function buildProvider(s: ProviderSettings, probed?: PreflightResult): ChatProvider {
  const caps = probed ?? preflightModel(s.providerKey, s.model);
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
