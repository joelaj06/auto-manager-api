import { setTimeout as sleep } from "node:timers/promises";
import pg from "pg";
import { TenantDatabaseMismatchError } from "../../../application/errors/TenantDatabaseErrors.js";
import type {
  ITenantDatabaseProvisioner,
  ProvisionedTenantDatabase,
} from "../../../application/ports/ITenantDatabaseProvisioner.js";
import type { TenantId } from "../../../domain/value-objects/TenantId.js";
import { DATABASE_GROUP_ROLES } from "../postgres/databaseRoles.js";
import { PgErrorCodes, pgErrorCode } from "../postgres/pgErrors.js";

export type TenantDatabaseProvisionerOptions = Readonly<{
  /** Opens a migrator-role connection to the given database. */
  connect: (database: string) => Promise<pg.Client>;
  /** Database the migrator connects to for CREATE DATABASE (the platform database). */
  maintenanceDatabase: string;
  templateDatabase: string;
  databaseNameFor: (tenantId: TenantId) => string;
  /** Retries while another session holds the template (e.g. a migration is running). */
  templateBusyRetries?: number;
}>;

const ident = (name: string) => pg.escapeIdentifier(name);

/**
 * Creates a tenant database by cloning the fully migrated template, locks CONNECT down to the
 * tenant app role and stamps tenant_info with the tenant id.
 *
 * Idempotent: an existing database is verified and stamped (if empty), never recreated.
 */
export class TenantDatabaseProvisioner implements ITenantDatabaseProvisioner {
  constructor(private readonly options: TenantDatabaseProvisionerOptions) {}

  async provision(tenantId: TenantId): Promise<ProvisionedTenantDatabase> {
    const databaseName = this.options.databaseNameFor(tenantId);
    const created = await this.cloneTemplate(databaseName);
    await this.stamp(tenantId, databaseName);
    return { databaseName, created };
  }

  private async cloneTemplate(databaseName: string): Promise<boolean> {
    const maintenance = await this.options.connect(this.options.maintenanceDatabase);
    const retries = this.options.templateBusyRetries ?? 5;
    try {
      let created = false;
      for (let attempt = 0; ; attempt += 1) {
        try {
          await maintenance.query(
            `create database ${ident(databaseName)} template ${ident(this.options.templateDatabase)}`,
          );
          created = true;
          break;
        } catch (error) {
          const code = pgErrorCode(error);
          if (code === PgErrorCodes.duplicateDatabase) break;
          if (code === PgErrorCodes.objectInUse && attempt < retries) {
            await sleep(200 * 2 ** attempt);
            continue;
          }
          throw error;
        }
      }

      await maintenance.query(
        `revoke connect, temporary on database ${ident(databaseName)} from public`,
      );
      await maintenance.query(
        `grant connect on database ${ident(databaseName)} to ${ident(DATABASE_GROUP_ROLES.tenantReadWrite)}, ${ident(DATABASE_GROUP_ROLES.backupReader)}`,
      );
      return created;
    } finally {
      await maintenance.end();
    }
  }

  private async stamp(tenantId: TenantId, databaseName: string): Promise<void> {
    const client = await this.options.connect(databaseName);
    try {
      await client.query(
        "insert into tenant_info (tenant_id) values ($1) on conflict (singleton) do nothing",
        [tenantId.value],
      );
      const { rows } = await client.query<{ tenant_id: string }>(
        "select tenant_id::text as tenant_id from tenant_info",
      );
      const actual = rows[0]?.tenant_id ?? null;
      if (actual !== tenantId.value) {
        throw new TenantDatabaseMismatchError(tenantId.value, actual, databaseName);
      }
    } finally {
      await client.end();
    }
  }
}
