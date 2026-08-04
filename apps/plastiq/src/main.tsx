// CAD Studio entrypoint (SPEC-5): mounts the React editor shell — behind a
// boot-time capability check (Review #17): a browser without WebGL2 / wasm /
// storage gets a friendly "unsupported" screen instead of a mid-load crash.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { initSketchSolver } from "@plastiq/cad";
// Vite-resolved URL of the planegcs (sketch solver) wasm.
import planegcsWasmUrl from "@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url";
import { App } from "./app/App.js";
import { ErrorBoundary } from "./app/ErrorBoundary.js";
import { detectCapabilities, renderUnsupportedScreen } from "./app/capabilities.js";
import { installUnsavedGuard } from "./app/unsavedGuard.js";
import { useCadStore } from "./store/store.js";
import { useSketchStore } from "./sketch/sketchStore.js";
import { useProjectsStore } from "./persistence/projectsStore.js";
import { useAiStore } from "./ai/aiStore.js";
import { useVoxelStore } from "./voxel/voxelStore.js";
import { installAiTestSeam } from "./ai/testSeam.js";
import { defaultDocument } from "./store/seed.js";
import "./index.css";

const root = document.getElementById("root");
if (!root) throw new Error("CAD Studio: #root element missing");

const capabilities = detectCapabilities();
if (!capabilities.ok) {
  // No app boot attempt: the missing capability would only crash the editor
  // somewhere deeper (wasm fetch, WebGL context, project store). Name exactly
  // what's missing instead.
  renderUnsupportedScreen(root, capabilities.missing);
} else {
  boot(root);
}

function boot(rootEl: HTMLElement): void {
  // Load the sketch-solver wasm before the editor can sketch (solveSketch is
  // synchronous, so planegcs must already be initialised). It's a small wasm; the
  // heavier OCCT kernel loads lazily in the geometry worker afterwards. The sketch
  // store gates entering the sketcher on this completing (the Sketch button stays
  // disabled until then), so a solve can never race the wasm load.
  void initSketchSolver({ wasmUrl: planegcsWasmUrl }).then(() => {
    useSketchStore.getState().setSolverReady(true);
  });

  // Seed a default model so a fresh session renders geometry immediately (M0.5).
  useCadStore.getState().loadDocument(defaultDocument());

  // Warn before closing a tab with unsaved changes (Review #17). Installed once
  // at module scope — outside React — so StrictMode's double effect-run can't
  // double-register the beforeunload listener.
  installUnsavedGuard();

  // Expose the stores for strict E2E driving (the sketch slice / document /
  // projects), the same test seam as the three.js scene. Harmless in production.
  (globalThis as { __sketchStore?: typeof useSketchStore }).__sketchStore = useSketchStore;
  (globalThis as { __cadStore?: typeof useCadStore }).__cadStore = useCadStore;
  (globalThis as { __projectsStore?: typeof useProjectsStore }).__projectsStore = useProjectsStore;
  (globalThis as { __aiStore?: typeof useAiStore }).__aiStore = useAiStore;
  (globalThis as { __voxelStore?: typeof useVoxelStore }).__voxelStore = useVoxelStore;
  // Model-free AI tool seam (__plastiqAi) for the deterministic pipeline E2E (R2.6/R5.2).
  installAiTestSeam();

  createRoot(rootEl).render(
    <StrictMode>
      {/* A render crash anywhere below shows a recovery screen (the work is
          auto-snapshotted by persistence/recovery.ts) instead of a blank page. */}
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </StrictMode>,
  );
}
