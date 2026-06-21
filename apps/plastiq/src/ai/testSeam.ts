// SPEC-6 R2.6/R5.2 — the deterministic-pipeline test seam (FR — model-free E2E).
//
// Exposes globalThis.__plastiqAi so an E2E can drive the REAL agent tool handlers
// (build_part / inspect_geometry / create_mesh) WITHOUT a model — every layer below the
// LLM is exercised for real: the mm→SI validation, the off-thread OCCT build, the atomic
// loadDocument apply, the worker rebuild, and the render. Only the model is skipped. This
// is the model-free reconstruction-free baseline E2E; it is NOT the AI E2E (that needs a
// live model — see ai-ollama.spec.ts). The seam is inert in normal use, like __plastiqBuild
// and __aiStore — it just makes the tool surface callable from the page.

import { buildTurnTools } from "./agentTurn.js";
import { useAiStore } from "./aiStore.js";

/** What a tool handler returns to the agent loop (mirrors ToolHandler in agentRunner). */
export interface ToolResult {
  result: string;
  isError?: boolean;
}

/** A neutral settings stand-in when none is configured — create_mesh deps need a settings
 * object, but the deterministic seam only drives build_part/inspect, so the fal providers
 * it builds are never invoked. */
const NEUTRAL_SETTINGS = {
  providerKey: "ollama",
  providerId: "openai-compatible" as const,
  model: "none",
  apiKeys: {},
};

export interface PlastiqAiSeam {
  /** Run one agent tool by name against the live wiring (build seam + cad/projects stores)
   * — the exact handler the agent loop dispatches, minus the model. Returns the tool's
   * string result + isError, or a guard message when the geometry worker isn't ready. */
  runTool: (name: string, args: unknown) => Promise<ToolResult>;
}

export function installAiTestSeam(): void {
  const seam: PlastiqAiSeam = {
    runTool: async (name, args) => {
      const settings = useAiStore.getState().settings ?? NEUTRAL_SETTINGS;
      const tools = buildTurnTools({
        settings,
        confirm: async () => false, // deterministic seam never runs a paid job
        recordPaidJob: () => {},
      });
      if (!tools) return { result: "The geometry worker isn’t ready yet.", isError: true };
      const handler = tools.handlers[name];
      if (!handler) return { result: `No such tool: '${name}'.`, isError: true };
      return handler(args);
    },
  };
  (globalThis as { __plastiqAi?: PlastiqAiSeam }).__plastiqAi = seam;
}
