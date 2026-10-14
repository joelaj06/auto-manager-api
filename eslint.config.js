// @ts-check
import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import prettier from "eslint-config-prettier";
import boundaries from "eslint-plugin-boundaries";
import globals from "globals";
import tseslint from "typescript-eslint";

/**
 * Clean Architecture (onion) boundaries — dependencies point inwards only:
 *
 *   domain          entities, value objects, domain services, repository interfaces
 *   application     use cases, ports (interfaces), DTOs, application services   → domain
 *   adapters        controllers, routes, middleware, presenters, validators, workers
 *                                                                         → application, domain
 *   infrastructure  implementations of ports: database, mail, storage, config  → application, domain
 *   framework       composition root (Inversify container), bootstrap, CLI     → anything
 *
 * domain/ and application/ may not import third-party packages at all, so they stay free of
 * frameworks. Production code never imports src/testing (test files may).
 */
const layers = ["domain", "application", "adapters", "infrastructure", "framework", "testing"];

/** Inner layers never depend on outer ones (production code and tests alike). */
const layerPolicies = [
  {
    from: { element: { type: "domain" } },
    disallow: {
      to: { element: { types: { anyOf: ["application", "adapters", "infrastructure"] } } },
    },
  },
  {
    from: { element: { type: "application" } },
    disallow: { to: { element: { types: { anyOf: ["adapters", "infrastructure"] } } } },
  },
  {
    from: { element: { type: "adapters" } },
    disallow: { to: { element: { type: "infrastructure" } } },
  },
  {
    from: { element: { type: "infrastructure" } },
    disallow: { to: { element: { type: "adapters" } } },
  },
];

/** Production code only: tests may use the composition root, test helpers and test libraries. */
const productionOnlyPolicies = [
  {
    from: {
      element: { types: { anyOf: ["domain", "application", "adapters", "infrastructure"] } },
    },
    disallow: { to: { element: { types: { anyOf: ["framework", "testing"] } } } },
  },
];

const boundarySettings = {
  "import/resolver": { typescript: { alwaysTryTypes: true } },
  "boundaries/include": ["src/**/*.ts"],
  "boundaries/elements": layers.map((type) => ({
    type,
    pattern: `src/${type}`,
    partialMatch: false,
  })),
};

/** @param {Record<string, unknown>[]} policies */
const architecture = (policies) => ({
  plugins: { boundaries },
  settings: boundarySettings,
  rules: { "boundaries/dependencies": ["error", { default: "allow", policies }] },
});

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
    // Tests: Vitest matchers (expect.any …) and supertest response bodies are typed as any,
    // and spies are asserted unbound. Production code keeps the strict rules.
    files: ["src/**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/unbound-method": "off",
    },
  },
  {
    // The entry point reports startup failures and CLI commands print results to the console.
    files: ["src/index.ts", "src/framework/**/*.ts"],
    rules: { "no-console": "off" },
  },
  {
    files: ["src/**/*.ts"],
    ignores: ["src/**/*.test.ts"],
    ...architecture([...layerPolicies, ...productionOnlyPolicies]),
  },
  {
    files: ["src/**/*.test.ts"],
    ...architecture(layerPolicies),
  },
  {
    // domain/ and application/ stay framework-free: only relative and node: imports.
    files: ["src/domain/**/*.ts", "src/application/**/*.ts"],
    ignores: ["src/**/*.test.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: "^(?!\\.{1,2}/|node:)",
              message: "domain/ and application/ may not import third-party packages.",
            },
          ],
        },
      ],
    },
  },
  prettier,
);
