import type { IOrphanDatabases } from "../../application/ports/IOrphanDatabases.js";
import { TenantId } from "../../domain/value-objects/TenantId.js";
import type { TenantDatabaseNaming } from "../database/postgres/TenantDatabaseNaming.js";
import type { PlatformDb } from "../platform/PlatformDb.js";

/** Databases with the tenant prefix that belong to no tenant record (reported, never dropped). */
export class PostgresOrphanDatabases implements IOrphanDatabases {
  constructor(
    private readonly db: PlatformDb,
    private readonly naming: TenantDatabaseNaming,
    private readonly prefix: string,
  ) {}

  async find(): Promise<string[]> {
    const databases = await this.db.query<{ datname: string }>(
      "select datname from pg_database where starts_with(datname, $1) and not datistemplate order by datname",
      [this.prefix],
    );
    const tenants = await this.db.query<{ id: string }>("select id from tenants");
    const known = new Set(
      tenants.rows.map((t) => this.naming.databaseNameFor(TenantId.from(t.id))),
    );
    return databases.rows.map((r) => r.datname).filter((name) => !known.has(name));
  }
}
