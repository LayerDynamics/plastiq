// SPEC-6 R1.x (T1.x): the llama-mlx-server adapter. It reuses the OpenAI transport,
// so the streaming assembly is covered by openaiCompatible.unit.test.ts; here we
// verify the llama-mlx identity + defaults, that it forwards the request to the
// configured endpoint/model, and that it survives llama-mlx-server's whole-tool-call-
// per-chunk streaming (no incremental argument fragments) through the injected client.

import { describe, it, expect } from "vitest";
import type OpenAI from "openai";
import { LlamaMlxAdapter, LLAMA_MLX_DEFAULT_BASE_URL } from "./llama-mlx.js";
import type { ChatMessage, StreamEvent, ToolDef } from "./types.js";

/** A fake OpenAI client that records the create() params and streams back the given
 * chunks — the shape OpenAICompatAdapter consumes (client.chat.completions.create). */
function fakeClient(chunks: unknown[]): { calls: Record<string, unknown>[]; client: OpenAI } {
  const calls: Record<string, unknown>[] = [];
  const client = {
    chat: {
      completions: {
        create: async (params: Record<string, unknown>) => {
          calls.push(params);
          return (async function* () {
            for (const c of chunks) yield c;
          })();
        },
      },
    },
  } as unknown as OpenAI;
  return { calls, client };
}

async function collect(it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of it) out.push(ev);
  return out;
}

const tools: ToolDef[] = [{ name: "build_part", description: "", parameters: { type: "object" } }];
const msgs: ChatMessage[] = [{ role: "user", content: "make a bracket" }];

describe("R1.x llama-mlx identity + defaults", () => {
  it("reports the llama-mlx id, the model, and tool support", () => {
    const { client } = fakeClient([]);
    const a = new LlamaMlxAdapter({ model: "mlx-community/Qwen2.5-3B-Instruct-4bit", client });
    expect(a.id).toBe("llama-mlx");
    expect(a.model).toBe("mlx-community/Qwen2.5-3B-Instruct-4bit");
    expect(a.supportsTools).toBe(true);
    expect(a.supportsVision).toBe(false); // default; VLMs opt in per-model
  });

  it("reports vision when the configured model is a VLM", () => {
    const { client } = fakeClient([]);
    const a = new LlamaMlxAdapter({ model: "some-vlm", supportsVision: true, client });
    expect(a.supportsVision).toBe(true);
  });

  it("exposes the server's default :11543/v1 endpoint", () => {
    expect(LLAMA_MLX_DEFAULT_BASE_URL).toBe("http://127.0.0.1:11543/v1");
  });

  it("forwards the model, mapped messages and tools to the transport", async () => {
    const { calls, client } = fakeClient([]);
    const a = new LlamaMlxAdapter({ model: "qwen-mlx", client });
    await collect(a.stream({ system: "be terse", messages: msgs, tools }));
    expect(calls).toHaveLength(1);
    expect(calls[0]!["model"]).toBe("qwen-mlx");
    expect(calls[0]!["stream"]).toBe(true);
    expect(calls[0]!["tools"]).toBeDefined();
    const sent = calls[0]!["messages"] as { role: string; content: unknown }[];
    expect(sent[0]).toEqual({ role: "system", content: "be terse" });
    expect(sent[1]).toEqual({ role: "user", content: "make a bracket" });
  });
});

describe("R1.x llama-mlx streaming", () => {
  it("streams text + a WHOLE tool call arriving in a single chunk (the MLX quirk)", async () => {
    // llama-mlx-server emits one complete tool-call delta per call (id + name +
    // full arguments together), not the incremental fragments OpenAI streams.
    const chunks = [
      { choices: [{ delta: { content: "On it." } }] },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: "call_abc", type: "function", function: { name: "build_part", arguments: '{"w":20}' } },
              ],
            },
          },
        ],
      },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 40, completion_tokens: 9 } },
    ];
    const { client } = fakeClient(chunks);
    const a = new LlamaMlxAdapter({ model: "qwen-mlx", client });
    const events = await collect(a.stream({ system: "", messages: msgs, tools }));

    expect(events).toContainEqual({ type: "text-delta", text: "On it." });
    expect(events).toContainEqual({ type: "tool-call", call: { id: "call_abc", name: "build_part", arguments: { w: 20 } } });
    expect(events).toContainEqual({ type: "usage", usage: { inputTokens: 40, outputTokens: 9 } });
    expect(events.at(-1)).toEqual({ type: "done", finishReason: "tool-calls" });
  });

  it("surfaces a transport error as error + done", async () => {
    const client = {
      chat: { completions: { create: async () => { throw new Error("connection refused"); } } },
    } as unknown as OpenAI;
    const a = new LlamaMlxAdapter({ model: "qwen-mlx", client });
    const events = await collect(a.stream({ system: "", messages: msgs, tools: [] }));
    expect(events.some((e) => e.type === "error")).toBe(true);
    expect(events.at(-1)).toEqual({ type: "done", finishReason: "error" });
  });
});
