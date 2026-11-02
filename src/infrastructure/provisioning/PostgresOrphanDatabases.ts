import pg from "pg";
import type {
  ClusterSweep,
  DatabaseFinding,
  IOrphanDatabases,
} from "../../application/ports/IOrphanDatabases.js";
import { TenantId } from "../../domain/value-objects/TenantId.js";
import type { ClusterConnections } from "../database/clusters/ClusterConnections.js";
import type { TenantDatabaseNaming } from "../database/postgres/TenantDatabaseNaming.js";
import type { PlatformDb } from "../platform/PlatformDb.js";

type Registry = Readonly<{
  /** Tenant id and cluster by database name. */
  byName: ReadonlyMap<string, { tenantId: string; clusterId: string; hasDatabase: boolean }>;
  /** `tenantId:cluster` of completed moves away from a cluster. */
  movedFrom: ReadonlySet<string>;
  /** `tenantId:cluster` of moves under way to a cluster. */
  movingTo: ReadonlySet<string>;
}>;

const ident = (name: string) => pg.escapeIdentifier(name);

/**
 * The orphan sweep (decision 493): every cluster's databases with the tenant prefix against the
 * tenants, their clusters and their moves. A cluster that does not answer is reported, never
 * read as empty, so nothing on it is taken as missing.
 */
export class PostgresOrphanDatabases implements IOrphanDatabases {
  constructor(
    private readonly db: PlatformDb,
    private readonly naming: TenantDatabaseNaming,
    private readonly clusters: ClusterConnections,
    private readonly options: Readonly<{ prefix: string; maintenanceDatabase: string }>,
  ) {}

  async sweep(): Promise<ClusterSweep[]> {
    const registry = await this.registry();
    const sweeps: ClusterSweep[] = [];
    for (const cluster of await this.clusters.clusters()) {
      try {
        const databases = await this.databasesOn(cluster.id);
        sweeps.push({
          clusterId: cluster.id,
          error: null,
          databases: databases.size,
          findings: this.classify(cluster.id, databases, registry),
        });
      } catch (error) {
        sweeps.push({
          clusterId: cluster.id,
          error: error instanceof Error ? error.message : String(error),
          databases: 0,
          findings: [],
        });
      }
    }
    return sweeps;
  }

  async drop(clusterId: string, databaseName: string): Promise<boolean> {
    if (!databaseName.startsWith(this.options.prefix)) return false;
    const databases = await this.databasesOn(clusterId);
    const finding = this.classify(clusterId, databases, await this.registry()).find(
      (f) => f.databaseName === databaseName,
    );
    if (finding === undefined || finding.kind === "missing") return false;
    const client = await (
      await this.clusters.on(clusterId)
    ).connect("migrator", this.options.maintenanceDatabase);
    try {
      await client.query(`drop database ${ident(databaseName)} with (force)`);
    } finally {
      await client.end();
    }
    return true;
  }

  private classify(
    clusterId: string,
    databases: ReadonlyMap<string, number | null>,
    registry: Registry,
  ): DatabaseFinding[] {
    const findings: DatabaseFinding[] = [];
    for (const [name, sizeBytes] of databases) {
      const tenant = registry.byName.get(name);
      if (tenant?.clusterId === clusterId) continue;
      const key = tenant === undefined ? "" : `${tenant.tenantId}:${clusterId}`;
      // The copy of a move under way is expected.
      if (registry.movingTo.has(key)) continue;
      findings.push({
        clusterId,
        databaseName: name,
        kind:
          tenant === undefined
            ? "no_tenant"
            : registry.movedFrom.has(key)
              ? "moved_away"
              : "stray_copy",
        tenantId: tenant?.tenantId ?? null,
        sizeBytes,
      });
    }
    for (const [name, tenant] of registry.byName)
      if (tenant.clusterId === clusterId && tenant.hasDatabase && !databases.has(name))
        findings.push({
          clusterId,
          databaseName: name,
          kind: "missing",
          tenantId: tenant.tenantId,
          sizeBytes: null,
        });
    return findings;
  }

  /** Databases with the tenant prefix on a cluster, with their size where readable. */
  private async databasesOn(clusterId: string): Promise<Map<string, number | null>> {
    const client = await (
      await this.clusters.on(clusterId)
    ).connect("migrator", this.options.maintenanceDatabase);
    try {
      const { rows } = await client.query<{ datname: string; size: string | null }>(
        `select datname,
                case when has_database_privilege(datname, 'connect')
                     then pg_database_size(datname) end as size
           from pg_database
          where starts_with(datname, $1) and not datistemplate
          order by datname`,
        [this.options.prefix],
      );
      return new Map(rows.map((r) => [r.datname, r.size === null ? null : Number(r.size)]));
    } finally {
      await client.end();
    }
  }

  private async registry(): Promise<Registry> {
    const tenants = await this.db.query<{
      id: string;
      cluster_id: string;
      database_name: string | null;
    }>("select id, cluster_id, database_name from tenants");
    const moves = await this.db.query<{
      tenant_id: string;
      from_cluster: string;
      to_cluster: string;
      status: string;
    }>("select tenant_id, from_cluster, to_cluster, status from tenant_cluster_moves");
    return {
      byName: new Map(
        tenants.rows.map((t) => [
          this.naming.databaseNameFor(TenantId.from(t.id)),
          { tenantId: t.id, clusterId: t.cluster_id, hasDatabase: t.database_name !== null },
        ]),
      ),
      movedFrom: new Set(
        moves.rows
          .filter((m) => m.status === "completed")
          .map((m) => `${m.tenant_id}:${m.from_cluster}`),
      ),
      movingTo: new Set(
        moves.rows
          .filter((m) => m.status !== "completed" && m.status !== "failed")
          .map((m) => `${m.tenant_id}:${m.to_cluster}`),
      ),
    };
  }
}
