import pg from "pg";
import { TenantDatabaseFactory } from "../platform/tenancy/tenant-database-factory.js";
import type { AppConfig } from "../shared/config/config.js";
import { clientConfig, connectClient, connectionSettings } from "../shared/db/connection.js";
import { tenantDatabaseName } from "../shared/db/naming.js";
import { TenantPoolManager } from "../shared/db/tenant-pools.js";

/** Builds the database services from configuration. Shared by the app and the CLI commands. */
export function databaseServices(config: AppConfig) {
  const db = config.database;
  const databaseNameFor = (tenantId: string) =>
    tenantDatabaseName(db.tenantDatabasePrefix, tenantId);

  const connectAsMigrator = (database: string) =>
    connectClient(connectionSettings(db, db.roles.migrator, database));

  const createPlatformPool = () =>
    new pg.Pool({
      ...clientConfig(connectionSettings(db, db.roles.platform, db.platformDatabase)),
      max: db.platformPoolMax,
    });

  const createTenantPools = (requiredSchemaVersion: string | null) => {
    const { database: _unused, ...connection } = connectionSettings(db, db.roles.tenant, "");
    return new TenantPoolManager({
      connection,
      databaseNameFor,
      maxPools: db.tenantPools.maxPools,
      maxConnectionsPerPool: db.tenantPools.maxConnections,
      idleTimeoutMs: db.tenantPools.idleTimeoutMs,
      statementTimeoutMs: db.statementTimeoutMs,
      requiredSchemaVersion,
    });
  };

  const tenantDatabaseFactory = new TenantDatabaseFactory({
    connectAsMigrator,
    maintenanceDatabase: db.platformDatabase,
    templateDatabase: db.tenantTemplateDatabase,
    databaseNameFor,
  });

  return {
    databaseNameFor,
    connectAsMigrator,
    createPlatformPool,
    createTenantPools,
    tenantDatabaseFactory,
  };
}
