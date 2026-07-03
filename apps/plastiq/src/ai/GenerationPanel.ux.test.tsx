// @vitest-environment jsdom
//
// AI/service UX — GenerationPanel behaviors around failure and continuity:
//  1. error translation + Retry: a provider failure (relayed through the REAL agent
//     loop) surfaces as an actionable message (raw kept collapsed) and the failed run
//     is retryable verbatim (same prompt reaches the provider again);
//  2. transcript replay: the persisted per-project conversation hydrates the visible
//     transcript on mount / project change, marked as prior-session lines;
//  3. service health pre-checks: mesh-convert and NeRF capture GET /health first and
//     refuse to submit when the service is unreachable (error slot names the URL +
//     start command; the job endpoint is never hit).
//
// The chat provider is mocked at the registry seam (buildProvider) so the real
// runGeneration/agentRunner wiring runs without a network; /health is driven by a
// fake global fetch.

import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { GenerationPanel } from "./GenerationPanel.js";
import { useAiStore } from "./aiStore.js";
import { useProjectsStore } from "../persistence/projectsStore.js";
import type { ChatMessage, ChatStreamRequest } from "./providers/types.js";
import type { MeshDoc } from "../store/types.js";

// Controllable fake chat provider behind the registry seam — the panel + the REAL
// agent loop drive it; tests flip `behavior`/`errorText` and inspect `requests`.
const providerControl = vi.hoisted(() => ({
  behavior: "fail" as "fail" | "ok",
  errorText: "TypeError: Failed to fetch",
  requests: [] as ChatStreamRequest[],
}));
vi.mock("./providers/registry.js", () => ({
  buildProvider: () => ({
    id: "openai-compatible" as const,
    model: "fake-model",
    supportsVision: false,
    supportsTools: true,
    // eslint-disable-next-line @typescript-eslint/require-await
    async *stream(req: ChatStreamRequest) {
      // Snapshot: the agent loop keeps mutating the same messages array after the turn.
      providerControl.requests.push({ ...req, messages: [...req.messages] });
      if (providerControl.behavior === "fail") {
        yield { type: "error" as const, error: providerControl.errorText };
        yield { type: "done" as const, finishReason: "error" as const };
        return;
      }
      yield { type: "text-delta" as const, text: "Built it." };
      yield { type: "done" as const, finishReason: "stop" as const };
    },
  }),
}));

// The NeRF flow trains server-side; mock the package client so the health pre-check is
// the ONLY network touchpoint (and assert the train job is never submitted).
const nerfMocks = vi.hoisted(() => ({
  trainNerf: vi.fn(async () => ({
    glb: "R0xCdGVzdA==",
    report: { method: "neus", iters: 100, psnr: 20, vertices: 10, faces: 20 },
  })),
}));
vi.mock("@plastiq/nerf", () => ({ trainNerf: nerfMocks.trainNerf }));

const realFetch = globalThis.fetch;

beforeEach(() => {
  useAiStore.setState({
    settings: { providerKey: "ollama", providerId: "openai-compatible", model: "qwen2.5", apiKeys: {} },
    loaded: true,
    conversation: { messages: [], trace: [] },
    conversationProjectId: null,
  });
  useProjectsStore.setState({ activeMeshDoc: null });
  (globalThis as { __plastiqBuild?: () => Promise<null> }).__plastiqBuild = () => Promise.resolve(null);
  providerControl.behavior = "fail";
  providerControl.errorText = "TypeError: Failed to fetch";
  providerControl.requests.length = 0;
  nerfMocks.trainNerf.mockClear();
});

afterEach(() => {
  cleanup();
  globalThis.indexedDB = new IDBFactory();
  globalThis.fetch = realFetch;
  delete (globalThis as { __plastiqBuild?: unknown }).__plastiqBuild;
});

/** Type a prompt and send it (the chat path). */
const sendPrompt = async (text: string): Promise<void> => {
  fireEvent.change(screen.getByTestId("generation-prompt"), { target: { value: text } });
  await act(async () => {
    fireEvent.click(screen.getByTestId("generation-send"));
  });
};

describe("GenerationPanel — provider failures are translated and retryable", () => {
  it("a connection failure surfaces as an actionable can't-reach message with the raw kept secondary", async () => {
    render(<GenerationPanel />);
    await sendPrompt("make a cube");

    await waitFor(() => {
      const transcript = screen.getByTestId("generation-transcript").textContent ?? "";
      expect(transcript).toContain("Can't reach Ollama (local, no key) at http://localhost:11434/v1");
    });
    const transcript = screen.getByTestId("generation-transcript").textContent ?? "";
    expect(transcript).toContain("is it running?");
    expect(transcript).toContain("ollama serve"); // the Ollama-specific start hint
    // The raw provider message stays available, collapsed under the friendly line.
    expect(screen.getByTestId("error-detail").textContent).toContain("TypeError: Failed to fetch");
    // The failed run is retryable.
    expect(screen.getByTestId("generation-retry")).toBeTruthy();
  });

  it("an auth failure points at the API key in Provider settings", async () => {
    providerControl.errorText = "401 Incorrect API key provided";
    render(<GenerationPanel />);
    await sendPrompt("make a cube");

    await waitFor(() => {
      const transcript = screen.getByTestId("generation-transcript").textContent ?? "";
      expect(transcript).toContain("unauthorized");
      expect(transcript).toContain("Provider settings");
    });
  });

  it("Retry re-runs the SAME prompt through the provider; a success clears the affordance", async () => {
    render(<GenerationPanel />);
    await sendPrompt("make a cube");
    await waitFor(() => expect(screen.getByTestId("generation-retry")).toBeTruthy());
    expect(providerControl.requests).toHaveLength(1);

    providerControl.behavior = "ok";
    await act(async () => {
      fireEvent.click(screen.getByTestId("generation-retry"));
    });

    await waitFor(() => {
      expect(screen.getByTestId("generation-transcript").textContent).toContain("Built it.");
    });
    // The retry reached the provider with the same user prompt (not an empty input).
    expect(providerControl.requests).toHaveLength(2);
    const retried = providerControl.requests[1]!.messages;
    const last = retried[retried.length - 1] as ChatMessage;
    expect(last).toMatchObject({ role: "user", content: "make a cube" });
    // A successful run clears the retry affordance.
    await waitFor(() => expect(screen.queryByTestId("generation-retry")).toBeNull());
  });
});

describe("GenerationPanel — transcript replay from the persisted conversation (R5.1)", () => {
  it("hydrates the visible transcript on mount, marked as prior-session lines (tool turns excluded)", () => {
    useAiStore.setState({
      conversation: {
        messages: [
          { role: "user", content: "make a bracket" },
          { role: "assistant", content: "Done — a 40×20 bracket." },
          { role: "tool", toolCallId: "t1", content: "internal tool result" },
        ],
        trace: [],
      },
      conversationProjectId: "p1",
    });
    render(<GenerationPanel />);

    const transcript = screen.getByTestId("generation-transcript");
    expect(transcript.textContent).toContain("earlier messages in this project");
    expect(transcript.textContent).toContain("> make a bracket");
    expect(transcript.textContent).toContain("Done — a 40×20 bracket.");
    // Tool-loop plumbing is not replayed.
    expect(transcript.textContent).not.toContain("internal tool result");
    // Prior-session lines are rendered distinguishably (header + 2 messages).
    expect(transcript.querySelectorAll('[data-prior="true"]')).toHaveLength(3);
  });

  it("switching projects re-hydrates the transcript from the new project's history", async () => {
    useAiStore.setState({
      conversation: { messages: [{ role: "user", content: "old project prompt" }], trace: [] },
      conversationProjectId: "p1",
    });
    render(<GenerationPanel />);
    expect(screen.getByTestId("generation-transcript").textContent).toContain("old project prompt");

    // openConversation sets the loaded conversation + project id together; mirror that.
    act(() => {
      useAiStore.setState({
        conversation: { messages: [{ role: "assistant", content: "welcome back to p2" }], trace: [] },
        conversationProjectId: "p2",
      });
    });
    await waitFor(() => {
      const transcript = screen.getByTestId("generation-transcript").textContent ?? "";
      expect(transcript).toContain("welcome back to p2");
      expect(transcript).not.toContain("old project prompt");
    });
  });
});

describe("GenerationPanel — service health pre-checks block submission (GET /health)", () => {
  const installDeadFetch = (): ReturnType<typeof vi.fn> => {
    const spy = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    globalThis.fetch = spy as unknown as typeof fetch;
    return spy;
  };

  it("mesh-convert: an unreachable reconstruction service shows the start hint and never submits", async () => {
    const fetchSpy = installDeadFetch();
    const meshDoc: MeshDoc = { kind: "mesh", name: "gen", glb: "R0xC", source: { mode: "img3d", providerId: "fal:tripo" } };
    useProjectsStore.setState({ activeMeshDoc: meshDoc });
    render(<GenerationPanel />);

    await act(async () => {
      fireEvent.click(screen.getByTestId("mesh-convert-run"));
    });

    await waitFor(() => {
      const err = screen.getByTestId("mesh-convert-error").textContent ?? "";
      expect(err).toContain("unreachable at http://localhost:8000");
      expect(err).toContain("start it with");
    });
    // Exactly ONE request went out — the health probe; the job was never submitted.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe("http://localhost:8000/health");
    // The section is idle again (not stuck busy).
    expect((screen.getByTestId("mesh-convert-run") as HTMLButtonElement).disabled).toBe(false);
  });

  it("NeRF capture: an unreachable service shows the start hint and never trains", async () => {
    const fetchSpy = installDeadFetch();
    render(<GenerationPanel />);

    const transforms = new File([JSON.stringify({ frames: [{ file_path: "v0.png" }] })], "transforms.json", {
      type: "application/json",
    });
    await act(async () => {
      fireEvent.change(screen.getByTestId("nerf-transforms-input"), { target: { files: [transforms] } });
    });
    await act(async () => {
      fireEvent.change(screen.getByTestId("nerf-images-input"), {
        target: { files: [new File([new Uint8Array([1, 2, 3])], "v0.png", { type: "image/png" })] },
      });
    });
    await waitFor(() => expect((screen.getByTestId("nerf-capture-btn") as HTMLButtonElement).disabled).toBe(false));

    await act(async () => {
      fireEvent.click(screen.getByTestId("nerf-capture-btn"));
    });

    await waitFor(() => {
      const err = screen.getByTestId("nerf-error").textContent ?? "";
      expect(err).toContain("unreachable at http://localhost:8002");
      expect(err).toContain("start it with");
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe("http://localhost:8002/health");
    expect(nerfMocks.trainNerf).not.toHaveBeenCalled();
  });
});
