import { describe, expect, it } from "vitest";
import { MigrationSets } from "../../infrastructure/database/migrations/MigrationCatalog.js";
import type { TenantConnectionPools } from "../../infrastructure/database/postgres/TenantConnectionPools.js";
import { testConfig } from "../../testing/testDatabase.js";
import { createContainer, disposeContainer } from "./container.js";
import { TYPES } from "./types.js";

/** Resolves every binding without touching a database (pools connect lazily). */
describe("createContainer", () => {
  it("resolves every registered token", async () => {
    const container = createContainer(testConfig(), await MigrationSets.load("db/migrations"));
    try {
      for (const [name, token] of Object.entries(TYPES)) {
        expect(container.get(token), name).toBeDefined();
      }
    } finally {
      await disposeContainer(container);
    }
  });

  it("returns singletons", async () => {
    const container = createContainer(testConfig(), await MigrationSets.load("db/migrations"));
    try {
      expect(container.get(TYPES.UnitOfWork)).toBe(container.get(TYPES.UnitOfWork));
      expect(container.get(TYPES.TenantConnectionPools)).toBe(
        container.get(TYPES.TenantConnectionPools),
      );
    } finally {
      await disposeContainer(container);
    }
  });

  it("closes the tenant pools when disposed", async () => {
    const container = createContainer(testConfig(), await MigrationSets.load("db/migrations"));
    const pools = container.get<TenantConnectionPools>(TYPES.TenantConnectionPools);
    await disposeContainer(container);

    await expect(
      pools.withTransaction({ value: "x" } as never, () => Promise.resolve()),
    ).rejects.toThrow(/closed/);
  });
});
