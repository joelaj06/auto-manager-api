import type pg from "pg";
import type { Migration } from "../../shared/db/migrations/migration-files.js";
import { migrateDatabase, type MigrateResult } from "../../shared/db/migrations/migrator.js";
import type { Queryable } from "../../shared/db/types.js";
import { mapWithConcurrency } from "../../shared/kernel/async.js";

export type TenantMigrationFailure = Readonly<{
  tenantId: string;
  databaseName: string;
  error: string;
}>;

export type TenantMigrationReport = Readonly<{
  template: MigrateResult;
  tenantsMigrated: number;
  tenantsUpToDate: number;
  failures: TenantMigrationFailure[];
}>;

export type MigrateTenantsOptions = Readonly<{
  /** Platform database handle with write access to tenant_schema_status (migrator). */
  platform: Queryable;
  connectAsMigrator: (database: string) => Promise<pg.Client>;
  templateDatabase: string;
  migrations: readonly Migration[];
  /** Tenant databases migrated in parallel. */
  concurrency?: number;
  log?: (message: string) => void;
}>;

type TenantRow = { id: string; database_name: string };

async function migrateOne(
  connect: () => Promise<pg.Client>,
  migrations: readonly Migration[],
): Promise<MigrateResult> {
  const client = await connect();
  try {
    return await migrateDatabase(client, migrations);
  } finally {
    await client.end();
  }
}

/**
 * Migrates the template first (new tenants are cloned from it), then every tenant database with
 * bounded concurrency. A failing tenant does not stop the others; each result is recorded in
 * platform.tenant_schema_status so failures are visible and retryable.
 */
export async function migrateTemplateAndTenants(
  options: MigrateTenantsOptions,
): Promise<TenantMigrationReport> {
  const log = options.log ?? (() => undefined);

  const template = await migrateOne(
    () => options.connectAsMigrator(options.templateDatabase),
    options.migrations,
  );
  log(
    `template ${options.templateDatabase}: ${template.applied.length} applied, at ${template.currentVersion ?? "(none)"}`,
  );

  const { rows: tenants } = await options.platform.query<TenantRow>(
    `select id::text as id, database_name from tenants
     where database_name is not null
     order by created_at, id`,
  );

  let tenantsMigrated = 0;
  let tenantsUpToDate = 0;
  const failures: TenantMigrationFailure[] = [];

  await mapWithConcurrency(tenants, options.concurrency ?? 4, async (tenant) => {
    try {
      const result = await migrateOne(
        () => options.connectAsMigrator(tenant.database_name),
        options.migrations,
      );
      if (result.applied.length > 0) tenantsMigrated += 1;
      else tenantsUpToDate += 1;
      await options.platform.query(
        `insert into tenant_schema_status (tenant_id, schema_version, status, error, updated_at)
         values ($1, $2, 'ok', null, now())
         on conflict (tenant_id) do update
           set schema_version = excluded.schema_version, status = 'ok', error = null,
               updated_at = now()`,
        [tenant.id, result.currentVersion],
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ tenantId: tenant.id, databaseName: tenant.database_name, error: message });
      await options.platform.query(
        `insert into tenant_schema_status (tenant_id, schema_version, status, error, updated_at)
         values ($1, null, 'failed', $2, now())
         on conflict (tenant_id) do update
           set status = 'failed', error = excluded.error, updated_at = now()`,
        [tenant.id, message],
      );
      log(`tenant ${tenant.id} (${tenant.database_name}) failed: ${message}`);
    }
  });

  log(
    `tenants: ${tenantsMigrated} migrated, ${tenantsUpToDate} up to date, ${failures.length} failed`,
  );
  return { template, tenantsMigrated, tenantsUpToDate, failures };
}
