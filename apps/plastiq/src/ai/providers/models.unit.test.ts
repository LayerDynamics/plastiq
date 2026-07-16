// SPEC-6 FR-5b/§6.9 — probeModelCapabilities, the LIVE tool-capability preflight, over a
// scripted fake fetch (no network). Branches under test: Ollama `/api/show` metadata
// (capable / incapable / pre-capabilities fallback to the chat probe), the minimal
// tools-enabled chat probe against OpenAI-compatible endpoints (explicit tools-unsupported
// 4xx refutes; unrelated errors don't), Anthropic catalog truth (no token-burning probe),
// and the offline/aborted fallback to the static catalog (the probe never rejects/blocks).

import { describe, it, expect } from "vitest";
import { probeModelCapabilities } from "./models.js";

/** Minimal Response stand-in — the probe only touches ok/status/json()/text(). */
function res(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  } as unknown as Response;
}

/** Scripted fetch that records every call so tests can assert the actual HTTP contract. */
function scriptedFetch(script: (url: string, init?: RequestInit) => Response | Promise<Response>): {
  fetchImpl: typeof fetch;
  calls: { url: string; init?: RequestInit }[];
} {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), ...(init ? { init } : {}) });
    return script(String(url), init);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

/** A fetch that must never fire (the Anthropic no-probe branches). */
const forbiddenFetch = (() => {
  throw new Error("probe must not hit the network for this provider");
}) as unknown as typeof fetch;

describe("probeModelCapabilities — Ollama /api/show metadata (§6.9)", () => {
  it("confirms a tools+vision-capable model from the capabilities array", async () => {
    const { fetchImpl, calls } = scriptedFetch(() => res({ capabilities: ["completion", "tools", "vision"] }));
    const out = await probeModelCapabilities("ollama", "qwen3", { fetchImpl });
    expect(out).toEqual({ supportsTools: true, supportsVision: true, verdict: "confirmed", source: "ollama-metadata" });
    // The native API lives at the server root — /v1 stripped — and asks for THIS model.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://localhost:11434/api/show");
    expect(JSON.parse(calls[0]!.init!.body as string).model).toBe("qwen3");
  });

  it("refutes a model whose capabilities lack 'tools' — with the hard warning", async () => {
    const { fetchImpl } = scriptedFetch(() => res({ capabilities: ["completion"] }));
    const out = await probeModelCapabilities("ollama", "qwen3", { fetchImpl });
    expect(out.supportsTools).toBe(false);
    expect(out.verdict).toBe("refuted");
    expect(out.source).toBe("ollama-metadata");
    expect(out.warning).toContain("does not support tool calling");
  });

  it("old Ollama without a capabilities field falls back to the minimal tools-enabled chat probe", async () => {
    const { fetchImpl, calls } = scriptedFetch((url) =>
      url.endsWith("/api/show")
        ? res({ license: "MIT", details: {} }) // pre-capabilities server
        : res({ choices: [{ message: { content: "" } }] }),
    );
    const out = await probeModelCapabilities("ollama", "qwen3", { fetchImpl });
    expect(out.verdict).toBe("confirmed");
    expect(out.source).toBe("chat-probe");
    expect(out.supportsTools).toBe(true);
    // The probe is cheap and tools-enabled: one trivial tool, max_tokens 1, no stream.
    expect(calls[1]!.url).toBe("http://localhost:11434/v1/chat/completions");
    const body = JSON.parse(calls[1]!.init!.body as string) as { tools: unknown[]; max_tokens: number; stream: boolean };
    expect(body.tools).toHaveLength(1);
    expect(body.max_tokens).toBe(1);
    expect(body.stream).toBe(false);
  });
});

describe("probeModelCapabilities — OpenAI-compatible chat probe (§6.9)", () => {
  it("an explicit tools-unsupported 4xx refutes the model (supportsTools: false)", async () => {
    const { fetchImpl } = scriptedFetch(() =>
      res({ error: { message: "registry.example/some-model does not support tools" } }, 400),
    );
    const out = await probeModelCapabilities("openai", "some-model", { fetchImpl });
    expect(out.supportsTools).toBe(false);
    expect(out.verdict).toBe("refuted");
    expect(out.source).toBe("chat-probe");
    expect(out.warning).toContain("does not support tool calling");
  });

  it("an unrelated 4xx cannot refute — keeps the catalog answer (true) with the unverified note", async () => {
    const { fetchImpl } = scriptedFetch(() => res({ error: { message: "invalid api key" } }, 401));
    const out = await probeModelCapabilities("openai", "gpt-custom", { fetchImpl });
    expect(out.supportsTools).toBe(true);
    expect(out.verdict).toBe("unverified");
    expect(out.warning).toContain("custom model"); // the static catalog's note survives
  });

  it("sends the BYO key as a Bearer header — and only to the configured endpoint", async () => {
    const { fetchImpl, calls } = scriptedFetch(() => res({ choices: [] }));
    await probeModelCapabilities("openai", "gpt-tool-x", {
      fetchImpl,
      apiKey: "sk-test",
      baseURL: "https://gateway.corp.example/v1",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://gateway.corp.example/v1/chat/completions");
    expect((calls[0]!.init!.headers as Record<string, string>).authorization).toBe("Bearer sk-test");
  });

  it("llama-mlx probes its /v1 chat surface directly (no Ollama /api/show detour)", async () => {
    const { fetchImpl, calls } = scriptedFetch(() => res({ choices: [] }));
    const out = await probeModelCapabilities("llama-mlx", "mlx-community/Qwen2.5-3B-Instruct-4bit", { fetchImpl });
    expect(out.verdict).toBe("confirmed");
    expect(out.source).toBe("chat-probe");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://127.0.0.1:11543/v1/chat/completions");
  });
});

describe("probeModelCapabilities — Anthropic stays on catalog truth (no token burn)", () => {
  it("a curated Claude is confirmed from the catalog without any network call", async () => {
    const out = await probeModelCapabilities("anthropic", "claude-opus-4-8", { fetchImpl: forbiddenFetch });
    expect(out).toEqual({ supportsTools: true, supportsVision: true, verdict: "confirmed", source: "catalog" });
  });

  it("a custom Anthropic id is left unverified with the warning — still no network call", async () => {
    const out = await probeModelCapabilities("anthropic", "claude-experimental-9", { fetchImpl: forbiddenFetch });
    expect(out.verdict).toBe("unverified");
    expect(out.source).toBe("catalog");
    expect(out.warning).toContain("custom model");
  });
});

describe("probeModelCapabilities — never rejects, never blocks", () => {
  it("offline/unreachable ⇒ the static catalog fallback, custom-model warning intact", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const out = await probeModelCapabilities("ollama", "my-custom-model", { fetchImpl });
    expect(out.verdict).toBe("unverified");
    expect(out.source).toBe("catalog");
    expect(out.supportsTools).toBe(true); // allowed, not silently rejected
    expect(out.warning).toContain("custom model");
  });

  it("an aborted probe (selection changed) resolves to the catalog fallback instead of throwing", async () => {
    const { fetchImpl } = scriptedFetch((_url, init) => {
      if (init?.signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
      return res({ capabilities: ["tools"] });
    });
    const controller = new AbortController();
    controller.abort();
    const out = await probeModelCapabilities("ollama", "qwen3", { fetchImpl, signal: controller.signal });
    expect(out.verdict).toBe("unverified");
    expect(out.source).toBe("catalog");
  });
});
