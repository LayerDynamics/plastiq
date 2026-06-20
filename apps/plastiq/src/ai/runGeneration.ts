// SPEC-6 R2.4 — the generation orchestrator: assemble the system prompt (parametric +
// edit context + optional creative guidance), thread the conversation, and run the agent
// loop. The GenerationPanel is a thin React shell over this; extracting it keeps the
// cockpit logic CI-testable with a fake provider (no model, no browser).

import { runAgent, type AgentEvent, type AgentTools, type RunAgentResult } from "./agentRunner.js";
import { parametricSystemPrompt, creativeSystemPrompt } from "./prompt.js";
import { editContext } from "./editContext.js";
import type { ChatMessage, ChatProvider, ContentPart } from "./providers/types.js";
import type { CadDocument } from "../store/types.js";

/** Build the system prompt: the parametric prompt, plus the current document as mm/deg
 * edit context (FR-6a) when a part is open, plus the creative-path guidance when the
 * 3D-gen tool is offered. */
export function buildSystemPrompt(currentDoc: CadDocument | null | undefined, creative: boolean): string {
  let system = parametricSystemPrompt();
  const ctx = editContext(currentDoc);
  if (ctx) system += `\n\n${ctx}`;
  if (creative) system += `\n\n${creativeSystemPrompt()}`;
  return system;
}

export interface RunGenerationOptions {
  provider: ChatProvider;
  /** The user's prompt — plain text, or content parts (text + image) for a vision turn. */
  input: string | ContentPart[];
  /** Prior conversation to continue (iterative edit); omitted for a fresh turn. */
  history?: ChatMessage[];
  /** Current document — drives edit-context injection (null/empty = create from scratch). */
  currentDoc?: CadDocument | null;
  /** The wired tools (from buildAgentTools). */
  tools: AgentTools;
  /** Offer the creative path (adds the create_mesh guidance + tool, already wired). */
  creative?: boolean;
  maxSteps?: number;
  signal?: AbortSignal;
  onEvent?: (e: AgentEvent) => void;
}

/** Run one generation turn: assemble the prompt + messages and drive the agent loop. */
export function runGeneration(opts: RunGenerationOptions): Promise<RunAgentResult> {
  const system = buildSystemPrompt(opts.currentDoc, opts.creative ?? false);
  const messages: ChatMessage[] = [...(opts.history ?? []), { role: "user", content: opts.input }];
  return runAgent({
    provider: opts.provider,
    system,
    messages,
    tools: opts.tools,
    ...(opts.maxSteps != null ? { maxSteps: opts.maxSteps } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
  });
}
