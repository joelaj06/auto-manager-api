import type pg from "pg";
import type { TenantDatabaseFactory } from "../platform/tenancy/tenant-database-factory.js";
import type { AppConfig } from "../shared/config/config.js";
import type { TenantPoolManager } from "../shared/db/tenant-pools.js";
import { databaseServices } from "./database.js";

/**
 * Composition root.
 *
 * Every service is created here with plain functions and passed explicitly to the code that
 * needs it — no decorators or reflection (see docs/21_decisions_log.md, decision 62).
 * Later work packages add the logger, job queue, HTTP app and module wiring.
 */
export type AppContainer = Readonly<{
  config: AppConfig;
  db: Readonly<{
    /** Platform (control-plane) database, as the platform app role. */
    platform: pg.Pool;
    /** Per-tenant pools, as the tenant app role. */
    tenants: TenantPoolManager;
    /** Creates tenant databases from the template (used by provisioning, P1-3). */
    tenantDatabases: TenantDatabaseFactory;
  }>;
  close: () => Promise<void>;
}>;

export type ContainerOptions = Readonly<{
  /** Latest tenant migration this build ships; tenants below it are refused (503 in P0-6). */
  requiredTenantSchemaVersion: string | null;
}>;

export function createContainer(config: AppConfig, options: ContainerOptions): AppContainer {
  const services = databaseServices(config);
  // Pools connect lazily, on first query.
  const platform = services.createPlatformPool();
  const tenants = services.createTenantPools(options.requiredTenantSchemaVersion);

  return Object.freeze({
    config,
    db: Object.freeze({ platform, tenants, tenantDatabases: services.tenantDatabaseFactory }),
    close: async () => {
      await Promise.allSettled([tenants.closeAll(), platform.end()]);
    },
  });
}
