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
        "apps/*/src/**/types.ts",
        // PURE re-export barrels only (a version const at most) — listed by path,
        // NOT a blanket **/index.ts: io/, math/, unit/, and persistence/ index
        // files hold real, tested functions and must stay measured.
        "packages/sim/src/index.ts",
        "packages/cad/src/index.ts",
        "packages/cad/src/action/index.ts",
        "packages/cad/src/lower/index.ts",
        // Code the node unit-runner CANNOT execute — it runs only in the
        // Playwright e2e suite (a real browser): React components, the three.js
        // scene controller, the geometry worker entry, and the IndexedDB binding.
        // Counting them here would report false-0% for code that IS covered by
        // e2e. Pure-logic modules (stores, sim helpers, spline math) stay IN.
        "**/*.tsx",
        "apps/*/src/viewport/SceneController.ts",
        "apps/*/src/worker/geometry.worker.ts",
        "apps/*/src/persistence/idb.ts",
        // r3f viewport runtime that needs a real WebGL context (e2e-only), same
        // rationale as SceneController: GPU-id render-target picking + the colour
        // constants. Pure-logic three/ modules (e.g. sketch-camera math) stay IN.
        "apps/*/src/three/gpuPick.ts",
        "apps/*/src/three/colors.ts",
        // Context-menu input glue: binds the canvas `contextmenu` event to the
        // store via useThree/Picker/GpuPicker — only runs in a real browser
        // (e2e). The pure modules it drives (contextSelection/contextOptions/
        // config/contextMenuProvider) stay measured + unit-tested.
        "apps/*/src/three/contextmenu/useCanvasRightClick.ts",
        "apps/*/src/three/contextmenu/snapshot.ts",
      ],
      // Baseline floor, set a couple points below the measured current
      // (stmts 82.5 / branch 70.5 / funcs 83.1 / lines 85.9) so the build fails
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
