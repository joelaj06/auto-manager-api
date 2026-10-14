import type pg from "pg";
import { mapWithConcurrency } from "../../concurrency/mapWithConcurrency.js";
import type { Queryable } from "../postgres/Queryable.js";
import type { MigrationCatalog } from "./MigrationCatalog.js";
import type { MigrateResult, MigrationRunner } from "./MigrationRunner.js";

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

export type TenantSchemaMigratorOptions = Readonly<{
  /** Opens a migrator-role connection to the given database. */
  connect: (database: string) => Promise<pg.Client>;
  templateDatabase: string;
  /** Tenant databases migrated in parallel. */
  concurrency?: number;
  log?: (message: string) => void;
}>;

type TenantRow = { id: string; database_name: string };

/**
 * Migrates the tenant template first (new tenants are cloned from it), then every tenant
 * database with bounded concurrency. A failing tenant does not stop the others; each result is
 * recorded in the platform's tenant_schema_status table so failures are visible and retryable.
 */
export class TenantSchemaMigrator {
  constructor(
    private readonly runner: MigrationRunner,
    private readonly options: TenantSchemaMigratorOptions,
  ) {}

  /** `platform` is a platform-database handle with write access to tenant_schema_status. */
  async migrate(platform: Queryable, catalog: MigrationCatalog): Promise<TenantMigrationReport> {
    const log = this.options.log ?? (() => undefined);

    const template = await this.migrateDatabase(this.options.templateDatabase, catalog);
    log(
      `template ${this.options.templateDatabase}: ${template.applied.length} applied, at ${template.currentVersion ?? "(none)"}`,
    );

    const { rows: tenants } = await platform.query<TenantRow>(
      `select id::text as id, database_name from tenants
       where database_name is not null
       order by created_at, id`,
    );

    let tenantsMigrated = 0;
    let tenantsUpToDate = 0;
    const failures: TenantMigrationFailure[] = [];

    await mapWithConcurrency(tenants, this.options.concurrency ?? 4, async (tenant) => {
      try {
        const result = await this.migrateDatabase(tenant.database_name, catalog);
        if (result.applied.length > 0) tenantsMigrated += 1;
        else tenantsUpToDate += 1;
        await platform.query(
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
        await platform.query(
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

  private async migrateDatabase(
    database: string,
    catalog: MigrationCatalog,
  ): Promise<MigrateResult> {
    const client = await this.options.connect(database);
    try {
      return await this.runner.migrate(client, catalog);
    } finally {
      await client.end();
    }
  }
}
