// AI/service UX — errorHints unit tests: every raw→friendly translation mapping
// (connection / auth / rate-limit / timeout / unknown), the local-Ollama CORS
// disambiguation (opaque browser failures get the OLLAMA_ORIGINS half, definitive
// connection-refused signatures don't — SPEC-6 FR-3), the provider-endpoint
// resolution the messages name, and the GET /health pre-check (ok, non-2xx,
// refused, timeout) over an injected fake fetch.

import { describe, expect, it, vi } from "vitest";
import {
  checkServiceHealth,
  providerEndpoint,
  serviceUnreachableMessage,
  translateProviderError,
  NERF_DEFAULT_BASE_URL,
  RECONSTRUCT_DEFAULT_BASE_URL,
  type ProviderEndpoint,
} from "./errorHints.js";
import type { AiSettings } from "./settings.js";

const ollamaSettings: AiSettings = {
  providerKey: "ollama",
  providerId: "openai-compatible",
  model: "qwen2.5",
  apiKeys: {},
};

const ollamaEndpoint: ProviderEndpoint = { label: "Ollama (local, no key)", baseURL: "http://localhost:11434/v1" };
const hostedEndpoint: ProviderEndpoint = { label: "Anthropic (Claude)", baseURL: "https://api.anthropic.com" };

describe("providerEndpoint", () => {
  it("resolves the catalog label + default base URL (Ollama preset)", () => {
    expect(providerEndpoint(ollamaSettings)).toEqual(ollamaEndpoint);
  });

  it("a settings baseURL override wins over the catalog default", () => {
    const ep = providerEndpoint({ ...ollamaSettings, baseURL: "http://gpu-box:11434/v1" });
    expect(ep.baseURL).toBe("http://gpu-box:11434/v1");
  });

  it("the anthropic adapter (no catalog baseURL) reports the SDK default endpoint", () => {
    const ep = providerEndpoint({ providerKey: "anthropic", providerId: "anthropic", model: "claude-opus-4-8", apiKeys: {} });
    expect(ep).toEqual(hostedEndpoint);
  });

  it("an unknown custom provider key falls back to the key as label + the Ollama default URL", () => {
    const ep = providerEndpoint({ providerKey: "my-proxy", providerId: "openai-compatible", model: "m", apiKeys: {} });
    expect(ep.label).toBe("my-proxy");
    expect(ep.baseURL).toBe("http://localhost:11434/v1");
  });
});

describe("translateProviderError — mappings", () => {
  it("browser fetch failure → can't-reach message with the Ollama start hint (localhost:11434)", () => {
    const hint = translateProviderError("TypeError: Failed to fetch", ollamaEndpoint);
    expect(hint).not.toBeNull();
    expect(hint?.friendly).toContain("Can't reach Ollama (local, no key) at http://localhost:11434/v1");
    expect(hint?.friendly).toContain("is it running?");
    expect(hint?.friendly).toContain("ollama serve");
    // The raw message stays available (rendered collapsed/secondary by the panel).
    expect(hint?.raw).toBe("TypeError: Failed to fetch");
  });

  it("opaque browser failures on localhost Ollama also carry the OLLAMA_ORIGINS CORS guidance (SPEC-6 FR-3)", () => {
    // These signatures look identical whether Ollama is down or up-but-CORS-blocked,
    // so the hint must honestly cover both possibilities.
    const opaque = [
      "TypeError: Failed to fetch", // Chrome
      "NetworkError when attempting to fetch resource.", // Firefox
      "Load failed", // Safari
      "Connection error.", // openai SDK wrapper around the browser fetch failure
    ];
    for (const raw of opaque) {
      const hint = translateProviderError(raw, ollamaEndpoint);
      expect(hint?.friendly, raw).toContain("ollama serve");
      expect(hint?.friendly, raw).toContain("If it IS already running, the browser was likely blocked by CORS");
      expect(hint?.friendly, raw).toContain("OLLAMA_ORIGINS='*'");
    }
  });

  it("a definitive connection-refused signature (nothing listening — never CORS) → start hint WITHOUT the CORS half", () => {
    const refused = [
      "Error: connect ECONNREFUSED 127.0.0.1:11434", // Node SDK
      "net::ERR_CONNECTION_REFUSED", // Chrome devtools-style
      "Connection refused",
    ];
    for (const raw of refused) {
      const hint = translateProviderError(raw, ollamaEndpoint);
      expect(hint?.friendly, raw).toContain("ollama serve");
      expect(hint?.friendly, raw).toContain("ollama pull");
      expect(hint?.friendly, raw).not.toContain("OLLAMA_ORIGINS");
    }
  });

  it("the OLLAMA_ORIGINS example names the page's own origin when running in a browser", () => {
    vi.stubGlobal("location", { origin: "http://localhost:5173" });
    try {
      const hint = translateProviderError("TypeError: Failed to fetch", ollamaEndpoint);
      expect(hint?.friendly).toContain("OLLAMA_ORIGINS='http://localhost:5173' ollama serve");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("…and falls back to an <app origin> placeholder outside a browser (no location global)", () => {
    const hint = translateProviderError("TypeError: Failed to fetch", ollamaEndpoint);
    expect(hint?.friendly).toContain("OLLAMA_ORIGINS='<app origin>' ollama serve");
  });

  it("SDK connection error on a non-Ollama endpoint → can't-reach WITHOUT the Ollama hint", () => {
    const hint = translateProviderError("Connection error.", hostedEndpoint);
    expect(hint?.friendly).toContain("Can't reach Anthropic (Claude) at https://api.anthropic.com");
    expect(hint?.friendly).not.toContain("ollama serve");
    expect(hint?.friendly).not.toContain("OLLAMA_ORIGINS");
  });

  it("fetch failure on a local llama-mlx endpoint (:11543) → the llama-mlx start + CORS hint", () => {
    const llamaMlxEndpoint: ProviderEndpoint = {
      label: "llama-mlx-server (local MLX)",
      baseURL: "http://127.0.0.1:11543/v1",
    };
    const hint = translateProviderError("TypeError: Failed to fetch", llamaMlxEndpoint);
    expect(hint?.friendly).toContain("Can't reach llama-mlx-server (local MLX) at http://127.0.0.1:11543/v1");
    expect(hint?.friendly).toContain("just serve");
    expect(hint?.friendly).toContain("CORS");
    expect(hint?.friendly).not.toContain("ollama serve");
    // llama-mlx keeps its own CORS note; OLLAMA_ORIGINS is Ollama-only.
    expect(hint?.friendly).not.toContain("OLLAMA_ORIGINS");
  });

  it("resolves the llama-mlx catalog label + default :11543/v1 endpoint", () => {
    const ep = providerEndpoint({
      providerKey: "llama-mlx",
      providerId: "llama-mlx",
      model: "mlx-community/Qwen2.5-3B-Instruct-4bit",
      apiKeys: {},
    });
    expect(ep.label).toBe("llama-mlx-server (local MLX)");
    expect(ep.baseURL).toBe("http://127.0.0.1:11543/v1");
  });

  it("401 → API-key guidance pointing at Provider settings", () => {
    const hint = translateProviderError("401 Incorrect API key provided", hostedEndpoint);
    expect(hint?.friendly).toContain("unauthorized");
    expect(hint?.friendly).toContain("Provider settings");
  });

  it("403 → the same key guidance", () => {
    const hint = translateProviderError("403 Forbidden", hostedEndpoint);
    expect(hint?.friendly).toContain("API key");
  });

  it("429 → rate-limit wording", () => {
    const hint = translateProviderError("429 Too Many Requests", hostedEndpoint);
    expect(hint?.friendly).toContain("rate-limiting");
  });

  it("'rate limit' text without a status code → rate-limit wording", () => {
    const hint = translateProviderError("Rate limit reached for requests", hostedEndpoint);
    expect(hint?.friendly).toContain("rate-limiting");
  });

  it("timeout → timeout wording naming the endpoint", () => {
    const hint = translateProviderError("Request timed out.", hostedEndpoint);
    expect(hint?.friendly).toContain("timed out");
    expect(hint?.friendly).toContain("https://api.anthropic.com");
  });

  it("an unrecognized failure translates to null (the caller shows the raw message)", () => {
    expect(translateProviderError("kaboom: flux capacitor melted", hostedEndpoint)).toBeNull();
  });
});

describe("serviceUnreachableMessage", () => {
  it("reconstruct: names the URL and the documented start command", () => {
    const msg = serviceUnreachableMessage("reconstruct", RECONSTRUCT_DEFAULT_BASE_URL);
    expect(msg).toContain("unreachable at http://localhost:8000");
    expect(msg).toContain("mamba run -n plastiq-reconstruct uvicorn app.main:app --port 8000");
    expect(msg).toContain("services/reconstruct");
  });

  it("nerf: names the URL and the documented start command", () => {
    const msg = serviceUnreachableMessage("nerf", NERF_DEFAULT_BASE_URL);
    expect(msg).toContain("unreachable at http://localhost:8002");
    expect(msg).toContain("mamba run -n plastiq-nerf uvicorn app.main:app --port 8002");
    expect(msg).toContain("services/nerf");
  });
});

describe("checkServiceHealth", () => {
  it("GETs <baseURL>/health (trailing slashes trimmed) and is true on 2xx", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      calls.push(String(url));
      return { ok: true } as Response;
    }) as unknown as typeof fetch;
    await expect(checkServiceHealth("http://localhost:8000///", { fetchImpl })).resolves.toBe(true);
    expect(calls).toEqual(["http://localhost:8000/health"]);
  });

  it("false on a non-2xx answer", async () => {
    const fetchImpl = (async () => ({ ok: false }) as Response) as unknown as typeof fetch;
    await expect(checkServiceHealth("http://localhost:8002", { fetchImpl })).resolves.toBe(false);
  });

  it("false when the connection is refused (fetch rejects)", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    await expect(checkServiceHealth("http://localhost:8000", { fetchImpl })).resolves.toBe(false);
  });

  it("false when the service hangs past the timeout (abort fires)", async () => {
    const fetchImpl = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      })) as unknown as typeof fetch;
    await expect(checkServiceHealth("http://localhost:8000", { fetchImpl, timeoutMs: 5 })).resolves.toBe(false);
  });

  it("uses the ~3s default timeout when none is given (spy on setTimeout)", async () => {
    const spy = vi.spyOn(globalThis, "setTimeout");
    const fetchImpl = (async () => ({ ok: true }) as Response) as unknown as typeof fetch;
    await checkServiceHealth("http://localhost:8000", { fetchImpl });
    expect(spy).toHaveBeenCalledWith(expect.any(Function), 3000);
    spy.mockRestore();
  });
});
