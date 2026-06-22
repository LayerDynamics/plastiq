// SPEC-6 R1.1 — the vendor-neutral chat provider contract (spec §5.2).
//
// Every adapter (Anthropic direct, OpenAI-compatible incl. Ollama, proxy) implements
// `ChatProvider`. The agent loop (R2) talks only to this interface, so swapping
// providers — or pointing at a hosted proxy — is a settings change, never a code change.

/** A JSON Schema object describing a tool's input (passed to the model verbatim). */
export type JsonSchema = Record<string, unknown>;

/** A tool the model may call. `parameters` is JSON Schema for the tool input. */
export interface ToolDef {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface TextPart {
  type: "text";
  text: string;
}
/** An image input (vision). `data` is base64 (no data-URL prefix). */
export interface ImagePart {
  type: "image";
  mediaType: string;
  data: string;
}
export type ContentPart = TextPart | ImagePart;

export type ChatRole = "system" | "user" | "assistant" | "tool";

/** A model tool call (arguments already parsed from JSON). */
export interface ToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

/** One conversation turn. Assistant turns may carry `toolCalls`; a `tool` turn
 * answers a specific call via `toolCallId`. */
export interface ChatMessage {
  role: ChatRole;
  content: string | ContentPart[];
  toolCalls?: ToolCall[];
  toolCallId?: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

/** Events streamed back from a provider during one `stream()` call. */
export type StreamEvent =
  | { type: "text-delta"; text: string }
  | { type: "tool-call"; call: ToolCall }
  | { type: "usage"; usage: TokenUsage }
  | { type: "done"; finishReason: "stop" | "tool-calls" | "length" | "error" }
  | { type: "error"; error: string };

/** How the model is allowed/forced to use tools this turn. `{ tool }` forces that
 * specific function; `"required"` forces *some* tool; `"auto"` (default) lets the
 * model choose; `"none"` forbids tools. Used to push weak models off prose-only
 * answers onto `build_part` (FR-5b / CB6.2). */
export type ToolChoice = "auto" | "required" | "none" | { tool: string };

export interface ChatStreamRequest {
  /** System prompt (the parametric/creative prompt from R2.4). */
  system: string;
  messages: ChatMessage[];
  tools: ToolDef[];
  /** Optional per-turn tool-use constraint (default: provider's auto). */
  toolChoice?: ToolChoice;
  signal?: AbortSignal;
}

/** A streaming, tool-calling chat backend. Implementations: AnthropicAdapter (R1.3),
 * OpenAICompatAdapter (R1.2). `supportsVision`/`supportsTools` gate the UI (FR-10b/FR-5b). */
export interface ChatProvider {
  readonly id: "anthropic" | "openai-compatible";
  readonly model: string;
  readonly supportsVision: boolean;
  readonly supportsTools: boolean;
  stream(req: ChatStreamRequest): AsyncIterable<StreamEvent>;
}
