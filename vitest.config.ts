import { defineConfig } from "vitest/config";

// Shared root Vitest config for the Plastiq workspace (app + vendored packages).
export default defineConfig({
  test: {
    // Default env is node — the OCCT/sim wasm suites load wasm from the filesystem
    // and require it. React component tests opt into jsdom per-file with a
    // `// @vitest-environment jsdom` docblock, so they coexist with the wasm suites
    // without forcing jsdom (and its globals) on everything.
    environment: "node",
    include: [
      "apps/**/src/**/*.{test,spec}.{ts,tsx}",
      "packages/**/src/**/*.{test,spec}.{ts,tsx}",
      "packages/**/test/**/*.{test,spec}.{ts,tsx}",
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
        "packages/nerf/src/index.ts",
        "packages/nurbs/src/index.ts",
        "packages/photogrammetry/src/index.ts",
        "packages/cad/src/index.ts",
        "packages/cad/src/action/index.ts",
        "packages/cad/src/lower/index.ts",
        // Code the node unit-runner CANNOT execute — it runs only in the
        // Playwright e2e suite (a real browser): the bootstrap + WebGL viewport
        // island (main → App → Viewport → Viewport3D/Scene needs a real canvas,
        // GPU context, and the geometry worker), the geometry worker entry, and
        // the IndexedDB binding. Counting them here would report false-0% for
        // code that IS covered by e2e. Listed by path, NOT a blanket **/*.tsx:
        // every other .tsx component (panels, ribbon widgets, gizmos, Sketcher,
        // ViewCube, three/ scene components, ...) has jsdom component tests and
        // stays measured.
        "apps/*/src/main.tsx",
        "apps/*/src/app/App.tsx",
        "apps/*/src/three/Viewport.tsx",
        "apps/*/src/three/Viewport3D.tsx",
        "apps/*/src/three/Scene.tsx",
        "apps/*/src/worker/geometry.worker.ts",
        "apps/*/src/persistence/idb.ts",
        // Headless generation CLI entry — pure argv + filesystem IO + process.exit;
        // the logic it drives (headless/nodeBuild, headless/generate) is unit-tested
        // (headless/generate.test.ts). Same rationale as the worker entry above.
        "apps/*/src/headless/cli.ts",
        // r3f viewport runtime that needs a real WebGL context (e2e-only), same
        // rationale as SceneController: GPU-id render-target picking + the colour
        // constants. Pure-logic three/ modules (e.g. sketch-camera math) stay IN.
        "apps/*/src/three/gpuPick.ts",
        "apps/*/src/three/colors.ts",
        // Context-menu input glue: binds the canvas `contextmenu` event to the
        // store via useThree/Picker/GpuPicker — only runs in a real browser
        // (e2e). The pure modules it drives (snapshot/contextSelection/
        // contextOptions/config/contextMenuProvider) stay measured + unit-tested.
        "apps/*/src/three/contextmenu/useCanvasRightClick.ts",
      ],
      // Baseline floor, set a couple points below the measured current
      // (stmts 81.3 / branch 68.8 / funcs 81.3 / lines 83.8) so the build fails
      // on a real coverage regression while tolerating sub-2% run-to-run noise.
      // Measured with the React/R3F .tsx layer INCLUDED (the old blanket
      // **/*.tsx exclusion measured 82.5 / 70.5 / 83.1 / 85.9 — honest cost of
      // counting the component layer: ~1-2 points per metric). Ratchet these up
      // as the remaining gaps (simulator class, spline2d, PaidJobConfirmModal)
      // get tests.
      thresholds: {
        statements: 79,
        branches: 67,
        functions: 79,
        lines: 82,
      },
    },
  },
});
