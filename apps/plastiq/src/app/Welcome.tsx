// First-run welcome / how-to overlay. A full-screen modal that teaches the core
// Plastiq workflow: pick a workspace → sketch a profile → turn it into a solid, plus
// navigation, selection and a keyboard/mouse cheat-sheet. Shows on every load until
// the user ticks "Don't show this again" (persisted via welcomePrefs); the "?" button
// in the top bar reopens it anytime.

import { useEffect } from "react";
import { create } from "zustand";
import { setWelcomeHidden, welcomeHidden } from "./welcomePrefs.js";

interface WelcomeStore {
  open: boolean;
  /** "Don't show this again" checkbox state for the current view. */
  dontShow: boolean;
  show: () => void;
  /** Close; persists the don't-show preference from the checkbox. */
  close: () => void;
  setDontShow: (v: boolean) => void;
}

/** Open by default unless the user previously hid it (read once at startup). */
export const useWelcome = create<WelcomeStore>((set, get) => ({
  open: !welcomeHidden(),
  dontShow: welcomeHidden(),
  show: () => set({ open: true }),
  close: () => {
    setWelcomeHidden(get().dontShow);
    set({ open: false });
  },
  setDontShow: (v) => set({ dontShow: v }),
}));

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <li className="flex gap-3">
      <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#13243a] text-xs font-bold text-[#7fb4ff]">
        {n}
      </span>
      <div>
        <div className="font-semibold text-[#dfe]">{title}</div>
        <div className="text-[13px] leading-snug text-[#9ab]">{children}</div>
      </div>
    </li>
  );
}

/** A keyboard/mouse cheat-sheet row. */
function Key({ keys, action }: { keys: string; action: string }): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-2 py-0.5">
      <kbd className="rounded border border-[#2a3444] bg-[#0e1219] px-1.5 py-0.5 font-mono text-[11px] text-[#cfe]">
        {keys}
      </kbd>
      <span className="text-[12px] text-[#9ab]">{action}</span>
    </div>
  );
}

export function Welcome(): React.JSX.Element | null {
  const open = useWelcome((s) => s.open);
  const dontShow = useWelcome((s) => s.dontShow);
  const close = useWelcome((s) => s.close);
  const setDontShow = useWelcome((s) => s.setDontShow);

  // Esc closes the overlay (without changing the don't-show preference beyond the box).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, close]);

  if (!open) return null;

  return (
    <div
      data-testid="welcome"
      role="dialog"
      aria-modal="true"
      aria-label="Welcome to Plastiq"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onClick={close} // click the backdrop to dismiss
    >
      <div
        className="max-h-[90vh] w-full max-w-2xl overflow-auto rounded-lg border border-[#2a3444] bg-[#0e1219] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between border-b border-[#222a36] px-6 py-4">
          <div className="flex items-start gap-3">
            <img src="/plastiq.svg" alt="" aria-hidden="true" className="mt-0.5 h-10 w-auto" />
            <div>
              <div className="mb-0.5 text-[9px] font-bold uppercase tracking-[0.24em] text-[#7fb4ff]">
                Local-first CAD studio
              </div>
              <h1 className="text-lg font-bold text-[#eaf2ff]">Welcome to Plastiq</h1>
              <p className="text-[13px] text-[#9ab]">
                Sketch precise profiles, build parametric solids, assemble mechanisms, simulate
                motion, and turn physical captures into editable CAD—without leaving your machine.
              </p>
            </div>
          </div>
          <button
            type="button"
            data-testid="welcome-close-x"
            aria-label="Close"
            onClick={close}
            className="rounded px-2 text-lg leading-none text-[#789] hover:bg-[#1b2230] hover:text-[#cfe]"
          >
            ×
          </button>
        </div>

        <div className="space-y-5 px-6 py-5">
          <section>
            <h2 className="mb-2 text-xs font-bold uppercase tracking-wide text-[#7fb4ff]">
              Get started in 3 steps
            </h2>
            <ol className="space-y-3">
              <Step n={1} title="Pick a workspace">
                Use the switcher in the top bar to choose <b>Design</b> (model parts),{" "}
                <b>Assemble</b> (combine + mate parts), or <b>Simulate</b> (run physics). Each
                workspace swaps the left sidebar to just the tools it needs.
              </Step>
              <Step n={2} title="Sketch a profile">
                In Design, open <b>New Sketch</b> from the sidebar (pick a plane or a flat face),
                draw with the Line / Rectangle / Circle tools, then add dimensions and constraints
                to set exact sizes. Click <b>Finish</b> when the profile is closed.
              </Step>
              <Step n={3} title="Turn it into a solid">
                Run <b>Extrude</b>, <b>Cut</b>, or <b>Revolve</b> on the profile. An on-screen
                handle appears — <b>drag the arrow or type a value</b> to set the size live, then
                confirm with ✓ (Enter) or cancel with ✕ (Esc). Edit any feature later from the
                feature tree.
              </Step>
            </ol>
          </section>

          <section>
            <h2 className="mb-2 text-xs font-bold uppercase tracking-wide text-[#7fb4ff]">
              Navigate &amp; select
            </h2>
            <ul className="list-disc space-y-1 pl-5 text-[13px] leading-snug text-[#9ab]">
              <li>
                <b>Orbit</b> with a left-drag, <b>pan</b> with a middle-drag, <b>zoom</b> with the
                scroll wheel. Click the <b>view cube</b> (top-right of the viewport) to snap to a
                standard view, or use the named views in the Inspect panel.
              </li>
              <li>
                Switch what you select with keys <b>1–4</b> (face / edge / vertex / body), then
                click geometry. <b>Right-click</b> anything for a context menu of actions.
              </li>
              <li>
                Inspect with <b>Section</b> (clip the model with a draggable plane) and{" "}
                <b>Measure</b>; mass properties show in the Properties panel.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="mb-2 text-xs font-bold uppercase tracking-wide text-[#7fb4ff]">
              Generate with AI
            </h2>
            <ul className="list-disc space-y-1 pl-5 text-[13px] leading-snug text-[#9ab]">
              <li>
                Open the <b>Generate (AI)</b> panel (left sidebar) or press <b>Ctrl/⌘ + K</b> for
                the command palette, then describe a part — e.g. “a 40×20×10&nbsp;mm bracket with a
                5&nbsp;mm fillet on the top edges”. The model builds it and you can keep editing by
                asking for changes.
              </li>
              <li>
                Pick a provider on first run: <b>local Ollama</b> (no key, offline) or{" "}
                <b>Anthropic Claude</b>. Keys stay in your browser. Attach an image to use as a
                reference (vision model) or to generate a mesh from it.
              </li>
              <li>
                Cloud 3D/image generation is <b>paid</b> and always asks you to confirm first; a
                generated mesh can be <b>converted to editable CAD</b> when the reconstruction
                service is running.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="mb-2 text-xs font-bold uppercase tracking-wide text-[#7fb4ff]">
              Keyboard &amp; mouse
            </h2>
            <div className="grid grid-cols-1 gap-x-8 sm:grid-cols-2">
              <Key keys="1 / 2 / 3 / 4" action="Select face / edge / vertex / body" />
              <Key keys="Left-drag" action="Orbit the camera" />
              <Key keys="Esc" action="Clear selection / cancel" />
              <Key keys="Middle-drag" action="Pan the view" />
              <Key keys="Ctrl/⌘ + Z" action="Undo" />
              <Key keys="Scroll" action="Zoom to cursor" />
              <Key keys="Ctrl/⌘ + Shift + Z" action="Redo" />
              <Key keys="Right-click" action="Context menu" />
              <Key keys="Ctrl/⌘ + K" action="Command palette / AI prompt" />
            </div>
          </section>
        </div>

        <div className="flex items-center justify-between border-t border-[#222a36] px-6 py-3">
          <label className="flex items-center gap-2 text-[13px] text-[#9ab]">
            <input
              type="checkbox"
              data-testid="welcome-dont-show"
              checked={dontShow}
              onChange={(e) => setDontShow(e.currentTarget.checked)}
            />
            Don&apos;t show this again
          </label>
          <button
            type="button"
            data-testid="welcome-dismiss"
            onClick={close}
            className="rounded border border-[#3a6ea5] bg-[#13243a] px-4 py-1.5 text-sm font-semibold text-[#bfe0ff] hover:bg-[#1a2f49]"
          >
            Get started
          </button>
        </div>
      </div>
    </div>
  );
}
