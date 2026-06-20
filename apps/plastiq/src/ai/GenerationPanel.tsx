// SPEC-6 R2.4 — the AI generation cockpit (FR-19). A dockable side panel: prompt input,
// streaming response + a visible tool-call/build trace, a usage meter, and cancel. It
// wires the real dependencies — the off-thread build seam (__plastiqBuild on the single
// geometry worker) as the build_part/inspect_geometry probe, loadDocument as the atomic
// apply, and the live document as edit context — then drives runGeneration. A compact
// neutral first-run chooser (FR-5a) lets the user pick a provider so the panel is
// self-sufficient. Conversation + trace persist per project via the aiStore (R5.1).

import { useCallback, useRef, useState } from "react";
import { useAiStore } from "./aiStore.js";
import { useCadStore } from "../store/store.js";
import { buildProvider } from "./providers/registry.js";
import { toProviderSettings, type AiSettings } from "./settings.js";
import { buildAgentTools } from "./tools/toolDefs.js";
import { runGeneration } from "./runGeneration.js";
import { UsageMeter, type UsageSnapshot } from "./usage.js";
import type { BuildProbe, ApplyDocument } from "./tools/buildPart.js";
import type { MeshProbe } from "./tools/inspectGeometry.js";
import type { CadDocument } from "../store/types.js";
import type { TransferMesh } from "../worker/protocol.js";

/** A line in the visible transcript (assistant text, a tool step, or a status). */
interface Line {
  kind: "text" | "tool" | "status" | "error";
  text: string;
  isError?: boolean;
}

type BuildSeam = (doc: CadDocument) => Promise<TransferMesh | null>;

/** Compact neutral first-run chooser (decision 17 / FR-5a) — local Ollama (no key,
 * offline) or a BYO Anthropic key. Persists via the aiStore. */
function FirstRunChooser(): React.JSX.Element {
  const save = useAiStore((s) => s.save);
  const [key, setKey] = useState("");
  const useOllama = (): void => {
    void save({
      providerKey: "ollama",
      providerId: "openai-compatible",
      model: "qwen2.5",
      baseURL: "http://localhost:11434/v1",
      apiKeys: {},
    });
  };
  const useAnthropic = (): void => {
    if (!key.trim()) return;
    const settings: AiSettings = {
      providerKey: "anthropic",
      providerId: "anthropic",
      model: "claude-opus-4-8",
      apiKeys: { anthropic: key.trim() },
    };
    void save(settings);
  };
  return (
    <div data-testid="ai-setup" className="space-y-2 text-xs text-[#9ab]">
      <p>Choose an AI provider to generate parts:</p>
      <button
        type="button"
        data-testid="ai-use-ollama"
        onClick={useOllama}
        className="w-full rounded border border-[#2a3444] bg-[#10141c] px-2 py-1 text-left text-[#cfe] hover:bg-[#16202c]"
      >
        Use local Ollama (qwen2.5) — no key, offline
      </button>
      <div className="flex gap-1">
        <input
          data-testid="ai-anthropic-key"
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="Anthropic API key (BYO)"
          className="min-w-0 flex-1 rounded border border-[#2a3444] bg-[#0b0d12] px-2 py-1 text-[#cfe]"
        />
        <button
          type="button"
          data-testid="ai-use-anthropic"
          onClick={useAnthropic}
          className="rounded border border-[#2a3444] bg-[#10141c] px-2 py-1 hover:bg-[#16202c]"
        >
          Use
        </button>
      </div>
      <p className="text-[10px] text-[#678]">
        Keys stay in your browser (IndexedDB) and are sent only to the provider you choose.
      </p>
    </div>
  );
}

export function GenerationPanel(): React.JSX.Element {
  const settings = useAiStore((s) => s.settings);
  const [prompt, setPrompt] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [running, setRunning] = useState(false);
  const [usage, setUsage] = useState<UsageSnapshot | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const append = useCallback((line: Line): void => setLines((prev) => [...prev, line]), []);

  const run = useCallback(async (): Promise<void> => {
    const current = useAiStore.getState().settings;
    if (!current || running) return;
    const text = prompt.trim();
    if (!text) return;

    const build = (globalThis as { __plastiqBuild?: BuildSeam }).__plastiqBuild;
    if (!build) {
      append({ kind: "error", text: "The geometry viewport isn’t ready yet — try again in a moment.", isError: true });
      return;
    }

    const probe: BuildProbe = async (doc) => {
      try {
        return (await build(doc)) ? { ok: true } : { ok: false, error: "the document produced no geometry or a feature failed to build" };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    };
    const meshProbe: MeshProbe = (doc) => build(doc);
    const apply: ApplyDocument = (doc) => useCadStore.getState().loadDocument(doc);
    const tools = buildAgentTools({
      buildPart: { probe, apply },
      probe: meshProbe,
      currentDoc: () => useCadStore.getState().toDocument(),
    });

    const provider = buildProvider(toProviderSettings(current));
    const meter = new UsageMeter();
    const ai = useAiStore.getState();
    const history = ai.conversation.messages;
    const currentDoc = useCadStore.getState().toDocument();

    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    append({ kind: "text", text: `> ${text}` });
    void ai.appendMessage({ role: "user", content: text });
    setPrompt("");

    let assistantText = "";
    try {
      await runGeneration({
        provider,
        input: text,
        history,
        currentDoc,
        tools,
        signal: controller.signal,
        onEvent: (e) => {
          if (e.type === "text") {
            assistantText += e.text;
            append({ kind: "text", text: e.text });
          } else if (e.type === "tool-call") {
            const detail = JSON.stringify(e.args).slice(0, 200);
            append({ kind: "tool", text: `→ ${e.name}(${detail})` });
            void ai.appendTrace({ kind: "tool-call", name: e.name, detail });
          } else if (e.type === "tool-result") {
            append({ kind: "tool", text: `← ${e.name}: ${e.result.slice(0, 200)}`, isError: e.isError });
            void ai.appendTrace({ kind: "tool-result", name: e.name, detail: e.result.slice(0, 200), isError: e.isError });
          } else if (e.type === "usage") {
            meter.addTokens({ inputTokens: e.inputTokens, outputTokens: e.outputTokens });
            setUsage(meter.snapshot());
          } else if (e.type === "status") {
            append({ kind: "status", text: `[${e.finish} · ${e.steps} step${e.steps === 1 ? "" : "s"}]` });
          }
        },
      });
      if (assistantText.trim()) void ai.appendMessage({ role: "assistant", content: assistantText });
    } catch (e) {
      append({ kind: "error", text: e instanceof Error ? e.message : String(e), isError: true });
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  }, [prompt, running, append]);

  const cancel = useCallback((): void => abortRef.current?.abort(), []);

  return (
    <div data-testid="generation-panel" className="flex flex-col gap-2 text-xs">
      {!settings ? (
        <FirstRunChooser />
      ) : (
        <>
          <textarea
            data-testid="generation-prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void run();
            }}
            rows={3}
            placeholder="Describe a part to build or edit — e.g. “a 40×20×10 mm bracket with a 5 mm fillet on the top edges”. ⌘/Ctrl+Enter to send."
            disabled={running}
            className="w-full resize-none rounded border border-[#2a3444] bg-[#0b0d12] px-2 py-1 text-[#cfe] placeholder:text-[#566] disabled:opacity-60"
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              data-testid="generation-send"
              onClick={() => void run()}
              disabled={running || !prompt.trim()}
              className="rounded border border-[#3a5a7a] bg-[#14253a] px-2 py-1 text-[#bfe] hover:bg-[#1a2f48] disabled:opacity-40"
            >
              {running ? "Generating…" : "Generate"}
            </button>
            {running && (
              <button
                type="button"
                data-testid="generation-cancel"
                onClick={cancel}
                className="rounded border border-[#7a3a3a] bg-[#2a1414] px-2 py-1 text-[#fbb] hover:bg-[#341a1a]"
              >
                Cancel
              </button>
            )}
            {usage && (
              <span data-testid="generation-usage" className="ml-auto text-[10px] text-[#789]">
                {usage.totalTokens} tok{usage.paidJobs > 0 ? ` · ${usage.paidJobs} paid` : ""}
              </span>
            )}
          </div>
          {lines.length > 0 && (
            <div
              data-testid="generation-transcript"
              className="max-h-64 overflow-auto whitespace-pre-wrap rounded border border-[#1b2230] bg-black/30 p-2 font-mono text-[10px] leading-snug"
            >
              {lines.map((l, i) => (
                <div
                  key={i}
                  className={
                    l.isError
                      ? "text-[#fb9]"
                      : l.kind === "tool"
                        ? "text-[#9cf]"
                        : l.kind === "status"
                          ? "text-[#789]"
                          : "text-[#cde]"
                  }
                >
                  {l.text}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
