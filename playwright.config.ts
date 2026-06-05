import { defineConfig, devices } from "@playwright/test";

// Plastiq end-to-end tests (SPEC-5). The `cad-studio` project drives the real
// React + three.js editor in a browser: the geometry Web Worker runs real OCCT
// (opencascade.js), the sketch solver runs real planegcs, and Simulate runs the
// real physics layer — no mocks. The dev server is the app's own Vite.
export default defineConfig({
  testDir: "./e2e/cad-studio",
  testMatch: /e2e\/cad-studio\//,
  // Generous: the first run compiles the app and loads the ~50 MB OCCT wasm.
  timeout: 240_000,
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://localhost:4177",
    launchOptions: { args: ["--no-sandbox"] },
  },
  projects: [{ name: "cad-studio", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "pnpm --filter @plastiq/cad-studio exec vite --port 4177 --strictPort",
    url: "http://localhost:4177",
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
