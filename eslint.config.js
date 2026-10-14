// @ts-check
import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import prettier from "eslint-config-prettier";
import boundaries from "eslint-plugin-boundaries";
import globals from "globals";
import tseslint from "typescript-eslint";

/**
 * Architecture boundaries (docs/03_target_architecture.md §2, docs/04 §2):
 *  - shared/     reusable kernel and infrastructure; depends on nothing else in src
 *  - platform/   control plane (tenants, billing, console); may use shared and a module's public entry
 *  - modules/<m> tenant business modules; may use shared and other modules' public entries,
 *                never the platform (tenant code must not reach the control plane)
 *  - bootstrap/  composition root; may import anything
 * Inside a module: domain ← application ← infrastructure / http (inner layers never import outer ones).
 */
const architecture = {
  plugins: { boundaries },
  settings: {
    "import/resolver": { typescript: { alwaysTryTypes: true } },
    "boundaries/include": ["src/**/*.ts"],
    "boundaries/elements": [
      { type: "bootstrap", pattern: "src/bootstrap", partialMatch: false },
      { type: "shared", pattern: "src/shared", partialMatch: false },
      { type: "platform", pattern: "src/platform", partialMatch: false },
      {
        type: "module-layer",
        pattern: "src/modules/*/*",
        partialMatch: false,
        capture: ["module", "layer"],
        exclusive: true,
      },
      { type: "module-public", pattern: "src/modules/*", partialMatch: false, capture: ["module"] },
    ],
  },
  rules: {
    "boundaries/dependencies": [
      "error",
      {
        default: "allow",
        policies: [
          {
            from: { element: { type: "shared" } },
            disallow: {
              to: {
                element: {
                  types: {
                    anyOf: ["bootstrap", "platform", "module-layer", "module-public"],
                  },
                },
              },
            },
          },
          {
            from: { element: { types: { anyOf: ["module-layer", "module-public"] } } },
            disallow: { to: { element: { types: { anyOf: ["platform", "bootstrap"] } } } },
          },
          {
            from: { element: { type: "platform" } },
            disallow: { to: { element: { types: { anyOf: ["bootstrap", "module-layer"] } } } },
          },
          {
            // A module may only use another module through that module's public entry files.
            from: { element: { types: { anyOf: ["module-layer", "module-public"] } } },
            disallow: {
              to: {
                element: {
                  type: "module-layer",
                  captured: { module: "!{{ from.element.captured.module }}" },
                },
              },
            },
          },
          {
            from: { element: { type: "module-layer", captured: { layer: "domain" } } },
            disallow: {
              to: {
                element: {
                  type: "module-layer",
                  captured: { layer: "{application,infrastructure,http}" },
                },
              },
            },
          },
          {
            from: { element: { type: "module-layer", captured: { layer: "application" } } },
            disallow: {
              to: {
                element: { type: "module-layer", captured: { layer: "{infrastructure,http}" } },
              },
            },
          },
          {
            from: { element: { type: "module-layer", captured: { layer: "infrastructure" } } },
            disallow: { to: { element: { type: "module-layer", captured: { layer: "http" } } } },
          },
        ],
      },
    ],
  },
};

export default defineConfig(
  { ignores: ["dist/**", "coverage/**", "node_modules/**", "docs/**", ".qodo/**"] },
  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        projectService: { allowDefaultProject: ["eslint.config.js"] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      eqeqeq: ["error", "always"],
      "no-console": "error",
    },
  },
  {
    // The bootstrap may print to the console until the logger lands in P0-6.
    files: ["src/bootstrap/**/*.ts"],
    rules: { "no-console": "off" },
  },
  {
    files: ["src/**/*.ts"],
    ...architecture,
  },
  prettier,
);
