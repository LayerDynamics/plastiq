import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

// CAD Studio (SPEC-5): React + three.js editor on @plastiq/cad.
// - @plastiq/sim resolves its wasm via import.meta.url; opencascade.js ships its
//   own wasm loader — both must stay un-pre-bundled.
// - fs.allow ../.. lets Vite serve the wasm artifacts from the repo root
//   (packages/sim/src/pkg + the opencascade.js dist). From apps/plastiq the
//   workspace root is still two levels up, so ../.. remains correct.
// - @plastiq/cad's OCCT init has a `import("opencascade.js/dist/node.js")` branch
//   for Node/CI. The browser never takes it (isNode() === false), but rollup
//   would otherwise bundle that literal dynamic import and choke on its Node
//   built-ins (`path`/`url`). Mark it external so it stays an unreached runtime
//   import in both the main and worker builds.
const occtNode = /opencascade\.js\/dist\/node\.js$/;
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // sql.js is CommonJS — it MUST be pre-bundled for the `import initSqlJs`
  // default-interop to work (its .wasm is resolved separately via ?url). Only
  // opencascade.js / @plastiq/sim are excluded (they ship their own wasm loaders).
  optimizeDeps: {
    exclude: ["@plastiq/sim", "opencascade.js"],
  },
  assetsInclude: ["**/*.wasm"],
  build: {
    rollupOptions: { external: [occtNode] },
  },
  worker: {
    format: "es",
    rollupOptions: { external: [occtNode] },
  },
  server: {
    fs: {
      allow: ["../.."],
    },
  },
});
