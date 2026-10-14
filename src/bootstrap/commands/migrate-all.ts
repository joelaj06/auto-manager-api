import {
  migrateTemplateAndTenants,
  type TenantMigrationReport,
} from "../../platform/tenancy/schema-migrations.js";
import type { AppConfig } from "../../shared/config/config.js";
import { loadMigrationSets } from "../../shared/db/migrations/migration-files.js";
import { migrateDatabase, type MigrateResult } from "../../shared/db/migrations/migrator.js";
import { databaseServices } from "../database.js";

export type MigrateAllReport = Readonly<{
  platform: MigrateResult;
  tenants: TenantMigrationReport;
}>;

/** Platform database first, then the tenant template, then every tenant database. */
export async function migrateAll(
  config: AppConfig,
  log: (message: string) => void,
  options: { concurrency?: number } = {},
): Promise<MigrateAllReport> {
  const migrations = await loadMigrationSets(config.database.migrationsDir);
  const { connectAsMigrator } = databaseServices(config);

  const platformClient = await connectAsMigrator(config.database.platformDatabase);
  try {
    const platform = await migrateDatabase(platformClient, migrations.platform, { log });
    log(
      `platform ${config.database.platformDatabase}: ${platform.applied.length} applied, at ${platform.currentVersion ?? "(none)"}`,
    );

    const tenants = await migrateTemplateAndTenants({
      platform: platformClient,
      connectAsMigrator,
      templateDatabase: config.database.tenantTemplateDatabase,
      migrations: migrations.tenant,
      ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
      log,
    });
    return { platform, tenants };
  } finally {
    await platformClient.end();
  }
}
