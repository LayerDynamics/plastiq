// Flat ESLint config for the Plastiq TypeScript workspace.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "e2e/**",
      "**/vendor/**",
      "**/dist/**",
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
