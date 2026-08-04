// Docked Fusion-style Text Commands palette: resizable transcript, one-line
// command entry, completion, persisted history, and live geometry/service status.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";
import { useActionContext } from "../ribbon/useActionContext.js";
import { useCadStore } from "../store/store.js";
import {
  completeConsoleInput,
  executeConsoleInput,
  type ConsoleMessage,
} from "./commandConsole.js";

const OPEN_KEY = "plastiq.textCommands.visible";
const HISTORY_KEY = "plastiq.textCommands.history";
const MAX_HISTORY = 100;

function readOpen(): boolean {
  try {
    const saved = globalThis.localStorage?.getItem(OPEN_KEY);
    // Fusion keeps Text Commands as an opt-in palette; preserve the full canvas
    // on first launch, then remember the user's explicit show/hide choice.
    return saved === "1";
  } catch {
    return false;
  }
}

function readHistory(): string[] {
  try {
    const value: unknown = JSON.parse(globalThis.localStorage?.getItem(HISTORY_KEY) ?? "[]");
    return Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === "string").slice(-MAX_HISTORY)
      : [];
  } catch {
    return [];
  }
}

function persist(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    // Text Commands remains fully usable when storage is blocked; only preference/history is lost.
  }
}

interface CommandConsoleUi {
  visible: boolean;
  setVisible: (visible: boolean) => void;
  toggle: () => void;
}

export const useCommandConsole = create<CommandConsoleUi>((set) => ({
  visible: readOpen(),
  setVisible: (visible) => {
    persist(OPEN_KEY, visible ? "1" : "0");
    set({ visible });
  },
  toggle: () =>
    set((state) => {
      const visible = !state.visible;
      persist(OPEN_KEY, visible ? "1" : "0");
      return { visible };
    }),
}));

function Resizer({ onResize }: { onResize: (dy: number) => void }): React.JSX.Element {
  const lastY = useRef<number | null>(null);
  return (
    <div
      role="separator"
      aria-label="Resize Text Commands"
      aria-orientation="horizontal"
      data-testid="text-commands-resizer"
      className="h-1 cursor-row-resize bg-[#202733] hover:bg-[#4ea1ff]"
      onPointerDown={(event) => {
        event.preventDefault();
        lastY.current = event.clientY;
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (lastY.current === null) return;
        onResize(lastY.current - event.clientY);
        lastY.current = event.clientY;
      }}
      onPointerUp={(event) => {
        lastY.current = null;
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onLostPointerCapture={() => {
        lastY.current = null;
      }}
    />
  );
}

function messageClass(kind: ConsoleMessage["kind"]): string {
  if (kind === "command") return "text-[#dff9ff]";
  if (kind === "error") return "text-[#ff8f9b]";
  if (kind === "status") return "text-[#8bb8cb]";
  return "text-[#aab8c8]";
}

export function CommandConsole(): React.JSX.Element | null {
  const visible = useCommandConsole((state) => state.visible);
  const setVisible = useCommandConsole((state) => state.setVisible);
  const ctx = useActionContext();
  const [height, setHeight] = useState(210);
  const [input, setInput] = useState("");
  const [history, setHistory] = useState<string[]>(readHistory);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const [running, setRunning] = useState(false);
  const [messages, setMessages] = useState<ConsoleMessage[]>([
    {
      kind: "output",
      text: "Plastiq Text Commands — type `help` for commands or run any action id.",
    },
  ]);
  const inputRef = useRef<HTMLInputElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const latestStatus = useRef(useCadStore.getState().status);
  const completions = useMemo(() => completeConsoleInput(input, ctx), [input, ctx]);

  useEffect(() => {
    if (visible) requestAnimationFrame(() => inputRef.current?.focus());
  }, [visible]);

  useEffect(
    () =>
      useCadStore.subscribe((state) => {
        if (state.status === latestStatus.current) return;
        latestStatus.current = state.status;
        const message: ConsoleMessage = { kind: "status", text: state.status };
        setMessages((current) => [...current, message].slice(-500));
      }),
    [],
  );

  useEffect(() => {
    if (visible && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [messages, visible]);

  const execute = useCallback(async (): Promise<void> => {
    const source = input.trim();
    if (!source || running) return;
    const nextHistory = [...history.filter((entry) => entry !== source), source].slice(
      -MAX_HISTORY,
    );
    setHistory(nextHistory);
    persist(HISTORY_KEY, JSON.stringify(nextHistory));
    setHistoryIndex(null);
    setInput("");
    setRunning(true);
    try {
      const result = await executeConsoleInput(source, ctx, { history: nextHistory });
      setMessages((current) => [...(result.clear ? [] : current), ...result.messages].slice(-500));
    } finally {
      setRunning(false);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [ctx, history, input, running]);

  const recall = (direction: -1 | 1): void => {
    if (history.length === 0) return;
    const current = historyIndex ?? history.length;
    const next = Math.max(0, Math.min(history.length, current + direction));
    setHistoryIndex(next === history.length ? null : next);
    setInput(next === history.length ? "" : history[next]!);
  };

  if (!visible) return null;

  return (
    <section
      id="text-commands-panel"
      data-testid="text-commands"
      aria-label="Text Commands"
      style={{ height }}
      className="flex min-h-[120px] flex-col border-t border-[#354052] bg-[#0a0e14] shadow-[0_-8px_24px_rgba(0,0,0,0.28)]"
    >
      <Resizer
        onResize={(dy) =>
          setHeight((value) => Math.max(120, Math.min(window.innerHeight * 0.55, value + dy)))
        }
      />
      <header className="flex h-7 shrink-0 items-center gap-2 border-b border-[#242d3a] bg-[#111720] px-2">
        <span className="text-[10px] font-bold tracking-[0.14em] text-[#b6c8d8]">
          TEXT COMMANDS
        </span>
        <span className="text-[10px] text-[#607386]">APPLICATION SHELL</span>
        {running && (
          <span data-testid="text-commands-running" className="text-[10px] text-[#62c7ff]">
            running…
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            className="rounded px-1.5 text-[10px] text-[#8495a8] hover:bg-[#202a37] hover:text-[#dcecff]"
            onClick={() => setMessages([])}
          >
            Clear
          </button>
          <button
            type="button"
            className="rounded px-1.5 text-[10px] text-[#8495a8] hover:bg-[#202a37] hover:text-[#dcecff]"
            onClick={() =>
              void navigator.clipboard?.writeText(
                messages
                  .map((message) => `${message.kind === "command" ? "> " : ""}${message.text}`)
                  .join("\n"),
              )
            }
          >
            Copy
          </button>
          <button
            type="button"
            aria-label="Hide Text Commands"
            title="Hide Text Commands"
            className="rounded px-1.5 text-sm leading-none text-[#8495a8] hover:bg-[#202a37] hover:text-[#dcecff]"
            onClick={() => setVisible(false)}
          >
            ×
          </button>
        </div>
      </header>
      <div
        ref={logRef}
        role="log"
        aria-live="polite"
        data-testid="text-commands-log"
        className="min-h-0 flex-1 overflow-auto px-3 py-2 font-mono text-[11px] leading-5"
      >
        {messages.length === 0 ? (
          <div className="text-[#526171]">Transcript cleared.</div>
        ) : (
          messages.map((message, index) => (
            <div
              key={`${index}-${message.text}`}
              className={`whitespace-pre-wrap break-words ${messageClass(message.kind)}`}
            >
              {message.kind === "command" ? (
                <span className="mr-2 text-[#4ea1ff]">&gt;</span>
              ) : null}
              {message.text}
            </div>
          ))
        )}
      </div>
      <div className="relative flex h-8 shrink-0 items-center border-t border-[#26313e] bg-[#0d131b] px-2">
        {completions.length > 0 && (
          <div
            data-testid="text-commands-completions"
            className="absolute bottom-full left-6 z-20 mb-1 min-w-56 overflow-hidden rounded border border-[#344255] bg-[#111923] py-1 shadow-xl"
          >
            {completions.map((completion, index) => (
              <button
                key={completion}
                type="button"
                className={`block w-full px-2 py-0.5 text-left text-[11px] ${index === 0 ? "bg-[#1d344b] text-[#e1f5ff]" : "text-[#9cafc1] hover:bg-[#1a2633]"}`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  setInput(completion);
                  inputRef.current?.focus();
                }}
              >
                {completion}
              </button>
            ))}
          </div>
        )}
        <span className="mr-2 select-none text-[12px] font-bold text-[#4ea1ff]">&gt;</span>
        <input
          ref={inputRef}
          data-testid="text-commands-input"
          aria-label="Text command"
          aria-keyshortcuts="Control+Alt+C"
          autoComplete="off"
          spellCheck={false}
          value={input}
          disabled={running}
          placeholder="Enter a command"
          className="min-w-0 flex-1 border-0 bg-transparent font-mono text-[12px] text-[#e4eef8] outline-none placeholder:text-[#4f6070] disabled:opacity-60"
          onChange={(event) => {
            setInput(event.currentTarget.value);
            setHistoryIndex(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void execute();
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              recall(-1);
            } else if (event.key === "ArrowDown") {
              event.preventDefault();
              recall(1);
            } else if (event.key === "Escape") {
              event.preventDefault();
              setInput("");
              setHistoryIndex(null);
            } else if (event.key === "Tab" && completions[0]) {
              event.preventDefault();
              setInput(completions[0]);
            }
          }}
        />
      </div>
    </section>
  );
}
