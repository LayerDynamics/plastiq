// SPEC-6 R1.4 — curated model catalog + tool-capability preflight (FR-5b, decision 22).
//
// Seeded from June 2026 research (SPEC-6 Appendix A). Tool calling is the gating
// requirement for build_part; most local Ollama models are NOT vision-capable, and
// reliable tool *selection* needs >=14B. The picker offers this list plus a free-text
// override; `preflightModel` warns when a chosen model isn't known to support tools.

import type { ChatProvider } from "./types.js";

export type ProviderId = ChatProvider["id"]; // "anthropic" | "openai-compatible"

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
