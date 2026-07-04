// SPEC-6 R1.4 (T1.4): the curated model catalog (Appendix A), the tool-capability
// preflight (FR-5b), and the registry that builds the right adapter from settings.
// Pure/instantiation-only — adapter constructors make no network call.

import { describe, it, expect } from "vitest";
import { MODEL_CATALOG, preflightModel } from "./models.js";
import { buildProvider } from "./registry.js";

describe("R1.4 model catalog (Appendix A)", () => {
  it("lists the curated Anthropic + Ollama models", () => {
    expect(MODEL_CATALOG.anthropic!.models.map((m) => m.id)).toContain("claude-opus-4-8");
    expect(MODEL_CATALOG.ollama!.models.map((m) => m.id)).toEqual(
      expect.arrayContaining(["qwen2.5", "llama3.3:70b", "deepseek-r1:32b"]),
    );
  });

  it("flags which providers need a key", () => {
    expect(MODEL_CATALOG.anthropic!.needsKey).toBe(true);
    expect(MODEL_CATALOG.ollama!.needsKey).toBe(false);
    expect(MODEL_CATALOG.ollama!.defaultBaseURL).toBe("http://localhost:11434/v1");
  });

  it("lists the local llama-mlx-server preset (keyed, :11543)", () => {
    const entry = MODEL_CATALOG["llama-mlx"]!;
    expect(entry.providerId).toBe("llama-mlx");
    expect(entry.needsKey).toBe(true);
    expect(entry.defaultBaseURL).toBe("http://127.0.0.1:11543/v1");
    expect(entry.models.map((m) => m.id)).toContain("mlx-community/Qwen2.5-3B-Instruct-4bit");
    // grammar-backed tool calls ⇒ even small MLX models are tool-capable (no warning).
    expect(entry.models.every((m) => m.supportsTools)).toBe(true);
  });
});

describe("R1.4 tool-capability preflight", () => {
  it("passes a curated tool-capable model with no warning", () => {
    const r = preflightModel("anthropic", "claude-opus-4-8");
    expect(r.supportsTools).toBe(true);
    expect(r.warning).toBeUndefined();
  });

  it("warns for an uncurated/unknown model", () => {
    expect(preflightModel("ollama", "tinyllama").warning).toBeTruthy();
  });

  it("reports vision capability per model", () => {
    expect(preflightModel("anthropic", "claude-opus-4-8").supportsVision).toBe(true);
    expect(preflightModel("ollama", "qwen2.5").supportsVision).toBe(false);
  });
});

describe("R1.4 registry — builds the right adapter from settings", () => {
  it("builds an Anthropic adapter (vision-capable) from anthropic settings", () => {
    const p = buildProvider({ providerKey: "anthropic", providerId: "anthropic", model: "claude-opus-4-8", apiKey: "sk-test" });
    expect(p.id).toBe("anthropic");
    expect(p.model).toBe("claude-opus-4-8");
    expect(p.supportsVision).toBe(true);
    expect(p.supportsTools).toBe(true);
  });

  it("builds an OpenAI-compatible adapter (no vision) for Ollama settings", () => {
    const p = buildProvider({ providerKey: "ollama", providerId: "openai-compatible", model: "qwen2.5" });
    expect(p.id).toBe("openai-compatible");
    expect(p.model).toBe("qwen2.5");
    expect(p.supportsVision).toBe(false);
    expect(p.supportsTools).toBe(true);
  });

  it("builds a llama-mlx adapter from llama-mlx settings", () => {
    const p = buildProvider({
      providerKey: "llama-mlx",
      providerId: "llama-mlx",
      model: "mlx-community/Qwen2.5-3B-Instruct-4bit",
      apiKey: "mlx-key",
    });
    expect(p.id).toBe("llama-mlx");
    expect(p.model).toBe("mlx-community/Qwen2.5-3B-Instruct-4bit");
    expect(p.supportsTools).toBe(true);
  });
});
