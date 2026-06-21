// SPEC-6 FR-19 — the command palette: the SECOND surface for AI generation (alongside the
// dockable GenerationPanel), plus quick action search. ⌘/Ctrl-K opens a modal with one
// search box that does two things:
//   • a quick AI prompt — drives the SAME agentRunner as the panel (shared agentTurn
//     wiring), so a one-line "make a 20mm cube" works without opening the panel;
//   • action search over the shared action registry (actions/registry.ts) — run any
//     enabled editor action (sketch, loft, export, undo…) by name.
// Conversation + trace persist via the aiStore, so a palette run shows up in the panel's
// history and the next turn continues it.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ACTIONS, runAction } from "../actions/registry.js";
import { useActionContext } from "../ribbon/useActionContext.js";
import { useAiStore } from "./aiStore.js";
import { useCadStore } from "../store/store.js";
import { useProjectsStore } from "../persistence/projectsStore.js";
import { buildProvider } from "./providers/registry.js";
import { toProviderSettings } from "./settings.js";
import { runGeneration } from "./runGeneration.js";
import { buildTurnTools, buildSeam } from "./agentTurn.js";
import { PaidJobConfirmModal, type PendingConfirm } from "./PaidJobConfirmModal.js";
import { UsageMeter } from "./usage.js";

/** One row in the palette: a quick-AI prompt or a registry action. */
type PaletteItem =
  | { kind: "ai"; label: string }
  | { kind: "action"; id: string; label: string };

const MAX_ACTIONS = 8;

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }): React.JSX.Element {
  const ctx = useActionContext();
  const settings = useAiStore((s) => s.settings);
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [paidConfirm, setPaidConfirm] = useState<PendingConfirm | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset + focus whenever the palette opens.
  useEffect(() => {
    if (open) {
      setQuery("");
      setSel(0);
      setStatus(null);
      // Focus after paint so the input exists.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const actionMatches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return Object.values(ACTIONS)
      .filter((a) => a.enabled(ctx))
      .map((a) => ({ id: a.id, label: a.label(ctx) }))
      .filter((a) => !q || a.label.toLowerCase().includes(q))
      .slice(0, MAX_ACTIONS);
  }, [query, ctx]);

  const items: PaletteItem[] = useMemo(() => {
    const q = query.trim();
    const ai: PaletteItem[] = settings && q.length > 0 ? [{ kind: "ai", label: `Ask AI: ${q}` }] : [];
    return [...ai, ...actionMatches.map((a): PaletteItem => ({ kind: "action", id: a.id, label: a.label }))];
  }, [query, settings, actionMatches]);

  // Keep the highlight in range as the result set shrinks.
  useEffect(() => {
    setSel((s) => (items.length === 0 ? 0 : Math.min(s, items.length - 1)));
  }, [items.length]);

  /** Drive one quick AI generation turn through the shared agent wiring. */
  const runQuickPrompt = useCallback(
    async (text: string): Promise<void> => {
      const current = useAiStore.getState().settings;
      if (!current) return;
      if (!buildSeam()) {
        setStatus("The geometry viewport isn’t ready yet — try again in a moment.");
        return;
      }
      setBusy(true);
      setStatus("Generating…");
      const controller = new AbortController();
      const meter = new UsageMeter();
      const created = { id: null as string | null };
      const tools = buildTurnTools({
        settings: current,
        confirm: (info) => new Promise<boolean>((resolve) => setPaidConfirm({ info, resolve })),
        recordPaidJob: () => meter.addPaidJob(),
        onMeshCreated: (id) => {
          created.id = id;
        },
        signal: controller.signal,
      });
      if (!tools) {
        setBusy(false);
        setStatus("The geometry viewport isn’t ready yet — try again in a moment.");
        return;
      }
      const provider = buildProvider(toProviderSettings(current));
      const ai = useAiStore.getState();
      const history = ai.conversation.messages;
      const currentDoc = useCadStore.getState().toDocument();
      void ai.appendMessage({ role: "user", content: text });
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
            if (e.type === "text") assistantText += e.text;
            else if (e.type === "tool-call")
              void ai.appendTrace({ kind: "tool-call", name: e.name, detail: JSON.stringify(e.args).slice(0, 200) });
            else if (e.type === "tool-result")
              void ai.appendTrace({
                kind: "tool-result",
                name: e.name,
                detail: e.result.slice(0, 200),
                isError: e.isError,
              });
            else if (e.type === "status") setStatus(`Done · ${e.steps} step${e.steps === 1 ? "" : "s"}`);
          },
        });
        if (assistantText.trim()) void ai.appendMessage({ role: "assistant", content: assistantText });
        if (created.id) await useProjectsStore.getState().open(created.id);
        onClose(); // success → dismiss the palette (the geometry/panel reflect the result)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setStatus(`Failed: ${msg}`);
        void ai.appendTrace({ kind: "tool-result", name: "error", detail: msg, isError: true });
      } finally {
        setBusy(false);
      }
    },
    [onClose],
  );

  const runItem = useCallback(
    (item: PaletteItem | undefined): void => {
      if (!item) return;
      if (item.kind === "ai") void runQuickPrompt(item.label.replace(/^Ask AI:\s*/, ""));
      else {
        runAction(item.id, ctx);
        onClose();
      }
    },
    [ctx, onClose, runQuickPrompt],
  );

  if (!open) return <></>;

  return (
    <div
      data-testid="command-palette"
      role="dialog"
      aria-label="Command palette"
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[12vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-[34rem] max-w-[92vw] overflow-hidden rounded-lg border border-[#2a3444] bg-[#0b0d12] shadow-2xl">
        {paidConfirm ? (
          <div className="p-2">
            <PaidJobConfirmModal
              info={paidConfirm.info}
              onResolve={(ok) => {
                paidConfirm.resolve(ok);
                setPaidConfirm(null);
              }}
            />
          </div>
        ) : (
          <>
            <input
              ref={inputRef}
              data-testid="command-palette-input"
              value={query}
              disabled={busy}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  onClose();
                } else if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setSel((s) => (items.length ? (s + 1) % items.length : 0));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setSel((s) => (items.length ? (s - 1 + items.length) % items.length : 0));
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  runItem(items[sel]);
                }
              }}
              placeholder="Type a command, or describe a part for the AI…"
              className="w-full border-b border-[#1b2230] bg-transparent px-3 py-2 text-sm text-[#cfe] placeholder:text-[#566] focus:outline-none disabled:opacity-60"
            />
            <ul data-testid="command-palette-results" className="max-h-72 overflow-auto py-1 text-sm">
              {items.length === 0 && (
                <li className="px-3 py-2 text-[11px] text-[#678]">No matching commands.</li>
              )}
              {items.map((item, i) => (
                <li key={item.kind === "ai" ? "ai" : item.id}>
                  <button
                    type="button"
                    data-testid={item.kind === "ai" ? "palette-ai" : `palette-action-${item.id}`}
                    onMouseEnter={() => setSel(i)}
                    onClick={() => runItem(item)}
                    className={`flex w-full items-center gap-2 px-3 py-1.5 text-left ${
                      i === sel ? "bg-[#14253a] text-[#bfe]" : "text-[#cde] hover:bg-[#10141c]"
                    }`}
                  >
                    <span className="text-[10px] text-[#789]">{item.kind === "ai" ? "AI" : "▸"}</span>
                    <span className="truncate">{item.label}</span>
                  </button>
                </li>
              ))}
            </ul>
            {status && (
              <div data-testid="command-palette-status" className="border-t border-[#1b2230] px-3 py-1.5 text-[11px] text-[#789]">
                {status}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
