// SPEC-6 R2.3 (T2.3): the agent loop — tool dispatch, error-feedback/retry bounded
// by the step cap, finalizer detection, and cancellation. Driven by a scripted fake
// ChatProvider (a hand-written test double of the R1 interface — this tests the loop,
// not a real model).

import { describe, it, expect, vi } from "vitest";
import { runAgent, type AgentEvent, type AgentTools } from "./agentRunner.js";
import type { ChatProvider, StreamEvent } from "./providers/types.js";

/** A ChatProvider that yields a scripted StreamEvent[] on each successive stream() call. */
class ScriptedProvider implements ChatProvider {
  readonly id = "openai-compatible" as const;
  readonly model = "fake";
  readonly supportsVision = false;
  readonly supportsTools = true;
  private i = 0;
  constructor(private readonly scripts: StreamEvent[][]) {}
  async *stream(): AsyncIterable<StreamEvent> {
    const script = this.scripts[Math.min(this.i, this.scripts.length - 1)] ?? [];
    this.i += 1;
    for (const ev of script) yield ev;
  }
}

const toolCall = (id: string, name: string, args: unknown): StreamEvent => ({ type: "tool-call", call: { id, name, arguments: args } });
const done = (): StreamEvent => ({ type: "done", finishReason: "tool-calls" });

describe("R2.3 agent loop", () => {
  it("dispatches tools, feeds an error back, retries, and finishes on the finalizer", async () => {
    const provider = new ScriptedProvider([
      [toolCall("c1", "build_part", { bad: true }), done()],
      [toolCall("c2", "build_part", { ok: true }), done()],
      [toolCall("c3", "answer_user", { message: "done" }), done()],
    ]);

    let buildCalls = 0;
    const tools: AgentTools = {
      defs: [
        { name: "build_part", description: "", parameters: { type: "object" } },
        { name: "answer_user", description: "", parameters: { type: "object" } },
      ],
      handlers: {
        build_part: async () => {
          buildCalls += 1;
          return buildCalls === 1
            ? { result: "feature 'f1' (extrude): no sketch profile upstream", isError: true }
            : { result: "Built the part (1 feature).", isError: false };
        },
        answer_user: async (a) => ({ result: String((a as { message?: string }).message ?? "") }),
      },
    };

    const events: AgentEvent[] = [];
    const res = await runAgent({
      provider,
      system: "s",
      messages: [{ role: "user", content: "make a cube" }],
      tools,
      onEvent: (e) => events.push(e),
    });

    expect(res.finish).toBe("answer");
    expect(res.steps).toBe(3);
    expect(buildCalls).toBe(2); // first errored, retried, then succeeded
    const results = events.filter((e): e is Extract<AgentEvent, { type: "tool-result" }> => e.type === "tool-result");
    expect(results[0]!.isError).toBe(true);
    expect(results.some((r) => r.name === "build_part" && !r.isError)).toBe(true);
    // The errored tool result is fed back into the conversation for self-correction.
    expect(res.messages.some((m) => m.role === "tool" && /no sketch profile/.test(String(m.content)))).toBe(true);
  });

  it("forces the configured tool on the first turn only (CB6.2)", async () => {
    const seenToolChoice: unknown[] = [];
    const scripts: StreamEvent[][] = [
      [toolCall("c1", "build_part", { ok: true }), done()],
      [toolCall("c2", "answer_user", { message: "done" }), done()],
    ];
    let i = 0;
    const provider: ChatProvider = {
      id: "openai-compatible",
      model: "fake",
      supportsVision: false,
      supportsTools: true,
      async *stream(req) {
        seenToolChoice.push(req.toolChoice);
        const script = scripts[Math.min(i, scripts.length - 1)] ?? [];
        i += 1;
        for (const ev of script) yield ev;
      },
    };
    const tools: AgentTools = {
      defs: [
        { name: "build_part", description: "", parameters: { type: "object" } },
        { name: "answer_user", description: "", parameters: { type: "object" } },
      ],
      handlers: {
        build_part: async () => ({ result: "Built the part (1 feature)." }),
        answer_user: async () => ({ result: "done" }),
      },
    };

    const res = await runAgent({
      provider,
      system: "s",
      messages: [{ role: "user", content: "make a box" }],
      tools,
      firstTool: "build_part",
    });

    expect(res.finish).toBe("answer");
    expect(seenToolChoice[0]).toEqual({ tool: "build_part" }); // turn 1 forced
    expect(seenToolChoice[1]).toBeUndefined(); // later turns auto
  });

  it("halts at the step cap when the model never finishes", async () => {
    const provider = new ScriptedProvider([[toolCall("c", "build_part", {}), done()]]); // same script forever
    const tools: AgentTools = {
      defs: [{ name: "build_part", description: "", parameters: { type: "object" } }],
      handlers: { build_part: async () => ({ result: "ok" }) },
    };
    const res = await runAgent({ provider, system: "s", messages: [{ role: "user", content: "x" }], tools, maxSteps: 3 });
    expect(res.finish).toBe("cap");
    expect(res.steps).toBe(3);
  });

  it("cancels at the next turn when the signal is aborted", async () => {
    const provider = new ScriptedProvider([[toolCall("c", "build_part", {}), done()]]);
    const handler = vi.fn(async () => ({ result: "ok" }));
    const tools: AgentTools = { defs: [{ name: "build_part", description: "", parameters: {} }], handlers: { build_part: handler } };
    const ctl = new AbortController();
    ctl.abort();
    const res = await runAgent({ provider, system: "s", messages: [{ role: "user", content: "x" }], tools, signal: ctl.signal });
    expect(res.finish).toBe("cancelled");
    expect(res.steps).toBe(0);
    expect(handler).not.toHaveBeenCalled();
  });

  it("finishes when the model answers with plain text (no tool calls)", async () => {
    const provider = new ScriptedProvider([[{ type: "text-delta", text: "hello" }, { type: "done", finishReason: "stop" }]]);
    const tools: AgentTools = { defs: [], handlers: {} };
    const res = await runAgent({ provider, system: "s", messages: [{ role: "user", content: "hi" }], tools });
    expect(res.finish).toBe("answer");
    expect(res.steps).toBe(1);
  });
});
