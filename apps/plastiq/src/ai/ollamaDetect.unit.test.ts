// SPEC-6 §6.8 / R-10 (6-L3) — first-run local-Ollama detection. The chooser must not
// blindly save a fixed config: detectOllama probes GET /api/tags for the models actually
// installed (tool-capable first) and never throws — unreachable/CORS/timeout collapse to
// { reachable: false }. ollamaNotDetectedMessage carries the dual start/CORS hint.

import { describe, it, expect, vi } from "vitest";
import { detectOllama, ollamaNotDetectedMessage, OLLAMA_DEFAULT_ROOT } from "./ollamaDetect.js";

/** A scripted fetch that returns the given /api/tags JSON. */
function tagsFetch(models: { name: string }[]): typeof fetch {
  return (async (url: string) => {
    if (String(url).endsWith("/api/tags")) {
      return { ok: true, status: 200, json: async () => ({ models }) };
    }
    throw new Error(`unexpected url ${String(url)}`);
  }) as unknown as typeof fetch;
}

describe("detectOllama — reachable with installed models", () => {
  it("lists installed models, flags tool-capable families, and sorts them first", async () => {
    // qwen2.5 / llama3.3 are curated tool-capable families; "mistral-small" is not.
    const fetchImpl = tagsFetch([
      { name: "mistral-small:latest" },
      { name: "qwen2.5:14b" },
      { name: "llama3.3:70b" },
    ]);
    const result = await detectOllama({ fetchImpl });
    expect(result.reachable).toBe(true);
    // Tool-capable models sort ahead of the unverified one (stable within each group).
    expect(result.models.map((m) => m.name)).toEqual(["qwen2.5:14b", "llama3.3:70b", "mistral-small:latest"]);
    expect(result.models.find((m) => m.name === "qwen2.5:14b")?.toolCapable).toBe(true);
    expect(result.models.find((m) => m.name === "mistral-small:latest")?.toolCapable).toBe(false);
  });

  it("reachable but no models installed yields an empty list (not unreachable)", async () => {
    const result = await detectOllama({ fetchImpl: tagsFetch([]) });
    expect(result.reachable).toBe(true);
    expect(result.models).toEqual([]);
  });
});

describe("detectOllama — unreachable / CORS-blocked", () => {
  it("a thrown fetch (down or CORS-blocked) collapses to reachable:false, never throwing", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    const result = await detectOllama({ fetchImpl });
    expect(result).toEqual({ reachable: false, models: [] });
  });

  it("a non-2xx response is treated as unreachable", async () => {
    const fetchImpl = (async () => ({ ok: false, status: 500 })) as unknown as typeof fetch;
    expect(await detectOllama({ fetchImpl })).toEqual({ reachable: false, models: [] });
  });
});

describe("detectOllama — timeout", () => {
  it("aborts the probe after timeoutMs and returns reachable:false", async () => {
    vi.useFakeTimers();
    // A fetch that only rejects when its signal aborts — so the timeout is what resolves the call.
    const fetchImpl = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      })) as unknown as typeof fetch;
    const promise = detectOllama({ fetchImpl, timeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    const result = await promise;
    expect(result).toEqual({ reachable: false, models: [] });
    vi.useRealTimers();
  });
});

describe("ollamaNotDetectedMessage — dual start/CORS hint (FR-3)", () => {
  it("names the endpoint, the start command, and the OLLAMA_ORIGINS CORS restart", () => {
    const msg = ollamaNotDetectedMessage();
    expect(msg).toContain(OLLAMA_DEFAULT_ROOT);
    expect(msg).toContain("ollama serve");
    expect(msg).toContain("OLLAMA_ORIGINS");
  });
});
