import type { ClusterProbe, IClusterProbe } from "../../../application/ports/IClusterRegistry.js";
import { DATABASE_GROUP_ROLES } from "../postgres/databaseRoles.js";
import type { PostgresConnectionFactory } from "../postgres/PostgresConnectionFactory.js";
import type { ClusterConnections } from "./ClusterConnections.js";

/**
 * A live look at a cluster's server as the migrator: its version, connections, the size of its
 * tenant databases and the template's schema version, and what it lacks to take tenants — the
 * group roles, a template at the release's schema version, the right to create databases and to
 * end the app's sessions (`yarn db:setup` against the server provides them all).
 */
export class PostgresClusterProbe implements IClusterProbe {
  constructor(
    private readonly deps: Readonly<{
      clusters: ClusterConnections;
      factory: PostgresConnectionFactory;
      maintenanceDatabase: string;
      templateDatabase: string;
      tenantDatabasePrefix: string;
      /** The tenant schema version this release needs. */
      requiredTemplateVersion: string | null;
      timeoutMs: number;
    }>,
  ) {}

  async probe(
    server: Readonly<{ id: string } | { host: string; port: number }>,
  ): Promise<ClusterProbe> {
    const { deps } = this;
    const started = Date.now();
    try {
      const connections =
        "id" in server ? await deps.clusters.on(server.id) : deps.factory.at(server);
      const client = await connections.connect("migrator", deps.maintenanceDatabase);
      try {
        await client.query(`set statement_timeout = ${Math.trunc(deps.timeoutMs)}`);
        const { rows } = await client.query<{
          version: string;
          connections: string;
          max_connections: string;
          tenant_bytes: string;
          createdb: boolean;
          createrole: boolean;
          signal: boolean;
          roles: string[];
        }>(
          `select current_setting('server_version') as version,
                  (select count(*) from pg_stat_activity) as connections,
                  current_setting('max_connections') as max_connections,
                  (select coalesce(sum(pg_database_size(datname)), 0) from pg_database
                    where starts_with(datname, $1) and not datistemplate
                      and has_database_privilege(datname, 'connect')) as tenant_bytes,
                  (select rolcreatedb from pg_roles where rolname = current_user) as createdb,
                  (select rolcreaterole from pg_roles where rolname = current_user) as createrole,
                  pg_has_role(current_user, 'pg_signal_backend', 'member') as signal,
                  array(select rolname::text from pg_roles where rolname = any($2::text[])) as roles`,
          [deps.tenantDatabasePrefix, Object.values(DATABASE_GROUP_ROLES)],
        );
        const r = rows[0]!;
        const latencyMs = Date.now() - started;
        const problems: string[] = [];
        const missing = Object.values(DATABASE_GROUP_ROLES).filter((g) => !r.roles.includes(g));
        if (missing.length > 0) problems.push(`Roles missing: ${missing.join(", ")}`);
        if (!r.createdb) problems.push("The migrator cannot create databases");
        if (!r.createrole)
          problems.push("The migrator cannot create tenant logins: run yarn db:setup on it");
        if (!r.signal) problems.push("The migrator cannot end sessions (pg_signal_backend)");
        const templateVersion = await this.templateVersion(connections);
        const required = deps.requiredTemplateVersion;
        if (templateVersion === null) problems.push(`No tenant template ${deps.templateDatabase}`);
        else if (required !== null && templateVersion < required)
          problems.push(`The tenant template is at ${templateVersion}, ${required} is needed`);
        return {
          reachable: true,
          latencyMs,
          serverVersion: r.version,
          connections: Number(r.connections),
          maxConnections: Number(r.max_connections),
          tenantDatabaseBytes: Number(r.tenant_bytes),
          templateVersion,
          problems,
          error: null,
        };
      } finally {
        await client.end();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        reachable: false,
        latencyMs: null,
        serverVersion: null,
        connections: null,
        maxConnections: null,
        tenantDatabaseBytes: null,
        templateVersion: null,
        problems: [`Unreachable: ${message}`],
        error: message,
      };
    }
  }

  private async templateVersion(connections: PostgresConnectionFactory): Promise<string | null> {
    try {
      const client = await connections.connect("migrator", this.deps.templateDatabase);
      try {
        const { rows } = await client.query<{ version: string | null }>(
          "select max(version) as version from schema_migrations",
        );
        return rows[0]?.version ?? null;
      } finally {
        await client.end();
      }
    } catch {
      return null;
    }
  }
}
