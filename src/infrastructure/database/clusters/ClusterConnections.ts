import type { IClusterRouting } from "../../../application/ports/IClusterRegistry.js";
import { TtlCache } from "../../cache/TtlCache.js";
import type { PostgresConnectionFactory } from "../postgres/PostgresConnectionFactory.js";
import type { Queryable } from "../postgres/Queryable.js";

/** The cluster in the configuration (DATABASE_HOST / DATABASE_PORT). */
export const MAIN_CLUSTER = "main";

/** Where a cluster's server is. */
export type ClusterEndpoint = Readonly<{ id: string; host: string; port: number }>;

/**
 * Where each cluster and each tenant's database are, from the platform registry (decision 491).
 * Lookups are cached for a few seconds, like the tenant directory: a tenant moved to another
 * cluster is offline until every process has seen its new cluster. A tenant without a record (a
 * test database) is on the main cluster.
 */
export class ClusterConnections implements IClusterRouting {
  private readonly endpoints: TtlCache<ClusterEndpoint | null>;
  private readonly tenants: TtlCache<string>;

  constructor(
    private readonly platform: Queryable,
    private readonly factory: PostgresConnectionFactory,
    private readonly main: Readonly<{ host: string; port: number }>,
    options: Readonly<{ cacheTtlMs: number }> = { cacheTtlMs: 5_000 },
  ) {
    this.endpoints = new TtlCache({ ttlMs: options.cacheTtlMs, maxEntries: 1_000 });
    this.tenants = new TtlCache({ ttlMs: options.cacheTtlMs, maxEntries: 20_000 });
  }

  invalidate(): void {
    this.endpoints.clear();
    this.tenants.clear();
  }

  forget(tenantId: string): void {
    this.tenants.delete(tenantId);
  }

  async endpoint(clusterId: string): Promise<ClusterEndpoint> {
    const found = await this.endpoints.getOrLoad(
      clusterId,
      async () => {
        const { rows } = await this.platform.query<{ host: string | null; port: number | null }>(
          "select host, port from clusters where id = $1",
          [clusterId],
        );
        const row = rows[0];
        if (row === undefined) return null;
        return row.host === null || row.port === null
          ? { id: clusterId, ...this.main }
          : { id: clusterId, host: row.host, port: row.port };
      },
      (endpoint) => endpoint !== null,
    );
    if (found === null) throw new Error(`Unknown database cluster ${clusterId}`);
    return found;
  }

  clusterOf(tenantId: string): Promise<string> {
    return this.tenants.getOrLoad(tenantId, async () => {
      const { rows } = await this.platform.query<{ cluster_id: string }>(
        "select cluster_id from tenants where id = $1",
        [tenantId],
      );
      return rows[0]?.cluster_id ?? MAIN_CLUSTER;
    });
  }

  async endpointOf(tenantId: string): Promise<ClusterEndpoint> {
    return this.endpoint(await this.clusterOf(tenantId));
  }

  /** Connections to a cluster as any role. */
  async on(clusterId: string): Promise<PostgresConnectionFactory> {
    return this.factory.at(await this.endpoint(clusterId));
  }

  /** Connections to the cluster a tenant's database is on. */
  async ofTenant(tenantId: string): Promise<PostgresConnectionFactory> {
    return this.factory.at(await this.endpointOf(tenantId));
  }

  /** Clusters that may hold databases (all but retired ones). */
  async clusters(): Promise<ClusterEndpoint[]> {
    const { rows } = await this.platform.query<{ id: string }>(
      "select id from clusters where status <> 'retired' order by id",
    );
    return Promise.all(rows.map((r) => this.endpoint(r.id)));
  }
}
