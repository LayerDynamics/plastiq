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
  },
});
