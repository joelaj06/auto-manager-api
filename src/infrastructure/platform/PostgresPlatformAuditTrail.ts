import type { Paged } from "../../domain/value-objects/Paged.js";
import { pagedQuery } from "../database/postgres/PagedQuery.js";
import type {
  IPlatformAuditTrail,
  PlatformAuditEntry,
  PlatformAuditQuery,
  PlatformAuditScan,
  PlatformAuditRecord,
} from "../../application/ports/IPlatformAuditTrail.js";
import type { PlatformDb } from "./PlatformDb.js";

const ACTION = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

type Row = {
  id: string;
  occurred_at: Date;
  actor_type: PlatformAuditEntry["actorType"];
  actor_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  target_tenant_id: string | null;
  before: unknown;
  after: unknown;
  reason: string | null;
  request_id: string | null;
  ip: string | null;
  user_agent: string | null;
  metadata: Record<string, unknown>;
};

/** platform_audit_logs: append-only (grants and trigger), written in the caller's transaction. */
function filtered(query: PlatformAuditQuery) {
  return {
    sql: `select id, occurred_at, actor_type, actor_id, action, entity_type, entity_id,
              target_tenant_id, before, after, reason, request_id, ip::text as ip, user_agent, metadata
         from platform_audit_logs
        where ($1::uuid is null or actor_id = $1)
          and ($2::text is null or action = $2 or starts_with(action, $2 || '.'))
          and ($3::uuid is null or target_tenant_id = $3)
          and ($4::timestamptz is null or occurred_at >= $4)
          and ($5::timestamptz is null or occurred_at < $5)
          and ($6::text is null or entity_type = $6)
        and ($7::text is null or entity_id = $7)`,
    orderBy: "id desc",
    params: [
      query.actorId ?? null,
      query.action ?? null,
      query.targetTenantId ?? null,
      query.from ?? null,
      query.to ?? null,
      query.entityType ?? null,
      query.entityId ?? null,
    ],
  };
}

const toRecord = (r: Row): PlatformAuditRecord => ({
  id: r.id,
  occurredAt: r.occurred_at,
  actorType: r.actor_type,
  actorId: r.actor_id,
  action: r.action,
  entityType: r.entity_type,
  entityId: r.entity_id,
  targetTenantId: r.target_tenant_id,
  before: r.before,
  after: r.after,
  reason: r.reason,
  requestId: r.request_id,
  ip: r.ip,
  userAgent: r.user_agent,
  metadata: r.metadata,
});

export class PostgresPlatformAuditTrail implements IPlatformAuditTrail {
  constructor(private readonly db: PlatformDb) {}

  async record(entry: PlatformAuditEntry): Promise<string> {
    if (!ACTION.test(entry.action)) throw new Error(`Invalid audit action: ${entry.action}`);
    const { rows } = await this.db.query<{ id: string }>(
      `insert into platform_audit_logs
         (actor_type, actor_id, action, entity_type, entity_id, target_tenant_id, before, after,
          reason, request_id, ip, user_agent, metadata)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       returning id`,
      [
        entry.actorType,
        entry.actorId ?? null,
        entry.action,
        entry.entityType,
        entry.entityId ?? null,
        entry.targetTenantId ?? null,
        entry.before === undefined ? null : JSON.stringify(entry.before),
        entry.after === undefined ? null : JSON.stringify(entry.after),
        entry.reason ?? null,
        entry.requestId ?? null,
        entry.ip ?? null,
        entry.userAgent ?? null,
        JSON.stringify(entry.metadata ?? {}),
      ],
    );
    return rows[0]!.id;
  }

  async page(query: PlatformAuditQuery): Promise<Paged<PlatformAuditRecord>> {
    const { rows, total } = await pagedQuery<Row>(this.db, filtered(query), query);
    return { rows: rows.map(toRecord), total };
  }

  async search(query: PlatformAuditScan): Promise<PlatformAuditRecord[]> {
    const { sql, orderBy, params } = filtered(query);
    const { rows } = await this.db.query<Row>(
      `${sql} and ($8::uuid is null or id < $8) order by ${orderBy} limit $9`,
      [...params, query.before ?? null, query.limit],
    );
    return rows.map(toRecord);
  }
}
