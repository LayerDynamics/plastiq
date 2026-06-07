// CAD Studio app shell (SPEC-5 FR-4): the editor layout — top toolbar, left
// feature-tree panel, center viewport, right properties panel, bottom status
// bar. Panels are real layout regions; their live content is filled in by later
// milestones (viewport = M0.5/three.js, feature tree = M2, properties = M2).

import { useEffect, useRef, useState } from "react";
import { Ribbon } from "../ribbon/Ribbon.js";
import { StatusBar } from "./StatusBar.js";
import { FeatureTree } from "./FeatureTree.js";
import { AssemblyTree } from "./AssemblyTree.js";
import { PropertiesPanel } from "./PropertiesPanel.js";
import { Viewport } from "../three/index.js";
import { Sketcher } from "../sketch/Sketcher.js";
import { useCadStore } from "../store/store.js";
import { useProjectsStore } from "../persistence/projectsStore.js";
import type { SelectionMode } from "../store/types.js";

/** Crash-recovery prompt (FR-40): shown when a dirty autosave snapshot from a
 * previous session is found at startup. */
function RecoveryBanner(): React.JSX.Element | null {
  const recoverable = useProjectsStore((s) => s.recoverable);
  const recover = useProjectsStore((s) => s.recover);
  const dismiss = useProjectsStore((s) => s.dismissRecovery);
  if (!recoverable) return null;
  const when = new Date(recoverable.savedAt).toLocaleString();
  return (
    <div
      data-testid="recovery-banner"
      role="alert"
      className="flex items-center gap-3 border-b border-[#7a6a2a] bg-[#241f0c] px-3 py-1.5 text-xs text-[#ffe39a]"
    >
      <span>
        Unsaved work from a previous session ({recoverable.name}, {when}) was recovered.
      </span>
      <button
        type="button"
        data-testid="recovery-restore"
        onClick={recover}
        className="rounded border border-[#7a9a3a] bg-[#1c2a14] px-2 py-0.5 text-[#cfe6a0] hover:bg-[#24341a]"
      >
        Recover
      </button>
      <button
        type="button"
        data-testid="recovery-discard"
        onClick={dismiss}
        className="rounded border border-[#2a3444] px-2 py-0.5 text-[#9ab] hover:bg-[#1b2230]"
      >
        Discard
      </button>
    </div>
  );
}

const MODE_KEYS: Record<string, SelectionMode> = {
  "1": "face",
  "2": "edge",
  "3": "vertex",
  "4": "body",
};

/** Global viewport shortcuts (FR-9): Esc clears selection; 1–4 switch mode. */
function useEditorShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement | null;
      const typing =
        t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
      const store = useCadStore.getState();
      // Undo/redo work everywhere (incl. while focused on the tree); Cmd/Ctrl+Z,
      // Shift+Cmd/Ctrl+Z (or Ctrl+Y) to redo.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) store.redo();
        else store.undo();
        return;
      }
      if (e.ctrlKey && e.key.toLowerCase() === "y") {
        e.preventDefault();
        store.redo();
        return;
      }
      if (typing) return;
      if (e.key === "Escape") store.clearPicks();
      else if (MODE_KEYS[e.key]) store.setSelMode(MODE_KEYS[e.key]!);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/** A draggable splitter that resizes the panel (FR-4). Uses pointer capture so a
 * drag in progress can't leak listeners if the component unmounts. */
function Splitter({ onResize }: { onResize: (dx: number) => void }): React.JSX.Element {
  const last = useRef<number | null>(null);
  return (
    <div
      data-testid="panel-splitter"
      role="separator"
      aria-orientation="vertical"
      onPointerDown={(e) => {
        e.preventDefault();
        last.current = e.clientX;
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (last.current === null) return;
        onResize(e.clientX - last.current);
        last.current = e.clientX;
      }}
      onPointerUp={(e) => {
        last.current = null;
        e.currentTarget.releasePointerCapture(e.pointerId);
      }}
      onLostPointerCapture={() => {
        last.current = null;
      }}
      className="w-1 cursor-col-resize bg-[#222a36] hover:bg-[#4ea1ff]"
    />
  );
}

export function App(): React.JSX.Element {
  useEditorShortcuts();
  const [leftW, setLeftW] = useState(260);
  const [rightW, setRightW] = useState(280);
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);

  const collapseBtn = (onClick: () => void, label: string, glyph: string): React.JSX.Element => (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="rounded px-1 text-xs text-[#789] hover:bg-[#1b2230] hover:text-[#cfe]"
    >
      {glyph}
    </button>
  );

  return (
    <div className="grid h-full grid-cols-1 grid-rows-[auto_1fr_auto] bg-[#0b0d12] text-[#cfe]">
      {/* Ribbon + (optional) recovery banner share one grid row, so the `1fr` row
          is always the viewport. The ribbon is workspace+tab scoped, so it fits the
          width without horizontal scrolling (no overflow-x-auto) — the fix for the
          old dense, scrolling toolbar. */}
      <div className="min-w-0">
        <Ribbon />
        <RecoveryBanner />
      </div>
      <div className="flex min-h-0 min-w-0">
        {leftOpen ? (
          <>
            <aside
              aria-label="Feature tree and assembly"
              style={{ width: leftW }}
              className="min-h-0 shrink-0 overflow-auto border-r border-[#222a36] bg-black/30 p-2"
            >
              <div className="mb-2 flex items-center justify-between">
                <h2 className="text-xs font-bold tracking-wide text-[#8aa]">FEATURE TREE</h2>
                {collapseBtn(() => setLeftOpen(false), "Collapse feature panel", "‹")}
              </div>
              <div id="tree-root">
                <FeatureTree />
              </div>
              <div className="my-3 border-t border-[#222a36]" />
              <AssemblyTree />
            </aside>
            <Splitter onResize={(dx) => setLeftW((w) => clamp(w + dx, 160, 520))} />
          </>
        ) : (
          <button
            type="button"
            data-testid="expand-left"
            aria-label="Expand feature panel"
            title="Expand feature panel"
            onClick={() => setLeftOpen(true)}
            className="w-4 shrink-0 border-r border-[#222a36] bg-black/30 text-xs text-[#789] hover:bg-[#1b2230]"
          >
            ›
          </button>
        )}

        <main id="viewport-root" aria-label="3D viewport" className="relative min-h-0 min-w-0 flex-1">
          <Viewport />
          <Sketcher />
        </main>

        {rightOpen ? (
          <>
            <Splitter onResize={(dx) => setRightW((w) => clamp(w - dx, 160, 520))} />
            <aside
              aria-label="Properties"
              style={{ width: rightW }}
              className="min-h-0 shrink-0 overflow-auto border-l border-[#222a36] bg-black/30 p-2"
            >
              <div className="mb-2 flex items-center justify-between">
                {collapseBtn(() => setRightOpen(false), "Collapse properties panel", "›")}
                <h2 className="text-xs font-bold tracking-wide text-[#8aa]">PROPERTIES</h2>
              </div>
              <div id="properties-root">
                <PropertiesPanel />
              </div>
            </aside>
          </>
        ) : (
          <button
            type="button"
            data-testid="expand-right"
            aria-label="Expand properties panel"
            title="Expand properties panel"
            onClick={() => setRightOpen(true)}
            className="w-4 shrink-0 border-l border-[#222a36] bg-black/30 text-xs text-[#789] hover:bg-[#1b2230]"
          >
            ‹
          </button>
        )}
      </div>
      <StatusBar />
    </div>
  );
}
