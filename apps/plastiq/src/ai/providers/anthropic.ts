// SPEC-6 R1.3 — the Anthropic chat adapter (FR-2). Direct browser calls via
// `dangerouslyAllowBrowser` (the key is the user's own — R-4), adaptive thinking,
// streaming, tools, and image input (vision → parametric, FR-10a).
//
// Request mapping + streamed tool-call assembly are pure + unit-tested
// (anthropic.unit.test.ts); the live round-trip is gated (anthropic.integration.test.ts).

import Anthropic from "@anthropic-ai/sdk";
import type {
  ChatMessage,
  ChatProvider,
  ChatStreamRequest,
  ContentPart,
  StreamEvent,
  ToolChoice,
} from "./types.js";

type AMessage = Anthropic.MessageParam;
type ATool = Anthropic.Tool;
type ABlock = Anthropic.ContentBlockParam;
type AToolChoice = Anthropic.ToolChoice;

/** Map our tool definitions to Anthropic tools (`input_schema` is the JSON Schema). */
export function toAnthropicTools(tools: { name: string; description: string; parameters: Record<string, unknown> }[]): ATool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters as ATool["input_schema"],
  }));
}

/** Models that reject a FORCED `tool_choice` outright — `any`/`tool` ⇒ 400 whether or not
 * extended thinking is on. Dropping thinking (below) is not enough for these, so the forcing
 * is expressed as an instruction instead.
 *
 * `claude-fable-5-1` is the only id the 400 was actually observed on. The prefix match is a
 * deliberate GUESS that dated snapshot ids of the same model behave the same way — it has not
 * been tested. Add an id here only once the 400 has been seen on it. */
const FORCED_TOOL_CHOICE_UNSUPPORTED = ["claude-fable-5-1"];

function rejectsForcedToolChoice(model: string): boolean {
  return FORCED_TOOL_CHOICE_UNSUPPORTED.some((m) => model.startsWith(m));
}

/** The instruction that replaces a dropped forced `tool_choice` — Anthropic's documented
 * substitute wording, verbatim. It is a request, not a guarantee: the model may still answer
 * in text. The named-tool sentence is the one that was measured against claude-fable-5-1;
 * the `any` sentence is the documented wording for `tool_choice: {type:"any"}` and was NOT
 * exercised by that measurement. */
function forceToolInstruction(tc: AToolChoice): string {
  return tc.type === "tool"
    ? `Use the \`${tc.name}\` tool to answer; call it rather than replying in text.`
    : "Respond with a tool call rather than text whenever one of the tools applies.";
}

/** Map our tool-choice to Anthropic's `tool_choice`. `undefined`/`"auto"` ⇒ omit
 * (the model decides). `"required"` ⇒ `any` (force *some* tool); `"none"` ⇒ forbid
 * tools; `{ tool }` ⇒ force that specific tool. This is what makes `firstTool`
 * (CB6.2 — push a weak/first turn onto `build_part`) take effect with Claude. */
export function toAnthropicToolChoice(tc: ToolChoice | undefined): AToolChoice | undefined {
  if (tc === undefined || tc === "auto") return undefined;
  if (tc === "required") return { type: "any" };
  if (tc === "none") return { type: "none" };
  return { type: "tool", name: tc.tool };
}

function userBlocks(content: string | ContentPart[]): ABlock[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content.map((p): ABlock =>
    p.type === "text"
      ? { type: "text", text: p.text }
      : {
          type: "image",
          source: { type: "base64", media_type: p.mediaType, data: p.data } as Anthropic.ImageBlockParam["source"],
        },
  );
}

function asText(content: string | ContentPart[]): string {
  return typeof content === "string"
    ? content
    : content.map((p) => (p.type === "text" ? p.text : "")).join("");
}

/** Map our conversation to Anthropic messages. The system prompt is NOT included
 * here — it is a separate top-level param on the request. Our `tool` role becomes a
 * user message carrying a `tool_result` block (Anthropic's convention). */
export function toAnthropicMessages(messages: ChatMessage[]): AMessage[] {
  const out: AMessage[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      out.push({ role: "user", content: userBlocks(m.content) });
    } else if (m.role === "assistant") {
      const blocks: ABlock[] = [];
      const text = asText(m.content);
      if (text) blocks.push({ type: "text", text });
      for (const tc of m.toolCalls ?? []) {
        blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.arguments as Record<string, unknown> });
      }
      out.push({ role: "assistant", content: blocks });
    } else if (m.role === "tool") {
      out.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: m.toolCallId ?? "", content: asText(m.content) }],
      });
    }
    // system-role messages are ignored: the system prompt is req.system.
  }
  return out;
}

// ── Streamed tool-call assembly (pure) ──────────────────────────────────────────
// Anthropic streams a tool_use block as: content_block_start (id + name), then
// input_json_delta fragments (the JSON `input` accrues), then content_block_stop.

export interface AnthropicStreamEvent {
  type: string;
  index?: number;
  message?: { usage?: { input_tokens?: number; output_tokens?: number } };
  content_block?: { type: string; id?: string; name?: string };
  delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string | null };
  usage?: { output_tokens?: number };
}

interface ToolAcc {
  id?: string;
  name: string;
  args: string;
}
export interface AnthropicState {
  tools: Map<number, ToolAcc>;
  input: number;
  output: number;
  stopReason?: string | null;
}

export function initAnthropicState(): AnthropicState {
  return { tools: new Map(), input: 0, output: 0 };
}

export function reduceAnthropicEvent(state: AnthropicState, ev: AnthropicStreamEvent): StreamEvent[] {
  const out: StreamEvent[] = [];
  switch (ev.type) {
    case "message_start":
      if (ev.message?.usage?.input_tokens != null) state.input = ev.message.usage.input_tokens;
      if (ev.message?.usage?.output_tokens != null) state.output = ev.message.usage.output_tokens;
      break;
    case "content_block_start":
      if (ev.content_block?.type === "tool_use" && ev.index != null) {
        state.tools.set(ev.index, { id: ev.content_block.id, name: ev.content_block.name ?? "", args: "" });
      }
      break;
    case "content_block_delta":
      if (ev.delta?.type === "text_delta" && ev.delta.text) {
        out.push({ type: "text-delta", text: ev.delta.text });
      } else if (ev.delta?.type === "input_json_delta" && ev.index != null) {
        const acc = state.tools.get(ev.index);
        if (acc && ev.delta.partial_json) acc.args += ev.delta.partial_json;
      }
      break;
    case "message_delta":
      if (ev.delta?.stop_reason != null) state.stopReason = ev.delta.stop_reason;
      if (ev.usage?.output_tokens != null) state.output = ev.usage.output_tokens;
      break;
  }
  return out;
}

export function finalizeAnthropic(state: AnthropicState): StreamEvent[] {
  const out: StreamEvent[] = [{ type: "usage", usage: { inputTokens: state.input, outputTokens: state.output } }];
  for (const [, acc] of [...state.tools.entries()].sort((a, b) => a[0] - b[0])) {
    try {
      const args: unknown = acc.args.trim() ? JSON.parse(acc.args) : {};
      out.push({ type: "tool-call", call: { id: acc.id ?? "", name: acc.name, arguments: args } });
    } catch {
      out.push({ type: "error", error: `tool '${acc.name}': arguments were not valid JSON` });
    }
  }
  const sr = state.stopReason;
  const finishReason = sr === "tool_use" ? "tool-calls" : sr === "max_tokens" ? "length" : "stop";
  out.push({ type: "done", finishReason });
  return out;
}

export interface AnthropicConfig {
  apiKey: string;
  model: string;
  /** Output token cap (streaming, so a generous default is safe). */
  maxTokens?: number;
  baseURL?: string;
  /** Adaptive thinking on by default (curated models are 4.6+); disable for older. */
  thinking?: boolean;
  client?: Anthropic;
}

export class AnthropicAdapter implements ChatProvider {
  readonly id = "anthropic" as const;
  readonly model: string;
  readonly supportsVision = true;
  readonly supportsTools = true;
  private readonly client: Anthropic;
  private readonly maxTokens: number;
  private readonly thinking: boolean;

  constructor(cfg: AnthropicConfig) {
    this.model = cfg.model;
    this.maxTokens = cfg.maxTokens ?? 16000;
    this.thinking = cfg.thinking ?? true;
    this.client =
      cfg.client ??
      new Anthropic({
        apiKey: cfg.apiKey,
        ...(cfg.baseURL ? { baseURL: cfg.baseURL } : {}),
        dangerouslyAllowBrowser: true,
      });
  }

  async *stream(req: ChatStreamRequest): AsyncIterable<StreamEvent> {
    // tool_choice is only valid alongside tools; omit it (auto) otherwise.
    const requested = req.tools.length > 0 ? toAnthropicToolChoice(req.toolChoice) : undefined;
    // Newer models (see FORCED_TOOL_CHOICE_UNSUPPORTED) reject a forced tool_choice outright,
    // so there is nothing to honor: drop it and state the requirement in the system prompt
    // instead. Everywhere else the forcing is kept exactly as before.
    const droppedForce =
      requested &&
      (requested.type === "any" || requested.type === "tool") &&
      rejectsForcedToolChoice(this.model)
        ? requested
        : undefined;
    const toolChoice = droppedForce ? undefined : requested;
    const system = droppedForce
      ? `${req.system}\n\n${forceToolInstruction(droppedForce)}`
      : req.system;
    // Anthropic rejects extended thinking combined with FORCED tool use
    // (`any`/`tool` ⇒ 400). When a tool is forced (e.g. `firstTool` on turn 1),
    // honor the forced tool by dropping thinking for THIS turn only; unforced
    // turns keep adaptive thinking. Note this reads `requested`, not `toolChoice`:
    // a turn whose forcing was dropped above still drops thinking, so the request
    // sent on the substitute path is the one that was actually verified against
    // claude-fable-5-1 (no tool_choice AND no thinking block). Re-enabling adaptive
    // thinking on that path may well work; it has not been measured, so we do not.
    const forcesTool = requested?.type === "any" || requested?.type === "tool";
    const useThinking = this.thinking && !forcesTool;
    let stream: AsyncIterable<unknown>;
    try {
      stream = await this.client.messages.create(
        {
          model: this.model,
          max_tokens: this.maxTokens,
          system,
          messages: toAnthropicMessages(req.messages),
          ...(req.tools.length > 0 ? { tools: toAnthropicTools(req.tools) } : {}),
          ...(toolChoice ? { tool_choice: toolChoice } : {}),
          ...(useThinking ? { thinking: { type: "adaptive" } } : {}),
          stream: true,
        },
        { signal: req.signal },
      );
    } catch (e) {
      yield { type: "error", error: e instanceof Error ? e.message : String(e) };
      yield { type: "done", finishReason: "error" };
      return;
    }

    const state = initAnthropicState();
    try {
      for await (const ev of stream) {
        for (const out of reduceAnthropicEvent(state, ev as AnthropicStreamEvent)) yield out;
      }
    } catch (e) {
      yield { type: "error", error: e instanceof Error ? e.message : String(e) };
      yield { type: "done", finishReason: "error" };
      return;
    }
    for (const out of finalizeAnthropic(state)) yield out;
  }
}
