// SPEC-6 R2 — one-shot headless generation: description (+ optional drawing / seed
// STEP) -> a parametric CadDocument -> STEP text. This is the function the
// CADGenBench harness calls per fixture. It reuses the real agent orchestrator
// (runGeneration -> runAgent) and the real tool surface; only the geometry backend
// is the Node seam from nodeBuild.ts. Nothing about the agent is faked.

import { runGeneration } from "../ai/runGeneration.js";
import type { AgentEvent, AgentFinish } from "../ai/agentRunner.js";
import type { ChatProvider, ContentPart, ImagePart, TextPart } from "../ai/providers/types.js";
import type { CadDocument } from "../store/types.js";
import { createHeadlessSession } from "./nodeBuild.js";

/** Default perception prompt for the vision captioner (engineering drawings). */
export const DEFAULT_CAPTION_INSTRUCTION =
  "This is an engineering drawing of a mechanical part. Describe it precisely for a CAD " +
  "modeler: the overall bounding dimensions, the base solid shape, and every feature (holes, " +
  "slots, bosses, fillets, chamfers) with sizes and positions in millimetres. Be exact and " +
  "structured; do not invent features you cannot see.";

export interface GenerateOptions {
  provider: ChatProvider;
  /** The task prompt — plain text, or content parts (text + drawing image). */
  input: string | ContentPart[];
  /** Two-stage pipeline (CB6.2): a vision provider that captions the drawing to text
   * first, so the tool-calling `provider` (which need not be vision-capable) sees a
   * text description. When set and the input carries images, perception runs first. */
  captionProvider?: ChatProvider;
  /** Override the captioner's instruction (defaults to {@link DEFAULT_CAPTION_INSTRUCTION}). */
  captionInstruction?: string;
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

/**
 * Perception stage: caption image content parts to a text description via a vision
 * provider (no tools). This decouples *seeing the drawing* from *emitting build_part*
 * — local VLM servers don't support tool-calling, and tool-calling models aren't
 * vision-capable, so we run them in series.
 */
export async function captionImages(
  provider: ChatProvider,
  images: ImagePart[],
  instruction: string,
  signal?: AbortSignal,
): Promise<string> {
  const content: ContentPart[] = [{ type: "text", text: instruction }, ...images];
  let text = "";
  for await (const ev of provider.stream({
    system: "",
    messages: [{ role: "user", content }],
    tools: [],
    ...(signal ? { signal } : {}),
  })) {
    if (ev.type === "text-delta") text += ev.text;
  }
  return text.trim();
}

/** Replace image parts in the input with the captioner's text description, so the
 * tool-calling stage receives text only. Pass-through when there is no captioner or
 * no images. */
async function resolveInput(opts: GenerateOptions): Promise<{ input: string | ContentPart[]; caption?: string }> {
  if (!opts.captionProvider || !Array.isArray(opts.input)) return { input: opts.input };
  const images = opts.input.filter((p): p is ImagePart => p.type === "image");
  if (images.length === 0) return { input: opts.input };
  const caption = await captionImages(
    opts.captionProvider,
    images,
    opts.captionInstruction ?? DEFAULT_CAPTION_INSTRUCTION,
    opts.signal,
  );
  const text = opts.input
    .filter((p): p is TextPart => p.type === "text")
    .map((p) => p.text)
    .join("\n")
    .trim();
  return { input: `${text}\n\nThe engineering drawing shows:\n${caption}`.trim(), caption };
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
  /** The vision captioner's description, when the two-stage pipeline ran. */
  caption?: string;
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
  const { input, caption } = await resolveInput(opts); // perception stage (if configured)
  const session = await createHeadlessSession(opts.seed);
  const result = await runGeneration({
    provider: opts.provider,
    input,
    tools: session.tools,
    currentDoc: opts.seed ?? session.currentDoc(),
    creative: false,
    ...(opts.maxSteps != null ? { maxSteps: opts.maxSteps } : {}),
    ...(opts.firstTool ? { firstTool: opts.firstTool } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
  });

  const doc = session.currentDoc();
  // A candidate is produced ONLY when the model DELIBERATELY finished
  // (finish === "answer": it called answer_user or stopped with nothing left to do).
  // A "cap" (ran out of turns while still building), "error", or "cancelled" leaves
  // an UNCONFIRMED, possibly half-built intermediate in `current` — exporting that
  // would pass off placeholder geometry as a result. So fail loudly: step stays null
  // and the run is recorded as missing, never as a fake success.
  let step: string | null = null;
  if (result.finish === "answer") {
    try {
      step = session.toStep();
    } catch (e) {
      // "no geometry" is the honest empty case (hasGeometry:false). Any other
      // kernel/export error is a real failure and must surface, not be swallowed.
      if (e instanceof Error && /no geometry to export/.test(e.message)) {
        step = null;
      } else {
        throw e;
      }
    }
  }
  return {
    finish: result.finish,
    steps: result.steps,
    doc,
    hasGeometry: step !== null,
    applied: session.applied(),
    step,
    ...(caption ? { caption } : {}),
  };
}
