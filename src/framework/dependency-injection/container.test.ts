import { describe, expect, it } from "vitest";
import type { ApiRoute } from "../../adapters/routes/ApiRoute.js";
import { isPermissionKey } from "../../application/authorization/permissionCatalog.js";
import { isPlatformPermissionKey } from "../../application/authorization/platformPermissionCatalog.js";
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

  it("declares access on every route, with permissions from the catalogue", async () => {
    const container = createContainer(testConfig(), await MigrationSets.load("db/migrations"));
    try {
      const routes = container.get<ApiRoute[]>(TYPES.ApiRoutes);
      expect(routes.length).toBeGreaterThan(0);
      for (const route of routes) {
        const name = `${route.method.toUpperCase()} ${route.path}`;
        expect(["public", "tenant", "authenticated", "platform"], name).toContain(
          route.access.kind,
        );
        if (route.access.kind === "authenticated" && route.access.permission !== null) {
          expect(isPermissionKey(route.access.permission), name).toBe(true);
        }
        if (route.access.kind === "platform" && route.access.permission !== null) {
          expect(isPlatformPermissionKey(route.access.permission), name).toBe(true);
        }
        // Console routes live under /api/platform/ only, and nothing tenant-facing lives there.
        if (route.access.kind === "platform")
          expect(route.path, name).toMatch(/^\/api\/platform\//);
        if (route.path.startsWith("/api/platform/")) {
          expect(["platform", "public"], name).toContain(route.access.kind);
        }
        if (route.access.kind === "public") {
          // Public routes are an explicit, short list; anything else must be tenant-scoped.
          expect(route.path, name).toMatch(
            /^\/health\/|^\/api\/v1\/openapi\.json$|^\/api\/platform\/v1\/auth\/|^\/api\/v1\/applications|^\/api\/v1\/public\/|^\/api\/v1\/auth\/discover$/,
          );
        }
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
