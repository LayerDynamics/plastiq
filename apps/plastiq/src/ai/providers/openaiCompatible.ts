// SPEC-6 R1.2 — the OpenAI-compatible chat adapter (spec decision 23).
//
// One adapter, via the official `openai` SDK + a configurable baseURL, covers:
//   • local Ollama  (http://localhost:11434/v1, no key)
//   • OpenAI        (api.openai.com)
//   • a hosted proxy (key held server-side) — a settings change, no code change (FR-5)
//
// The request mapping and the streamed tool-call assembly are factored into pure
// functions so they can be unit-tested without a network (openaiCompatible.unit.test.ts);
// the live round-trip is the gated openaiCompatible.integration.test.ts.

import OpenAI from "openai";
import type {
  ChatMessage,
  ChatProvider,
  ChatStreamRequest,
  ContentPart,
  StreamEvent,
  ToolChoice,
  ToolDef,
} from "./types.js";

type OAMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type OATool = OpenAI.Chat.Completions.ChatCompletionTool;
type OAToolChoice = OpenAI.Chat.Completions.ChatCompletionToolChoiceOption;
type OAContentPart = OpenAI.Chat.Completions.ChatCompletionContentPart;

/** Map our tool definitions to OpenAI `function` tools. */
export function toOpenAITools(tools: ToolDef[]): OATool[] {
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

/** Map our tool-choice to OpenAI's `tool_choice`. `undefined` ⇒ omit (auto). */
export function toOpenAIToolChoice(tc: ToolChoice | undefined): OAToolChoice | undefined {
  if (tc === undefined || tc === "auto") return undefined;
  if (tc === "required" || tc === "none") return tc;
  return { type: "function", function: { name: tc.tool } };
}

function mapUserContent(content: string | ContentPart[]): string | OAContentPart[] {
  if (typeof content === "string") return content;
  return content.map((p): OAContentPart =>
    p.type === "text"
      ? { type: "text", text: p.text }
      : { type: "image_url", image_url: { url: `data:${p.mediaType};base64,${p.data}` } },
  );
}

function asText(content: string | ContentPart[]): string {
  return typeof content === "string"
    ? content
    : content.map((p) => (p.type === "text" ? p.text : "")).join("");
}

/** Map our conversation to OpenAI chat messages. The system prompt is always the
 * first message (even when empty, for a stable shape). */
export function toOpenAIMessages(system: string, messages: ChatMessage[]): OAMessage[] {
  const out: OAMessage[] = [{ role: "system", content: system }];
  for (const m of messages) {
    if (m.role === "user") {
      out.push({ role: "user", content: mapUserContent(m.content) });
    } else if (m.role === "assistant") {
      const msg: OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam = {
        role: "assistant",
        content: asText(m.content),
      };
      if (m.toolCalls && m.toolCalls.length > 0) {
        msg.tool_calls = m.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
        }));
      }
      out.push(msg);
    } else if (m.role === "tool") {
      out.push({ role: "tool", tool_call_id: m.toolCallId ?? "", content: asText(m.content) });
    } else {
      out.push({ role: "system", content: asText(m.content) });
    }
  }
  return out;
}

// ── Streamed tool-call assembly (pure) ──────────────────────────────────────────
// OpenAI streams a tool call in fragments: the name + id arrive in the first delta,
// the JSON `arguments` string accrues across later deltas (keyed by `index`).

export interface MinimalToolCallDelta {
  index: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}
export interface MinimalChoiceDelta {
  content?: string | null;
  tool_calls?: MinimalToolCallDelta[];
}
export interface MinimalChoice {
  delta?: MinimalChoiceDelta;
  finish_reason?: string | null;
}
export interface MinimalChunk {
  choices?: MinimalChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
}

interface ToolAcc {
  id?: string;
  name: string;
  args: string;
}
export interface StreamState {
  tools: Map<number, ToolAcc>;
  finishReason?: string;
}

export function initStreamState(): StreamState {
  return { tools: new Map() };
}

/** Fold one stream chunk into `state`, emitting any text/usage events it carries. */
export function reduceChunk(state: StreamState, chunk: MinimalChunk): StreamEvent[] {
  const events: StreamEvent[] = [];
  const choice = chunk.choices?.[0];
  const delta = choice?.delta;
  if (delta?.content) events.push({ type: "text-delta", text: delta.content });
  if (delta?.tool_calls) {
    for (const tc of delta.tool_calls) {
      const acc = state.tools.get(tc.index) ?? { name: "", args: "" };
      if (tc.id) acc.id = tc.id;
      if (tc.function?.name) acc.name += tc.function.name;
      if (tc.function?.arguments) acc.args += tc.function.arguments;
      state.tools.set(tc.index, acc);
    }
  }
  if (choice?.finish_reason) state.finishReason = choice.finish_reason;
  if (chunk.usage) {
    events.push({
      type: "usage",
      usage: { inputTokens: chunk.usage.prompt_tokens ?? 0, outputTokens: chunk.usage.completion_tokens ?? 0 },
    });
  }
  return events;
}

/** Emit the assembled tool calls (in index order) and the terminal `done` event. */
export function finalizeStream(state: StreamState): StreamEvent[] {
  const events: StreamEvent[] = [];
  for (const [, acc] of [...state.tools.entries()].sort((a, b) => a[0] - b[0])) {
    try {
      const args: unknown = acc.args.trim() ? JSON.parse(acc.args) : {};
      events.push({ type: "tool-call", call: { id: acc.id ?? "", name: acc.name, arguments: args } });
    } catch {
      events.push({ type: "error", error: `tool '${acc.name}': arguments were not valid JSON` });
    }
  }
  const fr = state.finishReason;
  const finishReason = fr === "tool_calls" ? "tool-calls" : fr === "length" ? "length" : "stop";
  events.push({ type: "done", finishReason });
  return events;
}

export interface OpenAICompatConfig {
  baseURL: string;
  apiKey?: string;
  model: string;
  supportsVision?: boolean;
  /** Injectable client for tests; defaults to a real OpenAI client on `baseURL`. */
  client?: OpenAI;
}

export class OpenAICompatAdapter implements ChatProvider {
  readonly id = "openai-compatible" as const;
  readonly model: string;
  readonly supportsVision: boolean;
  readonly supportsTools = true;
  private readonly client: OpenAI;

  constructor(cfg: OpenAICompatConfig) {
    this.model = cfg.model;
    this.supportsVision = cfg.supportsVision ?? false;
    this.client =
      cfg.client ??
      new OpenAI({
        baseURL: cfg.baseURL,
        // Ollama ignores the key but the SDK requires a non-empty string.
        apiKey: cfg.apiKey && cfg.apiKey.length > 0 ? cfg.apiKey : "ollama",
        dangerouslyAllowBrowser: true,
      });
  }

  async *stream(req: ChatStreamRequest): AsyncIterable<StreamEvent> {
    let stream: Awaited<ReturnType<typeof this.client.chat.completions.create>>;
    try {
      stream = await this.client.chat.completions.create(
        {
          model: this.model,
          messages: toOpenAIMessages(req.system, req.messages),
          tools: req.tools.length > 0 ? toOpenAITools(req.tools) : undefined,
          ...(req.tools.length > 0 && toOpenAIToolChoice(req.toolChoice) !== undefined
            ? { tool_choice: toOpenAIToolChoice(req.toolChoice) }
            : {}),
          stream: true,
          stream_options: { include_usage: true },
        },
        { signal: req.signal },
      );
    } catch (e) {
      yield { type: "error", error: e instanceof Error ? e.message : String(e) };
      yield { type: "done", finishReason: "error" };
      return;
    }

    const state = initStreamState();
    try {
      // `stream` is the streaming overload's async iterable of chunks.
      for await (const chunk of stream as AsyncIterable<MinimalChunk>) {
        for (const ev of reduceChunk(state, chunk)) yield ev;
      }
    } catch (e) {
      yield { type: "error", error: e instanceof Error ? e.message : String(e) };
      yield { type: "done", finishReason: "error" };
      return;
    }
    for (const ev of finalizeStream(state)) yield ev;
  }
}
