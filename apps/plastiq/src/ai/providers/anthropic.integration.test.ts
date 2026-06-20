// SPEC-6 R1.3 (T1.3): live, no-mock round-trip against the real Anthropic API — a
// model-in-the-loop test of the Anthropic adapter (incl. tool use). Gated: runs only
// when ANTHROPIC_API_KEY is set, so CI (which doesn't set it) stays deterministic and
// free. To run locally:
//   ANTHROPIC_API_KEY=sk-ant-... pnpm exec vitest run anthropic.integration.test.ts

import { describe, it, expect } from "vitest";
import { AnthropicAdapter } from "./anthropic.js";
import type { StreamEvent } from "./types.js";

const env =
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
const KEY = env.ANTHROPIC_API_KEY ?? "";
const MODEL = env.ANTHROPIC_MODEL ?? "claude-opus-4-8";

describe("R1.3 AnthropicAdapter — live (gated, keyed)", () => {
  it("streams a build_part tool call for a CAD prompt", async () => {
    if (!KEY) return; // skip cleanly without a key — CI lands here (not a mock).
    const adapter = new AnthropicAdapter({ apiKey: KEY, model: MODEL });
    const tools = [
      {
        name: "build_part",
        description: "Build a CAD part from a feature document. Call this for any modelling request.",
        parameters: {
          type: "object",
          properties: { summary: { type: "string", description: "what you are building" } },
          required: ["summary"],
          additionalProperties: false,
        },
      },
    ];
    const events: StreamEvent[] = [];
    for await (const ev of adapter.stream({
      system: "You are a CAD assistant. For any modelling request you MUST call build_part.",
      messages: [{ role: "user", content: "Make a 40 mm cube." }],
      tools,
    })) {
      events.push(ev);
    }
    expect(events.at(-1)?.type).toBe("done");
    const calledBuild = events.some((e) => e.type === "tool-call" && e.call.name === "build_part");
    expect(calledBuild).toBe(true);
  }, 60_000);
});
