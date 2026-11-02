import type { ITenantSchemaUpdater } from "../../application/ports/ITenantSchemaUpdater.js";
import { TenantId } from "../../domain/value-objects/TenantId.js";
import type { MigrationCatalog } from "../database/migrations/MigrationCatalog.js";
import type { MigrationRunner } from "../database/migrations/MigrationRunner.js";
import type { ClusterConnections } from "../database/clusters/ClusterConnections.js";
import type { TenantDatabaseNaming } from "../database/postgres/TenantDatabaseNaming.js";

/** Applies pending tenant migrations to one database, on its cluster, as the migrator (idempotent). */
export class MigratorTenantSchemaUpdater implements ITenantSchemaUpdater {
  constructor(
    private readonly clusters: ClusterConnections,
    private readonly naming: TenantDatabaseNaming,
    private readonly runner: MigrationRunner,
    private readonly tenantMigrations: MigrationCatalog,
  ) {}

  async migrate(tenantId: string): Promise<string | null> {
    const connections = await this.clusters.ofTenant(tenantId);
    const client = await connections.connect(
      "migrator",
      this.naming.databaseNameFor(TenantId.from(tenantId)),
    );
    try {
      return (await this.runner.migrate(client, this.tenantMigrations)).currentVersion;
    } finally {
      await client.end();
    }
  }
}
