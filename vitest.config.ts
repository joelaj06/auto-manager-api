import { defineConfig } from "vitest/config";

/**
 * Two projects:
 *  - unit:        *.test.ts      fast, no external services
 *  - integration: *.int.test.ts  needs real services (PostgreSQL, Redis) from compose.yaml / CI
 */
export default defineConfig({
  test: {
    environment: "node",
    restoreMocks: true,
    unstubEnvs: true,
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["src/**/*.test.ts"],
          exclude: ["src/**/*.int.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          include: ["src/**/*.int.test.ts"],
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
