import type { Container } from "inversify";
import type { AppConfig } from "../../infrastructure/config/config.js";
import type { MigrationSets } from "../../infrastructure/database/migrations/MigrationCatalog.js";
import type {
  MigrateResult,
  MigrationRunner,
} from "../../infrastructure/database/migrations/MigrationRunner.js";
import {
  TenantSchemaMigrator,
  type TenantMigrationReport,
} from "../../infrastructure/database/migrations/TenantSchemaMigrator.js";
import type { PostgresConnectionFactory } from "../../infrastructure/database/postgres/PostgresConnectionFactory.js";
import { TYPES } from "../dependency-injection/types.js";

export type MigrationReport = Readonly<{
  platform: MigrateResult;
  tenants: TenantMigrationReport;
}>;

/** Migrates the platform database, then the tenant template, then every tenant database. */
export class DatabaseMigrationService {
  constructor(
    private readonly config: AppConfig,
    private readonly migrations: MigrationSets,
    private readonly connections: PostgresConnectionFactory,
    private readonly runner: MigrationRunner,
    private readonly log: (message: string) => void,
  ) {}

  static fromContainer(container: Container, log: (message: string) => void) {
    return new DatabaseMigrationService(
      container.get<AppConfig>(TYPES.Config),
      container.get<MigrationSets>(TYPES.MigrationSets),
      container.get<PostgresConnectionFactory>(TYPES.PostgresConnectionFactory),
      container.get<MigrationRunner>(TYPES.MigrationRunner),
      log,
    );
  }

  async migrateAll(options: { concurrency?: number } = {}): Promise<MigrationReport> {
    const db = this.config.database;
    const platformClient = await this.connections.connect("migrator", db.platformDatabase);
    try {
      const platform = await this.runner.migrate(platformClient, this.migrations.platform);
      this.log(
        `platform ${db.platformDatabase}: ${platform.applied.length} applied, at ${platform.currentVersion ?? "(none)"}`,
      );

      const tenantMigrator = new TenantSchemaMigrator(this.runner, {
        connect: (database) => this.connections.connect("migrator", database),
        templateDatabase: db.tenantTemplateDatabase,
        ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
        log: this.log,
      });
      const tenants = await tenantMigrator.migrate(platformClient, this.migrations.tenant);
      return { platform, tenants };
    } finally {
      await platformClient.end();
    }
  }
}
