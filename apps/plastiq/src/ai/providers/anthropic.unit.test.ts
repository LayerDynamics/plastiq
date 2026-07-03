// SPEC-6 R1.3 (T1.3): the Anthropic adapter's PURE logic — request mapping (incl.
// vision image blocks + tool round-trips) and streamed tool-call assembly — tested
// without network. The live round-trip is the gated anthropic.integration.test.ts.

import { describe, it, expect } from "vitest";
import type AnthropicSDK from "@anthropic-ai/sdk";
import {
  AnthropicAdapter,
  toAnthropicMessages,
  toAnthropicTools,
  toAnthropicToolChoice,
  initAnthropicState,
  reduceAnthropicEvent,
  finalizeAnthropic,
  type AnthropicStreamEvent,
} from "./anthropic.js";
import type { ChatMessage, StreamEvent, ToolDef } from "./types.js";

describe("R1.3 request mapping", () => {
  it("maps a ToolDef to an Anthropic tool with input_schema", () => {
    const tools = toAnthropicTools([{ name: "f", description: "d", parameters: { type: "object" } }]);
    expect(tools[0]).toEqual({ name: "f", description: "d", input_schema: { type: "object" } });
  });

  it("maps a plain user turn to a text block (system is carried separately)", () => {
    const out = toAnthropicMessages([{ role: "user", content: "hi" }]);
    expect(out).toEqual([{ role: "user", content: [{ type: "text", text: "hi" }] }]);
  });

  it("maps an image content part to an Anthropic base64 image block", () => {
    const msgs: ChatMessage[] = [
      { role: "user", content: [
        { type: "text", text: "what is this?" },
        { type: "image", mediaType: "image/png", data: "AAAA" },
      ] },
    ];
    const content = (toAnthropicMessages(msgs)[0] as { content: unknown[] }).content;
    expect(content[0]).toEqual({ type: "text", text: "what is this?" });
    expect(content[1]).toEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } });
  });

  it("maps every ToolChoice to Anthropic's tool_choice (firstTool reaches Claude)", () => {
    // undefined / "auto" omit the field (model decides); the rest force.
    expect(toAnthropicToolChoice(undefined)).toBeUndefined();
    expect(toAnthropicToolChoice("auto")).toBeUndefined();
    expect(toAnthropicToolChoice("required")).toEqual({ type: "any" });
    expect(toAnthropicToolChoice("none")).toEqual({ type: "none" });
    expect(toAnthropicToolChoice({ tool: "build_part" })).toEqual({ type: "tool", name: "build_part" });
  });

  it("maps an assistant tool-call turn and a tool result turn", () => {
    const msgs: ChatMessage[] = [
      { role: "assistant", content: "building", toolCalls: [{ id: "tu_1", name: "build_part", arguments: { a: 1 } }] },
      { role: "tool", content: "compiled", toolCallId: "tu_1" },
    ];
    const out = toAnthropicMessages(msgs);
    const asst = out[0] as { role: string; content: { type: string; id?: string; name?: string; input?: unknown }[] };
    expect(asst.role).toBe("assistant");
    expect(asst.content).toContainEqual({ type: "tool_use", id: "tu_1", name: "build_part", input: { a: 1 } });
    const toolMsg = out[1] as { role: string; content: { type: string; tool_use_id: string; content: string }[] };
    expect(toolMsg.role).toBe("user");
    expect(toolMsg.content[0]).toEqual({ type: "tool_result", tool_use_id: "tu_1", content: "compiled" });
  });
});

describe("R1.3 request building — tool_choice + thinking", () => {
  // A fake SDK client that records the params handed to messages.create and
  // returns an empty event stream, so we can assert what the adapter sent.
  function captureClient(): { calls: Record<string, unknown>[]; client: AnthropicSDK } {
    const calls: Record<string, unknown>[] = [];
    const client = {
      messages: {
        create: async (params: Record<string, unknown>) => {
          calls.push(params);
          return (async function* () {
            // no events — finalize still emits usage + done
          })();
        },
      },
    } as unknown as AnthropicSDK;
    return { calls, client };
  }

  async function drain(it: AsyncIterable<StreamEvent>): Promise<void> {
    for await (const _ev of it) void _ev;
  }

  const tools: ToolDef[] = [{ name: "build_part", description: "", parameters: { type: "object" } }];
  const msgs: ChatMessage[] = [{ role: "user", content: "go" }];

  it("forces the tool AND drops thinking (Anthropic 400s on thinking+forced tool)", async () => {
    const { calls, client } = captureClient();
    const a = new AnthropicAdapter({ apiKey: "x", model: "claude-x", thinking: true, client });
    await drain(a.stream({ system: "", messages: msgs, tools, toolChoice: { tool: "build_part" } }));
    expect(calls).toHaveLength(1);
    expect(calls[0]!["tool_choice"]).toEqual({ type: "tool", name: "build_part" });
    expect(calls[0]!["thinking"]).toBeUndefined();
    expect(calls[0]!["tools"]).toBeDefined();
  });

  it("keeps adaptive thinking and sends no tool_choice when the turn is unforced", async () => {
    const { calls, client } = captureClient();
    const a = new AnthropicAdapter({ apiKey: "x", model: "claude-x", thinking: true, client });
    await drain(a.stream({ system: "", messages: msgs, tools }));
    expect(calls[0]!["tool_choice"]).toBeUndefined();
    expect(calls[0]!["thinking"]).toEqual({ type: "adaptive" });
  });

  it("omits tool_choice when there are no tools (it would be invalid)", async () => {
    const { calls, client } = captureClient();
    const a = new AnthropicAdapter({ apiKey: "x", model: "claude-x", thinking: true, client });
    await drain(a.stream({ system: "", messages: msgs, tools: [], toolChoice: { tool: "build_part" } }));
    expect(calls[0]!["tool_choice"]).toBeUndefined();
    // no tools ⇒ nothing is forced ⇒ thinking is preserved
    expect(calls[0]!["thinking"]).toEqual({ type: "adaptive" });
  });
});

describe("R1.3 streamed tool-call assembly", () => {
  it("assembles a fragmented tool_use block, usage and finish", () => {
    const events: AnthropicStreamEvent[] = [
      { type: "message_start", message: { usage: { input_tokens: 30, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu_1", name: "build_part" } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"x":' } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "42}" } },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 7 } },
      { type: "message_stop" },
    ];
    const state = initAnthropicState();
    const out: StreamEvent[] = [];
    for (const ev of events) out.push(...reduceAnthropicEvent(state, ev));
    out.push(...finalizeAnthropic(state));

    expect(out).toContainEqual({ type: "tool-call", call: { id: "tu_1", name: "build_part", arguments: { x: 42 } } });
    expect(out).toContainEqual({ type: "usage", usage: { inputTokens: 30, outputTokens: 7 } });
    expect(out.at(-1)).toEqual({ type: "done", finishReason: "tool-calls" });
  });

  it("streams text deltas and maps end_turn to stop", () => {
    const events: AnthropicStreamEvent[] = [
      { type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
      { type: "message_stop" },
    ];
    const state = initAnthropicState();
    const out: StreamEvent[] = [];
    for (const ev of events) out.push(...reduceAnthropicEvent(state, ev));
    out.push(...finalizeAnthropic(state));
    expect(out).toContainEqual({ type: "text-delta", text: "hello" });
    expect(out.at(-1)).toEqual({ type: "done", finishReason: "stop" });
  });
});
