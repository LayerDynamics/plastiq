// CB2.3 — the headless generation chain produces a real STEP, with no model and no
// network. A scripted ChatProvider emits a build_part tool-call (a 10×20×30 box in
// mm) then the answer_user finalizer; we assert the agent drives the Node geometry
// seam to a valid, re-importable STEP solid. This is the CI proof that the
// extraction (browser agent -> Node) is wired correctly end-to-end.

import { describe, expect, it } from "vitest";
import { initOcct, importStep } from "@plastiq/cad";
import type {
  ChatProvider,
  ChatStreamRequest,
  StreamEvent,
} from "../ai/providers/types.js";
import { generatePart } from "./generate.js";
import { authorStep, seedFromStep, createHeadlessSession } from "./nodeBuild.js";
import type { CadDocument } from "../store/types.js";

/** A deterministic provider: turn 1 calls build_part with `doc`, turn 2 finalizes. */
function scriptedProvider(doc: unknown, finalMessage = "Built it."): ChatProvider {
  let turn = 0;
  return {
    id: "openai-compatible",
    model: "scripted",
    supportsVision: false,
    supportsTools: true,
    async *stream(_req: ChatStreamRequest): AsyncIterable<StreamEvent> {
      turn += 1;
      if (turn === 1) {
        yield { type: "tool-call", call: { id: "c1", name: "build_part", arguments: { document: doc } } };
        yield { type: "done", finishReason: "tool-calls" };
      } else {
        yield { type: "tool-call", call: { id: "c2", name: "answer_user", arguments: { message: finalMessage } } };
        yield { type: "done", finishReason: "tool-calls" };
      }
    },
  };
}

const BOX_DOC = {
  features: [{ id: "b1", type: "box", params: { dx: 10, dy: 20, dz: 30 } }],
  params: {},
};

describe("headless generatePart", () => {
  it("drives the agent to a valid, re-importable STEP solid", async () => {
    const result = await generatePart({
      provider: scriptedProvider(BOX_DOC),
      input: "Make a 10×20×30 mm box.",
      maxSteps: 4,
    });

    expect(result.finish).toBe("answer");
    expect(result.hasGeometry).toBe(true);
    expect(result.applied).toBe(true); // build_part applied
    expect(result.step).toBeTruthy();
    expect(result.step).toContain("ISO-10303"); // STEP file signature
    expect(result.doc.features.map((f) => f.type)).toContain("box");

    // Round-trip: the exported STEP re-imports to a real solid with the box's volume
    // (10mm·20mm·30mm = 6000 mm³ = 6e-6 m³), proving it is genuine B-rep, not text.
    const oc = await initOcct();
    const solid = importStep(oc, result.step!);
    try {
      expect(solid.volume()).toBeGreaterThan(0);
      expect(solid.volume()).toBeCloseTo(6e-6, 7);
    } finally {
      solid.delete();
    }
  });

  it("reports hasGeometry:false when the agent builds nothing", async () => {
    // A provider that only finalizes, never building — the honest 'missing' case.
    const provider: ChatProvider = {
      id: "openai-compatible",
      model: "scripted-empty",
      supportsVision: false,
      supportsTools: true,
      async *stream(): AsyncIterable<StreamEvent> {
        yield { type: "tool-call", call: { id: "c1", name: "answer_user", arguments: { message: "nope" } } };
        yield { type: "done", finishReason: "tool-calls" };
      },
    };
    const result = await generatePart({ provider, input: "do nothing", maxSteps: 2 });
    expect(result.hasGeometry).toBe(false);
    expect(result.applied).toBe(false); // build_part never applied
    expect(result.step).toBeNull();
  });

  it("does NOT export an incomplete (capped) run's intermediate geometry — fails loud", async () => {
    // The model keeps building but never finishes (no answer_user) → hits the step
    // cap. A box WAS built and applied, but it's an unconfirmed intermediate, so the
    // result must be step:null (recorded as missing), not a placeholder candidate.
    const stuck: ChatProvider = {
      id: "openai-compatible",
      model: "scripted-stuck",
      supportsVision: false,
      supportsTools: true,
      async *stream(): AsyncIterable<StreamEvent> {
        yield { type: "tool-call", call: { id: "c", name: "build_part", arguments: { document: BOX_DOC } } };
        yield { type: "done", finishReason: "tool-calls" };
      },
    };
    const result = await generatePart({ provider: stuck, input: "make something", maxSteps: 3 });
    expect(result.finish).toBe("cap");                 // never finished
    expect(result.applied).toBe(true);                 // a box WAS built (intermediate)
    expect(result.doc.features.length).toBeGreaterThan(0);
    expect(result.step).toBeNull();                    // but NOT exported — fail loud
    expect(result.hasGeometry).toBe(false);
  });

  it("applied:false for a no-op edit (seed re-exported unchanged)", async () => {
    // A provider that only answers — for an editing seed, the input solid is still
    // exported (a valid candidate), but applied must be false so the no-op is visible.
    const provider: ChatProvider = {
      id: "openai-compatible",
      model: "scripted-noop",
      supportsVision: false,
      supportsTools: true,
      async *stream(): AsyncIterable<StreamEvent> {
        yield { type: "tool-call", call: { id: "c1", name: "answer_user", arguments: { message: "no change" } } };
        yield { type: "done", finishReason: "tool-calls" };
      },
    };
    const built = await generatePart({ provider: scriptedProvider(BOX_DOC), input: "box", maxSteps: 4 });
    const result = await generatePart({ provider, input: "remove the groove", seed: seedFromStep(built.step!), maxSteps: 2 });
    expect(result.applied).toBe(false);   // model changed nothing
    expect(result.hasGeometry).toBe(true); // but the seed solid is still a valid candidate
    expect(result.step).toContain("ISO-10303");
  });

  it("two-stage: captions an image, then generates from the resulting text", async () => {
    // The captioner sees the image and returns a text description; the (non-vision)
    // generator then builds from text. Verifies the perception->authoring handoff
    // with no network.
    const captionProvider: ChatProvider = {
      id: "openai-compatible",
      model: "vlm",
      supportsVision: true,
      supportsTools: false,
      async *stream(req): AsyncIterable<StreamEvent> {
        // the captioner must receive the image content part
        const content = req.messages[0]!.content;
        const sawImage = Array.isArray(content) && content.some((p) => p.type === "image");
        yield { type: "text-delta", text: sawImage ? "A 20x20x20 mm cube." : "(no image seen)" };
        yield { type: "done", finishReason: "stop" };
      },
    };
    // the generator asserts it received TEXT (the image was replaced by the caption)
    const genProvider: ChatProvider = {
      id: "openai-compatible",
      model: "gen",
      supportsVision: false,
      supportsTools: true,
      async *stream(req): AsyncIterable<StreamEvent> {
        const userText = req.messages.at(-1)!.content;
        expect(typeof userText).toBe("string");
        expect(String(userText)).toContain("cube"); // the caption was threaded in
        yield { type: "tool-call", call: { id: "c1", name: "build_part", arguments: { document: BOX_DOC } } };
        yield { type: "tool-call", call: { id: "c2", name: "answer_user", arguments: { message: "done" } } };
        yield { type: "done", finishReason: "tool-calls" };
      },
    };

    const result = await generatePart({
      provider: genProvider,
      captionProvider,
      input: [
        { type: "text", text: "Reproduce the part from the drawing." },
        { type: "image", mediaType: "image/png", data: "AAAA" },
      ],
      maxSteps: 4,
    });
    expect(result.caption).toContain("cube");
    expect(result.hasGeometry).toBe(true);
    expect(result.step).toContain("ISO-10303");
  });

  it("authorStep builds a plate-with-hole (box→sketch→cut) into a valid solid", async () => {
    // The self-GT authoring path (CB6.3): a kernel-only build, no agent/model.
    const plateWithHole: CadDocument = {
      features: [
        { id: "plate", type: "box", params: { dx: 0.06, dy: 0.04, dz: 0.008 } },
        { id: "sk", type: "sketch", data: { profile: { kind: "circle", center: [0.03, 0.02], radius: 0.005 } } },
        { id: "hole", type: "cut", params: { depth: 0.008 } },
      ],
      params: {},
    };
    const step = await authorStep(plateWithHole);
    expect(step).toContain("ISO-10303");

    const oc = await initOcct();
    const solid = importStep(oc, step);
    try {
      const fullBox = 0.06 * 0.04 * 0.008; // 1.92e-5 m³
      const hole = Math.PI * 0.005 ** 2 * 0.008; // ~6.28e-7 m³
      expect(solid.volume()).toBeGreaterThan(0);
      expect(solid.volume()).toBeLessThan(fullBox); // the cut removed material
      expect(solid.volume()).toBeCloseTo(fullBox - hole, 7);
    } finally {
      solid.delete();
    }
  });

  it("seedFromStep yields an importStep document a session can export", async () => {
    // Build a box, export it, then seed a new session from that STEP (the editing
    // entry point) and confirm the seed round-trips to the same solid.
    const first = await createHeadlessSession();
    const built = await generatePart({ provider: scriptedProvider(BOX_DOC), input: "box", maxSteps: 4 });
    expect(built.step).toBeTruthy();

    const seeded = seedFromStep(built.step!);
    expect(seeded.features[0]!.type).toBe("importStep");

    const session = await createHeadlessSession(seeded);
    const step = session.toStep();
    expect(step).toContain("ISO-10303");
    void first;
  });
});
