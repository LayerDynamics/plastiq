// AI/service UX — errorHints unit tests: every raw→friendly translation mapping
// (connection / auth / rate-limit / timeout / unknown), the provider-endpoint
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

  it("SDK connection error on a non-Ollama endpoint → can't-reach WITHOUT the Ollama hint", () => {
    const hint = translateProviderError("Connection error.", hostedEndpoint);
    expect(hint?.friendly).toContain("Can't reach Anthropic (Claude) at https://api.anthropic.com");
    expect(hint?.friendly).not.toContain("ollama serve");
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
