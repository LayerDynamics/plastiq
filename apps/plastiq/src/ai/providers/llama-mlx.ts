// SPEC-6 R1.x — the llama-mlx-server chat adapter.
//
// llama-mlx-server (https://github.com/LayerDynamics/llama_mlx) is a local,
// Apple-Silicon (MLX) inference server that speaks the OpenAI wire protocol on
// http://127.0.0.1:11543/v1: `POST /v1/chat/completions` with SSE streaming and
// `stream_options.include_usage`, OpenAI `tools`/`tool_choice`, and OpenAI-shaped
// `tool_calls` back. Its request body is a strict SUPERSET of OpenAI's — verified
// against the server's own schema (packages/schemas ChatCompletionRequest: the
// standard fields plus MLX extras top_k/min_p/repetition_penalty/grammar/adapter,
// all optional). Its tool calls are grammar-backed, so even small local models
// emit well-formed `build_part` calls (the reliability win over raw Ollama).
//
// Because the transport is exactly OpenAI-compatible — and its two streaming
// quirks (no leading `role` delta; whole-tool-call-per-chunk instead of streamed
// argument fragments) are already tolerated by the shared reduceChunk/finalizeStream
// (they read only delta.content/delta.tool_calls and accumulate per index) — this
// adapter REUSES the OpenAI transport (OpenAICompatAdapter) by composition and only
// owns the llama-mlx identity: the `id`, the default :11543/v1 endpoint, and the
// Bearer key (auth is on by default on the server).
//
// The key is the user's own (minted into the macOS Keychain or LLAMA_MLX_API_KEY,
// entered in Settings — R-4); requests go browser → server directly.
//
// CORS: llama-mlx-server ships no CORS middleware, so a browser page on a foreign
// origin cannot reach :11543 — the editor must be served same-origin, behind a
// dev/reverse proxy, or the server must enable CORS. This is the same self-hosted
// constraint as the reconstruct/nerf/capture services (which do send permissive
// CORS); a connection failure surfaces via the errorHints translation with a
// "start llama-mlx-server" hint.

import { OpenAICompatAdapter, type OpenAICompatConfig } from "./openaiCompatible.js";
import type { ChatProvider, ChatStreamRequest, StreamEvent } from "./types.js";

/** Default endpoint of a local llama-mlx-server (server default bind is
 * 127.0.0.1:11543; the OpenAI routes live under /v1). */
export const LLAMA_MLX_DEFAULT_BASE_URL = "http://127.0.0.1:11543/v1";

export interface LlamaMlxConfig {
  /** Bearer key (the server requires it by default). */
  apiKey?: string;
  model: string;
  /** Overrides the default :11543/v1 endpoint — the proxy hook (FR-5) and the way
   * to reach a non-default bind. */
  baseURL?: string;
  /** Vision-capable model (a VLM) — gates image input in the UI (per-model, FR-10b). */
  supportsVision?: boolean;
  /** Injectable client for tests; delegated to the inner OpenAI transport. */
  client?: OpenAICompatConfig["client"];
}

/** A first-class ChatProvider for llama-mlx-server. Owns the llama-mlx identity and
 * defaults; delegates the (identical) OpenAI streaming transport to OpenAICompatAdapter. */
export class LlamaMlxAdapter implements ChatProvider {
  readonly id = "llama-mlx" as const;
  readonly model: string;
  readonly supportsVision: boolean;
  readonly supportsTools = true;
  private readonly inner: OpenAICompatAdapter;

  constructor(cfg: LlamaMlxConfig) {
    this.model = cfg.model;
    this.supportsVision = cfg.supportsVision ?? false;
    this.inner = new OpenAICompatAdapter({
      baseURL: cfg.baseURL ?? LLAMA_MLX_DEFAULT_BASE_URL,
      apiKey: cfg.apiKey,
      model: cfg.model,
      supportsVision: this.supportsVision,
      ...(cfg.client ? { client: cfg.client } : {}),
    });
  }

  stream(req: ChatStreamRequest): AsyncIterable<StreamEvent> {
    return this.inner.stream(req);
  }
}
