// SPEC-6 R2.3 — the agentic tool loop (spec §5.3, FR-18a step cap, FR-21 cancel).
//
// Drives a ChatProvider: stream a turn → run any tool calls → feed the results back
// → repeat until the model finishes (a turn with no tool calls, or the `answer_user`
// finalizer) or the step cap halts it. A tool that fails returns its error as the
// tool result, so the model self-corrects on the next turn — bounded by the cap (no
// separate retry counter needed). An AbortSignal cancels at the next turn boundary.

import type { ChatMessage, ChatProvider, ToolCall, ToolChoice, ToolDef } from "./providers/types.js";

export type AgentFinish = "answer" | "cap" | "cancelled" | "error";

export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "tool-call"; id: string; name: string; args: unknown }
  | { type: "tool-result"; id: string; name: string; result: string; isError: boolean }
  | { type: "usage"; inputTokens: number; outputTokens: number }
  | { type: "status"; finish: AgentFinish; steps: number };

/** A client-side tool: receives the parsed args, returns a result string for the
 * model (set `isError` to feed a correction back). */
export type ToolHandler = (args: unknown) => Promise<{ result: string; isError?: boolean }>;

export interface AgentTools {
  defs: ToolDef[];
  handlers: Record<string, ToolHandler>;
}

export interface RunAgentOptions {
  provider: ChatProvider;
  system: string;
  /** Initial conversation, e.g. `[{ role: "user", content: "make a cube" }]`. */
  messages: ChatMessage[];
  tools: AgentTools;
  /** Hard cap on model turns (always on — FR-18a). Default 12. */
  maxSteps?: number;
  /** The tool whose call ends the loop after running (CADAM-style). Default "answer_user". */
  finalToolName?: string;
  /** Force this tool on the FIRST turn (tool_choice), then auto. Pushes weak models
   * to call build_part instead of answering in prose (CB6.2). */
  firstTool?: string;
  signal?: AbortSignal;
  onEvent?: (e: AgentEvent) => void;
}

export interface RunAgentResult {
  finish: AgentFinish;
  steps: number;
  /** The full conversation including assistant + tool turns. */
  messages: ChatMessage[];
}

export async function runAgent(opts: RunAgentOptions): Promise<RunAgentResult> {
  const { provider, system, tools, signal } = opts;
  const maxSteps = opts.maxSteps ?? 12;
  const finalTool = opts.finalToolName ?? "answer_user";
  const emit = (e: AgentEvent): void => opts.onEvent?.(e);
  const messages: ChatMessage[] = [...opts.messages];

  let steps = 0;
  while (steps < maxSteps) {
    if (signal?.aborted) {
      emit({ type: "status", finish: "cancelled", steps });
      return { finish: "cancelled", steps, messages };
    }
    steps++;

    let text = "";
    const toolCalls: ToolCall[] = [];
    // Force the configured tool on the first turn only (then let the model choose,
    // so it can still reach the answer_user finalizer).
    const toolChoice: ToolChoice | undefined =
      steps === 1 && opts.firstTool ? { tool: opts.firstTool } : undefined;
    try {
      for await (const ev of provider.stream({
        system,
        messages,
        tools: tools.defs,
        ...(toolChoice ? { toolChoice } : {}),
        signal,
      })) {
        if (ev.type === "text-delta") {
          text += ev.text;
          emit({ type: "text", text: ev.text });
        } else if (ev.type === "tool-call") {
          toolCalls.push(ev.call);
          emit({ type: "tool-call", id: ev.call.id, name: ev.call.name, args: ev.call.arguments });
        } else if (ev.type === "usage") {
          emit({ type: "usage", inputTokens: ev.usage.inputTokens, outputTokens: ev.usage.outputTokens });
        } else if (ev.type === "error") {
          text += `\n[provider error] ${ev.error}`;
          emit({ type: "text", text: `\n[provider error] ${ev.error}` });
        }
      }
    } catch (e) {
      emit({ type: "text", text: `\n[error] ${e instanceof Error ? e.message : String(e)}` });
      emit({ type: "status", finish: "error", steps });
      return { finish: "error", steps, messages };
    }

    messages.push({ role: "assistant", content: text, ...(toolCalls.length > 0 ? { toolCalls } : {}) });

    if (toolCalls.length === 0) {
      emit({ type: "status", finish: "answer", steps });
      return { finish: "answer", steps, messages };
    }

    let calledFinal = false;
    for (const call of toolCalls) {
      if (call.name === finalTool) calledFinal = true;
      const handler = tools.handlers[call.name];
      let result: string;
      let isError: boolean;
      if (!handler) {
        result = `No such tool: ${call.name}`;
        isError = true;
      } else {
        try {
          const r = await handler(call.arguments);
          result = r.result;
          isError = r.isError ?? false;
        } catch (e) {
          result = e instanceof Error ? e.message : String(e);
          isError = true;
        }
      }
      emit({ type: "tool-result", id: call.id, name: call.name, result, isError });
      messages.push({ role: "tool", toolCallId: call.id, content: result });
    }

    if (calledFinal) {
      emit({ type: "status", finish: "answer", steps });
      return { finish: "answer", steps, messages };
    }
  }

  emit({ type: "status", finish: "cap", steps });
  return { finish: "cap", steps, messages };
}
