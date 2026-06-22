// SPEC-6 R2 — one-shot headless generation: description (+ optional drawing / seed
// STEP) -> a parametric CadDocument -> STEP text. This is the function the
// CADGenBench harness calls per fixture. It reuses the real agent orchestrator
// (runGeneration -> runAgent) and the real tool surface; only the geometry backend
// is the Node seam from nodeBuild.ts. Nothing about the agent is faked.

import { runGeneration } from "../ai/runGeneration.js";
import type { AgentEvent, AgentFinish } from "../ai/agentRunner.js";
import type { ChatProvider, ContentPart } from "../ai/providers/types.js";
import type { CadDocument } from "../store/types.js";
import { createHeadlessSession } from "./nodeBuild.js";

export interface GenerateOptions {
  provider: ChatProvider;
  /** The task prompt — plain text, or content parts (text + drawing image). */
  input: string | ContentPart[];
  /** Editing seed (an `importStep` document); omit/empty for generation. */
  seed?: CadDocument;
  /** Hard cap on agent turns (FR-18a). Defaults to runAgent's own default. */
  maxSteps?: number;
  /** Force this tool on the first turn (CB6.2), e.g. "build_part". */
  firstTool?: string;
  signal?: AbortSignal;
  /** Optional trace hook (tool calls, text, usage) for logging a run. */
  onEvent?: (e: AgentEvent) => void;
}

export interface GenerateResult {
  finish: AgentFinish;
  steps: number;
  /** The final applied document (empty features ⇒ the agent produced no geometry). */
  doc: CadDocument;
  /** True iff the final document rebuilds to a non-empty solid. */
  hasGeometry: boolean;
  /** True iff build_part applied at least once. For an editing seed, `false` means
   * a no-op edit (the input solid is re-exported unchanged) — a valid but
   * unmodified candidate, distinct from a real edit. */
  applied: boolean;
  /** STEP text for a benchmark `output.step`, or null when no geometry was built. */
  step: string | null;
}

/**
 * Run one generation/edit turn end-to-end and return the resulting STEP.
 *
 * The agent loop drives the provider, executes build_part against real OCCT, and
 * captures the last document that compiled. We then export that document to STEP.
 * A run where the model never produced buildable geometry returns `step: null` —
 * the harness records that fixture as `missing` (cad_score 0), which is the honest
 * outcome, not a fabricated solid.
 */
export async function generatePart(opts: GenerateOptions): Promise<GenerateResult> {
  const session = await createHeadlessSession(opts.seed);
  const result = await runGeneration({
    provider: opts.provider,
    input: opts.input,
    tools: session.tools,
    currentDoc: opts.seed ?? session.currentDoc(),
    creative: false,
    ...(opts.maxSteps != null ? { maxSteps: opts.maxSteps } : {}),
    ...(opts.firstTool ? { firstTool: opts.firstTool } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
  });

  const doc = session.currentDoc();
  let step: string | null;
  try {
    step = session.toStep();
  } catch (e) {
    // "no geometry" is the honest empty case (reported as hasGeometry:false). Any
    // other kernel/export error is a real failure and must surface, not be silently
    // recorded as missing — the CLI's top-level handler then exits non-zero.
    if (e instanceof Error && /no geometry to export/.test(e.message)) {
      step = null;
    } else {
      throw e;
    }
  }
  return {
    finish: result.finish,
    steps: result.steps,
    doc,
    hasGeometry: step !== null,
    applied: session.applied(),
    step,
  };
}
