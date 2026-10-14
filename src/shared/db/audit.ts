import type { Queryable } from "./types.js";

export type AuditActorType = "user" | "platform_staff" | "system";

export type AuditEvent = Readonly<{
  actorType: AuditActorType;
  actorId?: string | null;
  /** Dotted verb, e.g. "vehicle.status_changed", "role.permissions_updated". */
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  requestId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  metadata?: Readonly<Record<string, unknown>>;
}>;

const ACTION = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

/**
 * Appends an entry to the tenant's audit log. Call it inside the same transaction as the change
 * it describes. The table is append-only (enforced by grants and a trigger).
 * Callers must redact secrets from `before`/`after`.
 */
export async function recordAuditEvent(db: Queryable, event: AuditEvent): Promise<string> {
  if (!ACTION.test(event.action)) {
    throw new Error(`Invalid audit action: ${event.action}`);
  }
  const { rows } = await db.query<{ id: string }>(
    `insert into audit_logs
       (actor_type, actor_id, action, entity_type, entity_id, before, after,
        request_id, ip, user_agent, metadata)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     returning id`,
    [
      event.actorType,
      event.actorId ?? null,
      event.action,
      event.entityType,
      event.entityId ?? null,
      event.before === undefined ? null : JSON.stringify(event.before),
      event.after === undefined ? null : JSON.stringify(event.after),
      event.requestId ?? null,
      event.ip ?? null,
      event.userAgent ?? null,
      JSON.stringify(event.metadata ?? {}),
    ],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error("Audit insert returned no id");
  return id;
}
