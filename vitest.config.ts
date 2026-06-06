import { defineConfig } from "vitest/config";

// Shared root Vitest config for the Plastiq workspace (app + vendored packages).
export default defineConfig({
  test: {
    environment: "node",
    include: [
      "apps/**/src/**/*.{test,spec}.ts",
      "packages/**/src/**/*.{test,spec}.ts",
      "packages/**/test/**/*.{test,spec}.ts",
    ],
    exclude: ["**/node_modules/**", "**/dist/**", "**/pkg/**", "e2e/**"],
    // No passWithNoTests: a run that collects zero tests should FAIL, so a
    // broken include glob can't masquerade as green.
    coverage: {
      provider: "v8",
      // Report to the terminal, to HTML (browsable), and to lcov/json for CI tools.
      reporter: ["text-summary", "text", "html", "lcov", "json-summary"],
      reportsDirectory: "coverage",
      // Measure the real first-party source only. `all: true` counts files with
      // zero executed lines too, so dead/untested modules can't hide by simply
      // never being imported in a test.
      all: true,
      include: ["apps/*/src/**/*.{ts,tsx}", "packages/*/src/**/*.ts"],
      exclude: [
        // Test files and type-only declarations carry no coverable logic.
        "**/*.{test,spec}.{ts,tsx}",
        "**/*.d.ts",
        // Type-only / re-export barrels.
        "**/index.ts",
        "apps/*/src/**/types.ts",
        // Code the node unit-runner CANNOT execute — it runs only in the
        // Playwright e2e suite (a real browser): React components, the three.js
        // scene controller, the geometry worker entry, and the IndexedDB binding.
        // Counting them here would report false-0% for code that IS covered by
        // e2e. Pure-logic modules (stores, sim helpers, spline math) stay IN.
        "**/*.tsx",
        "apps/*/src/viewport/SceneController.ts",
        "apps/*/src/worker/geometry.worker.ts",
        "apps/*/src/persistence/idb.ts",
      ],
      // Baseline floor, set a couple points below the measured current
      // (stmts 82.5 / branch 70.6 / funcs 84.1 / lines 86.0) so the build fails
      // on a real coverage regression while tolerating sub-2% run-to-run noise.
      // Ratchet these up as the remaining gaps (projectsStore, simulator class,
      // spline2d) get tests.
      thresholds: {
        statements: 80,
        branches: 68,
        functions: 80,
        lines: 83,
      },
    },
  },
});
