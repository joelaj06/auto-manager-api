import { pipeline } from "node:stream/promises";
import pg from "pg";
import type {
  CopyCheck,
  CopyReport,
  ITenantDatabaseMover,
} from "../../../application/ports/ITenantDatabaseMover.js";
import { TenantId } from "../../../domain/value-objects/TenantId.js";
import { countRows, schemaVersionOf } from "../../backup/DatabaseBackupService.js";
import type { PgClientTools } from "../../backup/PgClientTools.js";
import { PostgresIntegrityChecks } from "../../integrity/PostgresIntegrityChecks.js";
import { DATABASE_GROUP_ROLES, tenantRoleOf } from "../postgres/databaseRoles.js";
import type { PostgresConnectionFactory } from "../postgres/PostgresConnectionFactory.js";
import type { TenantDatabaseNaming } from "../postgres/TenantDatabaseNaming.js";
import type { ClusterConnections } from "./ClusterConnections.js";
import { openTenantDatabase, roleExists } from "./PostgresTenantDatabaseRoles.js";

const ident = (name: string) => pg.escapeIdentifier(name);

/**
 * Moves a tenant database between clusters with the PostgreSQL tools (decision 492): the backup
 * role dumps the closed original, the migrator restores it into a new database on the other
 * cluster in one transaction, and the two are compared table by table — row counts, schema
 * version, tenant identity, foreign keys valid and the books intact — before anyone uses it.
 */
export class PostgresTenantDatabaseMover implements ITenantDatabaseMover {
  constructor(
    private readonly deps: Readonly<{
      clusters: ClusterConnections;
      naming: TenantDatabaseNaming;
      tools: PgClientTools;
      /** The database the migrator connects to for CREATE and DROP DATABASE on every cluster. */
      maintenanceDatabase: string;
      /** The app's login role, whose sessions a close ends. */
      tenantUser: string;
    }>,
  ) {}

  async close(tenantId: string, clusterId: string): Promise<void> {
    const name = this.nameOf(tenantId);
    await this.onMaintenance(clusterId, async (client) => {
      const own = tenantRoleOf(name);
      await client.query(
        `revoke connect on database ${ident(name)} from ${ident(DATABASE_GROUP_ROLES.tenantReadWrite)}`,
      );
      if (await roleExists(client, own))
        await client.query(`revoke connect on database ${ident(name)} from ${ident(own)}`);
      await client.query(
        `select pg_terminate_backend(pid) from pg_stat_activity
          where datname = $1 and usename = any($2) and pid <> pg_backend_pid()`,
        [name, [this.deps.tenantUser, own]],
      );
    });
  }

  async open(tenantId: string, clusterId: string): Promise<void> {
    const name = this.nameOf(tenantId);
    await this.onMaintenance(clusterId, async (client) => {
      await openTenantDatabase(client, name);
    });
  }

  async copy(tenantId: string, from: string, to: string): Promise<CopyReport> {
    const name = this.nameOf(tenantId);
    const source = await this.deps.clusters.on(from);
    const target = await this.deps.clusters.on(to);
    await this.onMaintenance(to, async (client) => {
      await client.query(`drop database if exists ${ident(name)} with (force)`);
      await client.query(`create database ${ident(name)} template template0`);
      // Nobody but the migrator until the copy is checked and opened.
      await client.query(`revoke connect, temporary on database ${ident(name)} from public`);
    });

    const dump = this.deps.tools.dump(source.settings("backup", name));
    const restore = this.deps.tools.restore(target.settings("migrator", name));
    await Promise.all([pipeline(dump.stream, restore.stream), dump.exited, restore.exited]);
    return this.compare(tenantId, name, source, target);
  }

  async discard(tenantId: string, clusterId: string): Promise<void> {
    const name = this.nameOf(tenantId);
    await this.onMaintenance(clusterId, async (client) => {
      await client.query(`drop database if exists ${ident(name)} with (force)`);
      await client.query(`drop role if exists ${ident(tenantRoleOf(name))}`);
    });
  }

  private async compare(
    tenantId: string,
    name: string,
    source: PostgresConnectionFactory,
    target: PostgresConnectionFactory,
  ): Promise<CopyReport> {
    const original = await source.connect("backup", name);
    const copy = await target.connect("migrator", name);
    try {
      const checks: CopyCheck[] = [];
      const [expected, actual] = await Promise.all([countRows(original), countRows(copy)]);
      const mismatches = [...new Set([...Object.keys(expected), ...Object.keys(actual)])]
        .filter((table) => expected[table] !== actual[table])
        .map(
          (table) => `${table}: ${actual[table] ?? "missing"} (was ${expected[table] ?? "none"})`,
        );
      checks.push({
        name: "row counts",
        passed: mismatches.length === 0,
        detail:
          mismatches.length === 0 ? `${Object.keys(actual).length} tables` : mismatches.join("; "),
      });
      const [was, is] = await Promise.all([schemaVersionOf(original), schemaVersionOf(copy)]);
      checks.push({ name: "schema version", passed: was === is, detail: `${is ?? "none"}` });
      const identity = await copy.query<{ tenant_id: string }>(
        "select tenant_id::text as tenant_id from tenant_info",
      );
      checks.push({ name: "tenant identity", passed: identity.rows[0]?.tenant_id === tenantId });
      const fks = await copy.query<{ invalid: string }>(
        "select count(*) as invalid from pg_constraint where contype = 'f' and not convalidated",
      );
      checks.push({ name: "foreign keys valid", passed: Number(fks.rows[0]?.invalid) === 0 });
      for (const check of await new PostgresIntegrityChecks(() => copy).run())
        checks.push({
          name: `integrity: ${check.name}`,
          passed: check.passed,
          ...(check.detail === null ? {} : { detail: check.detail }),
        });

      const failed = checks.filter((c) => !c.passed);
      if (failed.length > 0)
        throw new Error(
          `The copy differs: ${failed.map((c) => `${c.name}${c.detail === undefined ? "" : ` (${c.detail})`}`).join("; ")}`,
        );
      const size = await copy.query<{ size: string }>(
        "select pg_database_size(current_database()) as size",
      );
      return {
        tables: Object.keys(actual).length,
        rows: Object.values(actual).reduce((a, b) => a + b, 0),
        schemaVersion: is,
        sizeBytes: Number(size.rows[0]?.size ?? 0),
        checks,
      };
    } finally {
      await Promise.allSettled([original.end(), copy.end()]);
    }
  }

  private async onMaintenance(
    clusterId: string,
    work: (client: pg.Client) => Promise<void>,
  ): Promise<void> {
    const client = await (
      await this.deps.clusters.on(clusterId)
    ).connect("migrator", this.deps.maintenanceDatabase);
    try {
      await work(client);
    } finally {
      await client.end();
    }
  }

  private nameOf(tenantId: string): string {
    return this.deps.naming.databaseNameFor(TenantId.from(tenantId));
  }
}
