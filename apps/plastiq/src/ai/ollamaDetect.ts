// SPEC-6 §6.8 / R-10 — first-run local-Ollama detection (decision 17 / FR-5a).
//
// The first-run chooser's "Use local Ollama" must not blindly persist a fixed
// qwen2.5 @ localhost:11434 config that may point at nothing. This probes the running
// Ollama for the models it ACTUALLY has installed (GET /api/tags) with a short abortable
// timeout, so the chooser can either (a) let the user pick a model that exists — preferring
// tool-capable ones, since build_part needs tool calling — or (b) show an actionable
// "not detected" hint instead of silently saving a dead config.
//
// CORS caveat (SPEC-6 FR-3, mirrored from errorHints.ts): a *running* Ollama with no
// OLLAMA_ORIGINS set fails the browser fetch identically to a down one, so the not-detected
// hint covers BOTH cases — start it, or (if already up) restart it with OLLAMA_ORIGINS so
// the browser is allowed to read the response.

import { MODEL_CATALOG } from "./providers/models.js";

/** Default Ollama server root — the native API (/api/*) lives here; the OpenAI-compatible
 * surface the chat adapter uses is one level down at /v1. */
export const OLLAMA_DEFAULT_ROOT = "http://localhost:11434";
/** The /v1 base URL persisted into settings for the openai-compatible adapter. */
export const OLLAMA_DEFAULT_V1 = "http://localhost:11434/v1";

const DETECT_TIMEOUT_MS = 3000;

export interface OllamaModelChoice {
  /** The full installed model name (e.g. "qwen2.5:14b") — persisted verbatim as settings.model. */
  name: string;
  /** True when the model's family is a known tool-capable pick (a MODEL_CATALOG hint). build_part
   * needs tool calling, so these sort first and become the default selection. */
  toolCapable: boolean;
}

export interface OllamaDetectResult {
  /** True iff the server answered GET /api/tags with a 2xx. False means down OR CORS-blocked
   * (indistinguishable to a browser) OR timed out — the caller shows the dual start/CORS hint. */
  reachable: boolean;
  /** Installed models, tool-capable first. Empty when unreachable or none are installed. */
  models: OllamaModelChoice[];
}

export interface OllamaDetectOptions {
  /** Server root override; absent ⇒ OLLAMA_DEFAULT_ROOT. A trailing /v1 (or /) is stripped. */
  baseURL?: string;
  /** Hard cap on the probe round-trip; default 3000 ms. */
  timeoutMs?: number;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

/** A model's family = the name before its ":tag" (e.g. "qwen2.5:14b" → "qwen2.5"). */
function family(name: string): string {
  const i = name.indexOf(":");
  return (i >= 0 ? name.slice(0, i) : name).toLowerCase();
}

/** The known tool-capable Ollama model families, derived from the curated catalog. An installed
 * model whose family matches one of these is flagged tool-capable — the catalog hint the task
 * specifies (no per-model live probe on first run). */
function toolCapableFamilies(): Set<string> {
  const fams = new Set<string>();
  for (const m of MODEL_CATALOG["ollama"]?.models ?? []) fams.add(family(m.id));
  return fams;
}

/** Strip a trailing /v1 (and any trailing slashes) so we hit the native API root. */
function serverRoot(baseURL: string | undefined): string {
  return (baseURL?.trim() || OLLAMA_DEFAULT_ROOT).replace(/\/v1$/, "").replace(/\/+$/, "");
}

/** Probe a local Ollama for its installed models (GET <root>/api/tags), tool-capable first.
 * Never throws: unreachable / CORS-blocked / timed-out ⇒ { reachable: false, models: [] }. */
export async function detectOllama(opts: OllamaDetectOptions = {}): Promise<OllamaDetectResult> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const root = serverRoot(opts.baseURL);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DETECT_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${root}/api/tags`, { signal: controller.signal });
    if (!res.ok) return { reachable: false, models: [] };
    const data = (await res.json().catch(() => null)) as { models?: unknown } | null;
    const list = Array.isArray(data?.models) ? data.models : [];
    const fams = toolCapableFamilies();
    const models: OllamaModelChoice[] = list
      .map((m) => (m && typeof (m as { name?: unknown }).name === "string" ? (m as { name: string }).name : null))
      .filter((n): n is string => typeof n === "string" && n.length > 0)
      .map((name) => ({ name, toolCapable: fams.has(family(name)) }));
    // Tool-capable first (stable within each group), so the default pick can build_part.
    models.sort((a, b) => Number(b.toolCapable) - Number(a.toolCapable));
    return { reachable: true, models };
  } catch {
    return { reachable: false, models: [] };
  } finally {
    clearTimeout(timer);
  }
}

/** The app's own origin to name in the OLLAMA_ORIGINS example (a placeholder in Node/tests,
 * where there is no page origin). Mirrors errorHints.ts. */
function appOrigin(): string {
  return typeof location === "undefined" ? "<app origin>" : location.origin;
}

/** The actionable "not detected" line for the first-run chooser. Because a *running* Ollama
 * with no OLLAMA_ORIGINS set fails the browser fetch identically to a down one (SPEC-6 FR-3),
 * the hint covers both — mirrors errorHints.translateProviderError's local-Ollama guidance. */
export function ollamaNotDetectedMessage(baseURL?: string): string {
  const root = serverRoot(baseURL);
  return (
    `Ollama not detected at ${root} — start it with \`ollama serve\`, then pull a model ` +
    `(e.g. \`ollama pull qwen2.5\`). If it IS already running, the browser was likely blocked ` +
    `by CORS — restart it with \`OLLAMA_ORIGINS='${appOrigin()}' ollama serve\` ` +
    `(or \`OLLAMA_ORIGINS='*'\` for dev).`
  );
}
