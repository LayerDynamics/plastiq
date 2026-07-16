import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev harness for the @plastiq/recm library. `pnpm --filter @plastiq/recm dev`
// serves index.html → src/main.tsx → src/App.tsx, a self-contained playground
// that drives the menu engine (manager, context pipeline, ring expansion, theme
// presets, live config) with no 3D/WebGL dependency so it runs anywhere.
export default defineConfig({
  plugins: [react()],
});
