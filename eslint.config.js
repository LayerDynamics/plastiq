// Flat ESLint config for the Plastiq TypeScript workspace.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "e2e/**",
      "**/vendor/**",
      "**/dist/**",
      // `just cad-occt` staging dir: the OCCT builder emits plastiq-occt.js
      // (a minified ~260 KB bundle) here before the recipe copies the products
      // into packages/cad/vendor/occt/. Generated output, never lintable source
      // — linting it is ~345 errors and a red CI. Gitignored too, but .gitignore
      // is not ESLint's ignore list, so it must be named here as well.
      "**/build/occt/**",
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
