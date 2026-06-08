import { defineConfig, devices } from "@playwright/test";

// Plastiq end-to-end tests (SPEC-5). The `plastiq` project drives the real
// React + three.js editor in a browser: the geometry Web Worker runs real OCCT
// (opencascade.js), the sketch solver runs real planegcs, and Simulate runs the
// real physics layer — no mocks. The dev server is the app's own Vite.
export default defineConfig({
  testDir: "./e2e/plastiq",
  testMatch: /e2e\/plastiq\//,
  // Generous: the first run compiles the app and loads the ~50 MB OCCT wasm.
  timeout: 240_000,
  fullyParallel: false,
  workers: 1,
  // On CI, retry transient failures. The heavy specs spawn real OCCT + physics
  // wasm in one tab; on a constrained CI runner the renderer can momentarily lose
  // its execution context ("context destroyed") mid-spawn. The test logic is
  // deterministic — a fresh-page retry absorbs the environmental hiccup.
  retries: process.env.CI ? 2 : 0,
  // In CI also emit an HTML report (uploaded as a CI artifact on failure).
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: "http://localhost:4177",
    launchOptions: { args: ["--no-sandbox"] },
    // Seed the "welcome screen already dismissed" flag so the first-run how-to
    // overlay never covers the editor during tests (the welcome.spec overrides this
    // with an empty state to exercise the first-run flow itself).
    storageState: "./e2e/.storage.json",
    // Capture diagnostics for failing runs (collected under test-results/).
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "plastiq", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "pnpm --filter @plastiq/app exec vite --port 4177 --strictPort",
    url: "http://localhost:4177",
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
