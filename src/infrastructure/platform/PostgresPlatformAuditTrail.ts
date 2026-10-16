import type {
  IPlatformAuditTrail,
  PlatformAuditEntry,
  PlatformAuditQuery,
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

  async search(query: PlatformAuditQuery): Promise<PlatformAuditRecord[]> {
    const { rows } = await this.db.query<Row>(
      `select id, occurred_at, actor_type, actor_id, action, entity_type, entity_id,
              target_tenant_id, before, after, reason, request_id, ip::text as ip, user_agent, metadata
         from platform_audit_logs
        where ($1::uuid is null or actor_id = $1)
          and ($2::text is null or action = $2 or starts_with(action, $2 || '.'))
          and ($3::uuid is null or target_tenant_id = $3)
          and ($4::timestamptz is null or occurred_at >= $4)
          and ($5::timestamptz is null or occurred_at < $5)
          and ($6::uuid is null or id < $6)
        order by id desc
        limit $7`,
      [
        query.actorId ?? null,
        query.action ?? null,
        query.targetTenantId ?? null,
        query.from ?? null,
        query.to ?? null,
        query.before ?? null,
        query.limit,
      ],
    );
    return rows.map((r) => ({
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
    }));
  }
}
