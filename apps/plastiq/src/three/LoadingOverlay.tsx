// Viewport loading affordance (Review #17): a visible overlay while the wasm
// kernel boots and during long rebuilds — the status-bar word alone is easy to
// miss. Driven by the cad store's rebuild status (three/Viewport.tsx flow):
//   • "loading"  — the store's initial state, before the first build kicks off
//     (the OCCT wasm is still coming up) → show immediately;
//   • "building" — a rebuild is in flight → show only after 300 ms, so a fast
//     parametric rebuild doesn't flash the overlay every drag tick;
//   • anything else ("ready", "empty", "rebuild failed: …") → hide.
// pointer-events-none: the overlay must never block orbiting under it.

import { useEffect, useState } from "react";
import { useCadStore } from "../store/store.js";

/** Builds shorter than this never show the overlay (flicker guard). */
export const BUILD_OVERLAY_DELAY_MS = 300;

export function LoadingOverlay(): React.JSX.Element | null {
  const status = useCadStore((s) => s.status);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (status === "loading") {
      setVisible(true);
      return;
    }
    if (status === "building") {
      // Keep an already-visible overlay up (boot flows loading → building);
      // otherwise arm the flicker-guard timer.
      const t = setTimeout(() => setVisible(true), BUILD_OVERLAY_DELAY_MS);
      return () => clearTimeout(t);
    }
    setVisible(false);
    return;
  }, [status]);

  if (!visible) return null;
  return (
    <div
      data-testid="viewport-loading"
      className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-black/25"
    >
      <div className="flex items-center gap-2 rounded border border-[#2a3444] bg-[#0e1219]/90 px-3 py-2 text-xs text-[#9ab] shadow-xl">
        <span
          className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-[#4ea1ff] border-t-transparent"
          aria-hidden
        />
        <span>{status === "loading" ? "Loading geometry kernel…" : "Rebuilding…"}</span>
      </div>
    </div>
  );
}
