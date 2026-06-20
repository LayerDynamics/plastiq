// SPEC-6 R1.2 (T1.2): the OpenAI-compatible adapter's PURE logic — request mapping
// and streamed tool-call assembly — tested without network. The live round-trip is
// covered by openaiCompatible.integration.test.ts against a real local Ollama.

import { describe, it, expect } from "vitest";
import {
  toOpenAIMessages,
  toOpenAITools,
  initStreamState,
  reduceChunk,
  finalizeStream,
  type MinimalChunk,
} from "./openaiCompatible.js";
import type { ChatMessage, StreamEvent } from "./types.js";

describe("R1.2 request mapping", () => {
  it("prepends the system prompt and maps a plain user turn", () => {
    const out = toOpenAIMessages("be terse", [{ role: "user", content: "hi" }]);
    expect(out[0]).toEqual({ role: "system", content: "be terse" });
    expect(out[1]).toEqual({ role: "user", content: "hi" });
  });

  it("maps an image content part to an image_url data URL", () => {
    const msgs: ChatMessage[] = [
      { role: "user", content: [
        { type: "text", text: "what is this?" },
        { type: "image", mediaType: "image/png", data: "AAAA" },
      ] },
    ];
    const out = toOpenAIMessages("", msgs);
    const content = (out[1] as { content: unknown[] }).content;
    expect(content[0]).toEqual({ type: "text", text: "what is this?" });
    expect(content[1]).toEqual({ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } });
  });

  it("maps an assistant tool-call turn and a tool result turn", () => {
    const msgs: ChatMessage[] = [
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "build_part", arguments: { a: 1 } }] },
      { role: "tool", content: "ok", toolCallId: "c1" },
    ];
    const out = toOpenAIMessages("", msgs);
    const asst = out[1] as { role: string; tool_calls: { id: string; type: string; function: { name: string; arguments: string } }[] };
    expect(asst.role).toBe("assistant");
    expect(asst.tool_calls[0]).toEqual({ id: "c1", type: "function", function: { name: "build_part", arguments: JSON.stringify({ a: 1 }) } });
    const tool = out[2] as { role: string; tool_call_id: string; content: string };
    expect(tool).toEqual({ role: "tool", tool_call_id: "c1", content: "ok" });
  });

  it("maps a ToolDef to an OpenAI function tool", () => {
    const tools = toOpenAITools([{ name: "f", description: "d", parameters: { type: "object" } }]);
    expect(tools[0]).toEqual({ type: "function", function: { name: "f", description: "d", parameters: { type: "object" } } });
  });
});

describe("R1.2 streamed tool-call assembly", () => {
  it("assembles text deltas, a fragmented tool call, usage and finish", () => {
    const chunks: MinimalChunk[] = [
      { choices: [{ delta: { content: "Done" } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "build_part", arguments: '{"x":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "42}" } }] } }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 30, completion_tokens: 7 } },
    ];
    const state = initStreamState();
    const events: StreamEvent[] = [];
    for (const c of chunks) events.push(...reduceChunk(state, c));
    events.push(...finalizeStream(state));

    expect(events).toContainEqual({ type: "text-delta", text: "Done" });
    expect(events).toContainEqual({ type: "usage", usage: { inputTokens: 30, outputTokens: 7 } });
    const toolCall = events.find((e) => e.type === "tool-call");
    expect(toolCall).toEqual({ type: "tool-call", call: { id: "call_1", name: "build_part", arguments: { x: 42 } } });
    expect(events.at(-1)).toEqual({ type: "done", finishReason: "tool-calls" });
  });

  it("surfaces an error event for unparseable tool arguments", () => {
    const chunks: MinimalChunk[] = [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "c", function: { name: "f", arguments: "not json" } }] }, finish_reason: "tool_calls" }] },
    ];
    const state = initStreamState();
    const events: StreamEvent[] = [];
    for (const c of chunks) events.push(...reduceChunk(state, c));
    events.push(...finalizeStream(state));
    expect(events.some((e) => e.type === "error")).toBe(true);
  });

  it("maps a plain stop finish reason", () => {
    const state = initStreamState();
    const events = [
      ...reduceChunk(state, { choices: [{ delta: { content: "hello" }, finish_reason: "stop" }] }),
      ...finalizeStream(state),
    ];
    expect(events.at(-1)).toEqual({ type: "done", finishReason: "stop" });
  });
});
