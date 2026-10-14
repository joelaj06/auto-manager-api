import { setTimeout as sleep } from "node:timers/promises";
import pg from "pg";
import { TenantDatabaseMismatchError, PgErrorCodes, pgErrorCode } from "../../shared/db/errors.js";
import { InvalidTenantIdError, isUuid } from "../../shared/db/naming.js";
import { DATABASE_GROUP_ROLES } from "../../shared/db/types.js";

export type TenantDatabaseFactoryOptions = Readonly<{
  /** Opens a connection as the migrator role to the given database. */
  connectAsMigrator: (database: string) => Promise<pg.Client>;
  /** Database the migrator connects to for CREATE DATABASE (the platform database). */
  maintenanceDatabase: string;
  templateDatabase: string;
  databaseNameFor: (tenantId: string) => string;
  /** Retries while another session holds the template (e.g. a migration is running). */
  templateBusyRetries?: number;
}>;

export type CreatedTenantDatabase = Readonly<{ databaseName: string; created: boolean }>;

const ident = (name: string) => pg.escapeIdentifier(name);

/**
 * Creates a tenant database by cloning the fully migrated template, locks CONNECT down to the
 * tenant app role and stamps tenant_info with the tenant id.
 *
 * Idempotent: if the database already exists it is verified and stamped (if empty), never
 * recreated. There is intentionally no delete operation (tenants are never deleted).
 */
export class TenantDatabaseFactory {
  readonly #options: TenantDatabaseFactoryOptions;

  constructor(options: TenantDatabaseFactoryOptions) {
    this.#options = options;
  }

  async create(tenantId: string): Promise<CreatedTenantDatabase> {
    if (!isUuid(tenantId)) throw new InvalidTenantIdError();
    const id = tenantId.toLowerCase();
    const databaseName = this.#options.databaseNameFor(id);

    const created = await this.#cloneTemplate(databaseName);
    await this.#stamp(id, databaseName);
    return { databaseName, created };
  }

  async #cloneTemplate(databaseName: string): Promise<boolean> {
    const maintenance = await this.#options.connectAsMigrator(this.#options.maintenanceDatabase);
    const retries = this.#options.templateBusyRetries ?? 5;
    try {
      let created = false;
      for (let attempt = 0; ; attempt += 1) {
        try {
          await maintenance.query(
            `create database ${ident(databaseName)} template ${ident(this.#options.templateDatabase)}`,
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
        `grant connect on database ${ident(databaseName)} to ${ident(DATABASE_GROUP_ROLES.tenantReadWrite)}`,
      );
      return created;
    } finally {
      await maintenance.end();
    }
  }

  async #stamp(tenantId: string, databaseName: string): Promise<void> {
    const client = await this.#options.connectAsMigrator(databaseName);
    try {
      await client.query(
        "insert into tenant_info (tenant_id) values ($1) on conflict (singleton) do nothing",
        [tenantId],
      );
      const { rows } = await client.query<{ tenant_id: string }>(
        "select tenant_id::text as tenant_id from tenant_info",
      );
      const actual = rows[0]?.tenant_id ?? null;
      if (actual !== tenantId) {
        throw new TenantDatabaseMismatchError(tenantId, actual, databaseName);
      }
    } finally {
      await client.end();
    }
  }
}
