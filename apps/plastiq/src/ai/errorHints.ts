// AI/service UX — translate raw provider/service failures into actionable messages
// and pre-check self-hosted services before submitting long jobs.
//
// Provider errors reach the GenerationPanel as raw strings (a browser "Failed to fetch"
// when Ollama isn't running, an SDK "401 …" on a bad key, …) via the agent loop's
// `{type:"error"}` relay (agentRunner.ts) or a thrown Error. `translateProviderError`
// maps the common failure classes to a friendly, actionable line — the raw message is
// kept alongside so the UI can show it collapsed/secondary. `checkServiceHealth` is the
// pre-flight GET /health (short timeout) for the reconstruction (SPEC-6 R6.6) and NeRF
// (SPEC-11 N11) services, both of which expose /health; it gates job submission so a
// down service fails in ~3 s with a "start it with …" hint instead of a raw fetch error.

import { MODEL_CATALOG } from "./providers/models.js";
import type { AiSettings } from "./settings.js";

/** Where the configured chat provider lives — for "can't reach X at Y" wording. */
export interface ProviderEndpoint {
  /** Human label, e.g. "Ollama (local, no key)" or a custom provider key. */
  label: string;
  /** The base URL requests actually go to. */
  baseURL: string;
}

/** Resolve the configured provider's label + effective base URL. Mirrors the base-URL
 * fallback in providers/registry.ts (settings override → catalog default → Ollama
 * default; the Anthropic SDK's own default endpoint for the anthropic adapter). */
export function providerEndpoint(settings: AiSettings): ProviderEndpoint {
  const entry = MODEL_CATALOG[settings.providerKey];
  const label = entry?.label ?? settings.providerKey;
  const baseURL =
    settings.baseURL ??
    entry?.defaultBaseURL ??
    (settings.providerId === "anthropic" ? "https://api.anthropic.com" : "http://localhost:11434/v1");
  return { label, baseURL };
}

/** A translated failure: the actionable line to show, plus the raw message to keep
 * available (collapsed/secondary) so nothing is hidden from a debugging user. */
export interface ErrorHint {
  friendly: string;
  raw: string;
}

const CONNECTION_RE =
  /failed to fetch|fetch failed|connection error|connection refused|econnrefused|networkerror|load failed|err_connection|socket hang up/i;
const AUTH_RE = /\b401\b|\b403\b|unauthorized|forbidden|invalid[^.]*api.?key|authentication[_ ]error|permission[_ ]error/i;
const RATE_RE = /\b429\b|rate.?limit|too many requests|quota|overloaded[_ ]error/i;
const TIMEOUT_RE = /timed?.?out|etimedout|deadline exceeded/i;

/** True when the endpoint is a local Ollama (the default local provider) — it gets a
 * concrete "how to start it" hint instead of the generic one. */
function isLocalOllama(baseURL: string): boolean {
  return /(localhost|127\.0\.0\.1):11434/.test(baseURL);
}

/** Map a raw provider failure to an actionable message, or null when the failure isn't
 * one of the common classes (the caller shows the raw message as before). */
export function translateProviderError(raw: string, endpoint: ProviderEndpoint): ErrorHint | null {
  if (CONNECTION_RE.test(raw)) {
    const ollamaHint = isLocalOllama(endpoint.baseURL)
      ? " Start Ollama with `ollama serve`, then pull the model (e.g. `ollama pull qwen2.5`)."
      : "";
    return {
      friendly: `Can't reach ${endpoint.label} at ${endpoint.baseURL} — is it running?${ollamaHint}`,
      raw,
    };
  }
  if (AUTH_RE.test(raw)) {
    return {
      friendly: `${endpoint.label} rejected the request as unauthorized — check your API key in ⚙ Provider settings.`,
      raw,
    };
  }
  if (RATE_RE.test(raw)) {
    return {
      friendly: `${endpoint.label} is rate-limiting requests — wait a moment and retry (or check your plan/quota).`,
      raw,
    };
  }
  if (TIMEOUT_RE.test(raw)) {
    return {
      friendly: `The request to ${endpoint.label} timed out — the service may be busy. Retry, or check ${endpoint.baseURL}.`,
      raw,
    };
  }
  return null;
}

/** Client default of the mesh→B-rep reconstruction service (reconstruct.ts). */
export const RECONSTRUCT_DEFAULT_BASE_URL = "http://localhost:8000";
/** Client default of the NeRF photo-capture service (@plastiq/nerf). */
export const NERF_DEFAULT_BASE_URL = "http://localhost:8002";

/** GET `<baseURL>/health` with a short timeout. True iff the service answered 2xx.
 * Any failure (refused, DNS, timeout, non-2xx) is "unreachable" — the caller shows a
 * start hint instead of submitting the job. */
export async function checkServiceHealth(
  baseURL: string,
  opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<boolean> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 3000);
  try {
    const res = await fetchImpl(`${baseURL.replace(/\/+$/, "")}/health`, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** The "service unreachable" line for a section's error slot, with the documented dev
 * start command (services/<name>/README). */
export function serviceUnreachableMessage(service: "reconstruct" | "nerf", baseURL: string): string {
  const [what, env, port] =
    service === "reconstruct"
      ? ["Reconstruction service", "plastiq-reconstruct", "8000"]
      : ["NeRF capture service", "plastiq-nerf", "8002"];
  return `${what} unreachable at ${baseURL} — start it with: mamba run -n ${env} uvicorn app.main:app --port ${port} (in services/${service}).`;
}
