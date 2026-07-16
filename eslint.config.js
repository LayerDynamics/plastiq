// Flat ESLint config for the Plastiq TypeScript workspace.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "e2e/**",
      "**/vendor/**",
      "**/dist/**",
      // Rust build output of the Tauri desktop shell (apps/desktop/src-tauri) —
      // generated JS shims land under target/, never lintable source.
      "**/src-tauri/target/**",
      "**/pkg/**",
      "**/generated/**",
      "**/node_modules/**",
      "**/*.config.js",
      "**/*.config.ts",
      "**/*.mjs",
      "**/*.cjs",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
);
