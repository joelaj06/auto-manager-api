import type {
  ClusterChanges,
  ClusterFinding,
  ClusterMove,
  ClusterRecord,
  IClusterRegistry,
  MoveChanges,
  TenantPlacement,
} from "../../../application/ports/IClusterRegistry.js";
import type { ClusterSweep } from "../../../application/ports/IOrphanDatabases.js";
import type { ClusterLoad, NewCluster } from "../../../domain/console/Clusters.js";
import type { Queryable } from "../postgres/Queryable.js";

type Row = Record<string, unknown>;
const n = (v: unknown) => Number(v ?? 0);
const date = (v: unknown) => (v === null || v === undefined ? null : (v as Date));
const text = (v: unknown) => (typeof v === "string" ? v : null);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIVE = `('trialing', 'active', 'past_due', 'read_only')`;

const CLUSTERS = `
  select c.*,
         (select count(*) from tenants t where t.cluster_id = c.id and t.status <> 'archived')
           as tenants,
         (select count(*) from tenants t where t.cluster_id = c.id and t.status in ${LIVE})
           as live_tenants
    from clusters c`;

const MOVES = `
  select m.*, m.source_retained_until::text as retained_until, t.slug::text as slug
    from tenant_cluster_moves m join tenants t on t.id = m.tenant_id`;

const FINDINGS = `
  select f.*,
         (select max(m.source_retained_until)::text from tenant_cluster_moves m
           where m.tenant_id = f.tenant_id and m.from_cluster = f.cluster_id
             and m.status = 'completed') as retained_until
    from cluster_database_findings f`;

function toCluster(r: Row): ClusterRecord {
  return {
    id: String(r.id),
    name: String(r.name),
    host: text(r.host),
    port: r.port === null ? null : n(r.port),
    status: r.status as ClusterRecord["status"],
    maxTenants: n(r.max_tenants),
    tenants: n(r.tenants),
    liveTenants: n(r.live_tenants),
    notes: text(r.notes),
    lastCheckedAt: date(r.last_checked_at),
    lastError: text(r.last_error),
    createdAt: r.created_at as Date,
  };
}

function toMove(r: Row): ClusterMove {
  return {
    id: String(r.id),
    tenantId: String(r.tenant_id),
    slug: String(r.slug),
    from: String(r.from_cluster),
    to: String(r.to_cluster),
    status: r.status as ClusterMove["status"],
    reason: String(r.reason),
    report: r.report as ClusterMove["report"],
    error: text(r.error),
    approvalId: text(r.approval_id),
    requestedBy: String(r.requested_by),
    requestedAt: r.requested_at as Date,
    startedAt: date(r.started_at),
    finishedAt: date(r.finished_at),
    sourceRetainedUntil: text(r.retained_until),
  };
}

function toFinding(r: Row): ClusterFinding {
  return {
    clusterId: String(r.cluster_id),
    databaseName: String(r.database_name),
    kind: r.kind as ClusterFinding["kind"],
    tenantId: text(r.tenant_id),
    sizeBytes: r.size_bytes === null ? null : n(r.size_bytes),
    firstSeenAt: r.first_seen_at as Date,
    lastSeenAt: r.last_seen_at as Date,
    resolvedAt: date(r.resolved_at),
    droppedBy: text(r.dropped_by),
    retainedUntil: text(r.retained_until),
  };
}

export class PostgresClusterRegistry implements IClusterRegistry {
  constructor(private readonly db: Queryable) {}

  async list(): Promise<ClusterRecord[]> {
    const { rows } = await this.db.query<Row>(`${CLUSTERS} order by c.created_at, c.id`);
    return rows.map(toCluster);
  }

  async find(id: string): Promise<ClusterRecord | null> {
    const { rows } = await this.db.query<Row>(`${CLUSTERS} where c.id = $1`, [id]);
    return rows[0] === undefined ? null : toCluster(rows[0]);
  }

  async create(cluster: NewCluster, createdBy: string): Promise<void> {
    await this.db.query(
      `insert into clusters (id, name, host, port, max_tenants, notes, created_by)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        cluster.id,
        cluster.name,
        cluster.host,
        cluster.port,
        cluster.maxTenants,
        cluster.notes,
        createdBy,
      ],
    );
  }

  async update(id: string, changes: ClusterChanges): Promise<void> {
    await this.db.query(
      `update clusters
          set name = coalesce($2, name), status = coalesce($3, status),
              max_tenants = coalesce($4, max_tenants),
              notes = case when $5 then $6 else notes end, updated_at = now()
        where id = $1`,
      [
        id,
        changes.name ?? null,
        changes.status ?? null,
        changes.maxTenants ?? null,
        changes.notes !== undefined,
        changes.notes ?? null,
      ],
    );
  }

  async lockLoads(): Promise<ClusterLoad[]> {
    const { rows } = await this.db.query<Row>(
      `select c.id, c.status, c.max_tenants,
              (select count(*) from tenants t
                where t.cluster_id = c.id and t.status <> 'archived') as tenants
         from clusters c order by c.id for update of c`,
    );
    return rows.map((r) => ({
      id: String(r.id),
      status: r.status as ClusterLoad["status"],
      maxTenants: n(r.max_tenants),
      tenants: n(r.tenants),
    }));
  }

  async checked(id: string, error: string | null, at: Date): Promise<void> {
    await this.db.query("update clusters set last_checked_at = $2, last_error = $3 where id = $1", [
      id,
      at,
      error,
    ]);
  }

  async placement(tenantId: string): Promise<TenantPlacement | null> {
    if (!UUID.test(tenantId)) return null;
    const { rows } = await this.db.query<Row>(
      `select id, slug::text as slug, status, cluster_id, database_name is not null as has_database,
              moving_since is not null as moving
         from tenants where id = $1`,
      [tenantId],
    );
    const r = rows[0];
    if (r === undefined) return null;
    return {
      tenantId: String(r.id),
      slug: String(r.slug),
      status: String(r.status),
      clusterId: String(r.cluster_id),
      hasDatabase: r.has_database === true,
      moving: r.moving === true,
    };
  }

  async place(tenantId: string, clusterId: string): Promise<void> {
    await this.db.query(
      `update tenants set cluster_id = $2, updated_at = now()
        where id = $1 and database_name is null`,
      [tenantId, clusterId],
    );
  }

  async switchTenant(tenantId: string, clusterId: string): Promise<void> {
    await this.db.query("update tenants set cluster_id = $2, updated_at = now() where id = $1", [
      tenantId,
      clusterId,
    ]);
  }

  async setMoving(tenantId: string, since: Date | null): Promise<void> {
    await this.db.query("update tenants set moving_since = $2 where id = $1", [tenantId, since]);
  }

  async createMove(move: Parameters<IClusterRegistry["createMove"]>[0]): Promise<string> {
    const { rows } = await this.db.query<{ id: string }>(
      `insert into tenant_cluster_moves
         (tenant_id, from_cluster, to_cluster, reason, approval_id, requested_by)
       values ($1, $2, $3, $4, $5, $6) returning id`,
      [move.tenantId, move.from, move.to, move.reason, move.approvalId, move.requestedBy],
    );
    return rows[0]!.id;
  }

  async findMove(id: string): Promise<ClusterMove | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.db.query<Row>(`${MOVES} where m.id = $1`, [id]);
    return rows[0] === undefined ? null : toMove(rows[0]);
  }

  async openMove(tenantId: string): Promise<ClusterMove | null> {
    const { rows } = await this.db.query<Row>(
      `${MOVES} where m.tenant_id = $1 and m.status not in ('completed', 'failed')`,
      [tenantId],
    );
    return rows[0] === undefined ? null : toMove(rows[0]);
  }

  async moves(
    filter: Readonly<{ tenantId?: string; clusterId?: string; limit: number }>,
  ): Promise<ClusterMove[]> {
    const { rows } = await this.db.query<Row>(
      `${MOVES}
        where ($1::uuid is null or m.tenant_id = $1)
          and ($2::text is null or m.from_cluster = $2 or m.to_cluster = $2)
        order by m.requested_at desc, m.id desc
        limit $3`,
      [filter.tenantId ?? null, filter.clusterId ?? null, filter.limit],
    );
    return rows.map(toMove);
  }

  async updateMove(id: string, changes: MoveChanges): Promise<void> {
    await this.db.query(
      `update tenant_cluster_moves
          set status = coalesce($2, status),
              report = coalesce($3::jsonb, report),
              error = case when $4 then $5 else error end,
              started_at = coalesce($6, started_at),
              finished_at = coalesce($7, finished_at),
              source_retained_until = coalesce($8::date, source_retained_until)
        where id = $1`,
      [
        id,
        changes.status ?? null,
        changes.report === undefined ? null : JSON.stringify(changes.report),
        changes.error !== undefined,
        changes.error ?? null,
        changes.startedAt ?? null,
        changes.finishedAt ?? null,
        changes.sourceRetainedUntil ?? null,
      ],
    );
  }

  async recordSweep(sweeps: readonly ClusterSweep[], at: Date): Promise<ClusterFinding[]> {
    const fresh: ClusterFinding[] = [];
    for (const sweep of sweeps) {
      await this.checked(sweep.clusterId, sweep.error, at);
      // A cluster that did not answer says nothing about its databases.
      if (sweep.error !== null) continue;
      for (const f of sweep.findings) {
        const { rows } = await this.db.query<Row & { inserted: boolean }>(
          `insert into cluster_database_findings as x
             (cluster_id, database_name, kind, tenant_id, size_bytes, first_seen_at, last_seen_at)
           values ($1, $2, $3, $4, $5, $6, $6)
           on conflict (cluster_id, database_name) do update
              set kind = excluded.kind, tenant_id = excluded.tenant_id,
                  size_bytes = excluded.size_bytes, last_seen_at = excluded.last_seen_at,
                  -- Seen again after it was resolved: a new finding.
                  first_seen_at = case when x.resolved_at is null then x.first_seen_at
                                       else excluded.first_seen_at end,
                  resolved_at = null, dropped_by = null
           returning (xmax = 0 or first_seen_at = $6) as inserted`,
          [sweep.clusterId, f.databaseName, f.kind, f.tenantId, f.sizeBytes, at],
        );
        if (rows[0]?.inserted === true) {
          const found = await this.finding(sweep.clusterId, f.databaseName);
          if (found !== null) fresh.push(found);
        }
      }
      await this.db.query(
        `update cluster_database_findings set resolved_at = $2
          where cluster_id = $1 and resolved_at is null
            and not (database_name = any($3::text[]))`,
        [sweep.clusterId, at, sweep.findings.map((f) => f.databaseName)],
      );
    }
    return fresh;
  }

  async findings(
    filter: Readonly<{ open: boolean; clusterId?: string }>,
  ): Promise<ClusterFinding[]> {
    const { rows } = await this.db.query<Row>(
      `${FINDINGS}
        where ($1::boolean is false or f.resolved_at is null)
          and ($2::text is null or f.cluster_id = $2)
        order by (f.kind = 'missing') desc, f.first_seen_at, f.database_name
        limit 1000`,
      [filter.open, filter.clusterId ?? null],
    );
    return rows.map(toFinding);
  }

  async finding(clusterId: string, databaseName: string): Promise<ClusterFinding | null> {
    const { rows } = await this.db.query<Row>(
      `${FINDINGS} where f.cluster_id = $1 and f.database_name = $2`,
      [clusterId, databaseName],
    );
    return rows[0] === undefined ? null : toFinding(rows[0]);
  }

  async dropped(
    clusterId: string,
    databaseName: string,
    droppedBy: string,
    at: Date,
  ): Promise<void> {
    await this.db.query(
      `update cluster_database_findings set resolved_at = $3, dropped_by = $4
        where cluster_id = $1 and database_name = $2`,
      [clusterId, databaseName, at, droppedBy],
    );
  }
}
