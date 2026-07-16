// SPEC-6 R2.4 — the generation orchestrator: prompt assembly + conversation threading +
// the agent loop, driven by a FAKE provider (no model). The provider records the system
// prompt + messages it was handed so we can assert the wiring.

import { describe, expect, it } from "vitest";
import { buildSystemPrompt, offersCreateMesh, runGeneration } from "./runGeneration.js";
import type { AgentTools } from "./agentRunner.js";
import type { ChatMessage, ChatProvider, StreamEvent } from "./providers/types.js";
import type { CadDocument } from "../store/types.js";

const noTools: AgentTools = { defs: [], handlers: {} };

interface Seen {
  system: string | null;
  /** A SNAPSHOT of the messages at stream time (runAgent mutates the live array after). */
  messages: ChatMessage[] | null;
}

/** A provider that snapshots the request and answers with one text turn (no tools), so
 * runAgent finishes immediately with finish="answer". */
function recordingProvider(): { provider: ChatProvider; seen: Seen } {
  const seen: Seen = { system: null, messages: null };
  const provider: ChatProvider = {
    id: "anthropic",
    model: "fake",
    supportsVision: true,
    supportsTools: true,
    async *stream(req): AsyncIterable<StreamEvent> {
      seen.system = req.system;
      seen.messages = req.messages.map((m) => ({ ...m }));
      yield { type: "text-delta", text: "ok" };
      yield { type: "done", finishReason: "stop" };
    },
  };
  return { provider, seen };
}

const cube: CadDocument = {
  features: [{ id: "f1", type: "box", params: { dx: 0.02, dy: 0.02, dz: 0.02 } }],
  params: {},
};

describe("buildSystemPrompt (SPEC-6 R2.4)", () => {
  it("always includes the parametric prompt and states mm/deg", () => {
    const sys = buildSystemPrompt(null, false);
    expect(sys).toMatch(/build_part/);
    expect(sys).toMatch(/mm|millimet/i);
  });

  it("appends the current document as edit context when a part is open (FR-6a)", () => {
    const sys = buildSystemPrompt(cube, false);
    expect(sys).toMatch(/current feature document/i);
    expect(sys).toMatch(/build_part with the WHOLE updated document/i);
  });

  it("omits edit context for an empty document (create from scratch)", () => {
    expect(buildSystemPrompt({ features: [], params: {} }, false)).not.toMatch(/current feature document/i);
  });

  it("adds the creative guidance only in creative mode", () => {
    expect(buildSystemPrompt(null, true).length).toBeGreaterThan(buildSystemPrompt(null, false).length);
  });
});

describe("runGeneration (SPEC-6 R2.4)", () => {
  it("threads history + the new user input and runs to an answer", async () => {
    const { provider, seen } = recordingProvider();
    const res = await runGeneration({
      provider,
      input: "make a 20mm cube",
      history: [
        { role: "user", content: "earlier prompt" },
        { role: "assistant", content: "earlier answer" },
      ],
      currentDoc: null,
      tools: noTools,
    });
    expect(res.finish).toBe("answer");
    // history is preserved, the new prompt is appended last
    expect(seen.messages).toHaveLength(3);
    expect(seen.messages![2]).toEqual({ role: "user", content: "make a 20mm cube" });
    // and the assembled system prompt reached the provider
    expect(seen.system).toMatch(/build_part/);
  });

  it("passes vision content parts straight through as the user message", async () => {
    const { provider, seen } = recordingProvider();
    const content = [
      { type: "text" as const, text: "match this bracket" },
      { type: "image" as const, mediaType: "image/png", data: "aW1n" },
    ];
    await runGeneration({ provider, input: content, tools: noTools });
    expect(seen.messages![0]).toEqual({ role: "user", content });
  });
});

describe("creative guidance tracks the tool surface (finding 6-M2)", () => {
  /** Tools that offer the creative path — as buildTurnTools always wires it in the app. */
  const creativeTools: AgentTools = {
    defs: [{ name: "create_mesh", description: "3D gen", parameters: { type: "object" } }],
    handlers: {},
  };

  it("offersCreateMesh reads the offered defs", () => {
    expect(offersCreateMesh(creativeTools)).toBe(true);
    expect(offersCreateMesh(noTools)).toBe(false);
  });

  it("ships the creative guidance when create_mesh is offered — no flag needed", async () => {
    const { provider, seen } = recordingProvider();
    await runGeneration({ provider, input: "a clay vase", tools: creativeTools });
    expect(seen.system).toContain("create_mesh");
  });

  it("omits the creative guidance when create_mesh is not offered (headless parametric-only tools)", async () => {
    const { provider, seen } = recordingProvider();
    await runGeneration({ provider, input: "a cube", tools: noTools });
    expect(seen.system).not.toContain("create_mesh");
  });

  it("an explicit `creative` override wins (the CADGenBench harness pins false)", async () => {
    const { provider, seen } = recordingProvider();
    await runGeneration({ provider, input: "a clay vase", tools: creativeTools, creative: false });
    expect(seen.system).not.toContain("create_mesh");
  });
});
