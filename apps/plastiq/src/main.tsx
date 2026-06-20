// CAD Studio entrypoint (SPEC-5): mounts the React editor shell.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { initSketchSolver } from "@plastiq/cad";
// Vite-resolved URL of the planegcs (sketch solver) wasm.
import planegcsWasmUrl from "@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url";
import { App } from "./app/App.js";
import { useCadStore } from "./store/store.js";
import { useSketchStore } from "./sketch/sketchStore.js";
import { useProjectsStore } from "./persistence/projectsStore.js";
import { useAiStore } from "./ai/aiStore.js";
import { defaultDocument } from "./store/seed.js";
import "./index.css";

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

// Expose the stores for strict E2E driving (the sketch slice / document /
// projects), the same test seam as the three.js scene. Harmless in production.
(globalThis as { __sketchStore?: typeof useSketchStore }).__sketchStore = useSketchStore;
(globalThis as { __cadStore?: typeof useCadStore }).__cadStore = useCadStore;
(globalThis as { __projectsStore?: typeof useProjectsStore }).__projectsStore = useProjectsStore;
(globalThis as { __aiStore?: typeof useAiStore }).__aiStore = useAiStore;

const root = document.getElementById("root");
if (!root) throw new Error("CAD Studio: #root element missing");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
