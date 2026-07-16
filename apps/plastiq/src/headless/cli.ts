// SPEC-6 R2 — `plastiq-gen`: headless CLI that turns one benchmark fixture into an
// `output.step`. It is a thin shell over generatePart(): parse flags, read the
// description / drawing / seed STEP, construct the OpenAI-compatible provider (a
// local mlx-lm / mlx-vlm / llama.cpp server, or any compatible endpoint), generate,
// and write the STEP. The Python harness (benchmark/harness) parses each fixture's
// description.yaml and invokes this per sample.
//
// Excluded from coverage (vitest.config.ts): pure argv + filesystem IO. The logic it
// drives (nodeBuild.ts, generate.ts) is covered by generate.test.ts.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, dirname, extname } from "node:path";
import { OpenAICompatAdapter } from "../ai/providers/openaiCompatible.js";
import type { ChatProvider, ContentPart } from "../ai/providers/types.js";
import { generatePart } from "./generate.js";
import { seedFromStep } from "./nodeBuild.js";

interface Args {
  desc: string;
  images: string[];
  inputStep?: string;
  edit?: string;
  baseUrl: string;
  model: string;
  apiKey?: string;
  vision: boolean;
  captionBaseUrl?: string;
  captionModel?: string;
  captionApiKey?: string;
  maxSteps?: number;
  firstTool?: string;
  out: string;
  json: boolean;
}

const USAGE = `plastiq-gen — headless parametric generation -> STEP

Required:
  --model <name>            model id served by the endpoint
  --desc <text> | --desc-file <path>   the task prompt

Inputs:
  --image <path>            drawing image (repeatable; generation tasks)
  --input-step <path>       starting solid (editing tasks) — seeded as importStep
  --edit <text> | --edit-file <path>   the edit instruction (editing tasks)

Vision (two-stage: caption the drawing, then generate). Use this when the tool
model isn't vision-capable (the usual local case):
  --caption-base-url <url>  a vision endpoint (e.g. a llama.cpp VLM with --mmproj)
  --caption-model <name>    the vision model id
  --caption-api-key <key>   optional

Endpoint (OpenAI-compatible, e.g. mlx_lm.server / mlx-vlm / llama-server):
  --base-url <url>          default http://localhost:8080/v1
  --api-key <key>           default $OPENAI_API_KEY, else a local placeholder
  --vision                  the model accepts images (enables --image content)

Run:
  --max-steps <n>           agent turn cap
  --first-tool <name>       force this tool on turn 1 (e.g. build_part) for weak models
  -o, --out <path>          output STEP (default ./output.step)
  --json                    print a JSON result summary to stdout
`;

function parseArgs(argv: string[]): Args {
  const a: Args = {
    desc: "",
    images: [],
    baseUrl: "http://localhost:8080/v1",
    model: "",
    vision: false,
    out: "output.step",
    json: false,
  };
  const next = (i: number): string => {
    const v = argv[i + 1];
    if (v === undefined) throw new Error(`flag ${argv[i]} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i];
    switch (f) {
      case "--": break; // end-of-options separator (e.g. pnpm forwards it); skip
      case "--desc": a.desc = next(i); i++; break;
      case "--desc-file": a.desc = readFileSync(next(i), "utf8"); i++; break;
      case "--image": a.images.push(next(i)); i++; break;
      case "--input-step": a.inputStep = next(i); i++; break;
      case "--edit": a.edit = next(i); i++; break;
      case "--edit-file": a.edit = readFileSync(next(i), "utf8"); i++; break;
      case "--base-url": a.baseUrl = next(i); i++; break;
      case "--model": a.model = next(i); i++; break;
      case "--api-key": a.apiKey = next(i); i++; break;
      case "--vision": a.vision = true; break;
      case "--caption-base-url": a.captionBaseUrl = next(i); i++; break;
      case "--caption-model": a.captionModel = next(i); i++; break;
      case "--caption-api-key": a.captionApiKey = next(i); i++; break;
      case "--max-steps": {
        const n = Number(next(i)); i++;
        if (!Number.isInteger(n) || n <= 0) throw new Error(`--max-steps must be a positive integer, got ${argv[i]}`);
        a.maxSteps = n;
        break;
      }
      case "--first-tool": a.firstTool = next(i); i++; break;
      case "-o":
      case "--out": a.out = next(i); i++; break;
      case "--json": a.json = true; break;
      case "-h":
      case "--help": process.stdout.write(USAGE); process.exit(0); break;
      default: throw new Error(`unknown flag: ${f}`);
    }
  }
  if (!a.model) throw new Error("--model is required");
  if (!a.desc.trim()) throw new Error("--desc or --desc-file is required");
  return a;
}

const MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

function imagePart(path: string): ContentPart {
  const ext = extname(path).toLowerCase();
  const mediaType = MEDIA_TYPES[ext];
  if (!mediaType) throw new Error(`unsupported image type for ${path} (${ext})`);
  return { type: "image", mediaType, data: readFileSync(path).toString("base64") };
}

function buildInput(a: Args): string | ContentPart[] {
  // The prompt: the task description plus, for an editing task, the edit instruction.
  let text = a.desc.trim();
  if (a.edit?.trim()) text += `\n\nRequested change: ${a.edit.trim()}`;

  // Generation drawings ride as vision content parts when the tool model is vision
  // capable (--vision) OR a separate captioner is configured (--caption-base-url),
  // which captions them to text first (the two-stage pipeline). Otherwise drop them
  // with a note — the run proceeds text-only (an honest, lower-fidelity result).
  if (a.images.length > 0) {
    if (!a.vision && !a.captionBaseUrl) {
      process.stderr.write(
        `warning: ${a.images.length} image(s) ignored — pass --vision or --caption-base-url\n`,
      );
      return text;
    }
    return [{ type: "text", text }, ...a.images.map(imagePart)];
  }
  return text;
}

function buildProvider(a: Args): ChatProvider {
  return new OpenAICompatAdapter({
    baseURL: a.baseUrl,
    model: a.model,
    supportsVision: a.vision,
    ...(a.apiKey ? { apiKey: a.apiKey } : process.env["OPENAI_API_KEY"] ? { apiKey: process.env["OPENAI_API_KEY"] } : {}),
  });
}

/** The vision captioner (stage 1) — a separate OpenAI-compatible endpoint (e.g. a
 * llama.cpp VLM with --mmproj). Returns undefined when not configured. */
function buildCaptionProvider(a: Args): ChatProvider | undefined {
  if (!a.captionBaseUrl || !a.captionModel) return undefined;
  return new OpenAICompatAdapter({
    baseURL: a.captionBaseUrl,
    model: a.captionModel,
    supportsVision: true,
    ...(a.captionApiKey ? { apiKey: a.captionApiKey } : {}),
  });
}

async function main(argv: string[]): Promise<number> {
  const a = parseArgs(argv);
  const seed = a.inputStep ? seedFromStep(readFileSync(a.inputStep, "utf8")) : undefined;
  const captionProvider = buildCaptionProvider(a);

  const result = await generatePart({
    provider: buildProvider(a),
    input: buildInput(a),
    ...(captionProvider ? { captionProvider } : {}),
    ...(seed ? { seed } : {}),
    ...(a.maxSteps != null ? { maxSteps: a.maxSteps } : {}),
    ...(a.firstTool ? { firstTool: a.firstTool } : {}),
  });

  const summary = {
    out: a.out,
    finish: result.finish,
    steps: result.steps,
    features: result.doc.features.length,
    hasGeometry: result.hasGeometry,
    applied: result.applied,
    captioned: result.caption != null,
  };

  if (result.step) {
    mkdirSync(dirname(a.out) || ".", { recursive: true });
    writeFileSync(a.out, result.step, "utf8");
  }

  if (a.json) {
    process.stdout.write(JSON.stringify(summary) + "\n");
  } else if (result.step) {
    process.stdout.write(`wrote ${a.out} (${summary.features} features, finish=${summary.finish})\n`);
  } else {
    process.stderr.write(`no geometry produced (finish=${summary.finish}); nothing written to ${basename(a.out)}\n`);
  }

  // Exit 2 == "missing" for the harness: the agent produced no buildable solid.
  return result.step ? 0 : 2;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`plastiq-gen: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
