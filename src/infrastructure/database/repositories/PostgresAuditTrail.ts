import type { AuditEntry } from "../../../application/dto/AuditEntry.js";
import type { IAuditTrail } from "../../../application/ports/IAuditTrail.js";
import type { IRequestContext } from "../../../application/ports/IRequestContext.js";
import type { PostgresTransactionContext } from "../postgres/PostgresTransactionContext.js";

const ACTION = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

/**
 * Writes to the tenant's append-only audit_logs table (enforced by grants and a trigger). During
 * support access the actor is the staff member, never the tenant user whose permissions apply,
 * so the tenant's log cannot mistake it for that user's own action (docs/27 §3.8).
 */
export class PostgresAuditTrail implements IAuditTrail {
  constructor(
    private readonly transactions: PostgresTransactionContext,
    private readonly requestContext?: IRequestContext,
  ) {}

  async record(original: AuditEntry): Promise<string> {
    if (!ACTION.test(original.action)) throw new Error(`Invalid audit action: ${original.action}`);
    const support = this.requestContext?.current()?.support;
    const entry: AuditEntry =
      support === undefined
        ? original
        : {
            ...original,
            actorType: "platform_staff",
            actorId: support.staffId,
            metadata: {
              ...original.metadata,
              support: {
                sessionId: support.sessionId,
                staff: `platform:${support.staffName}`,
                mode: support.mode,
                asUser: original.actorId ?? null,
              },
            },
          };

    const { rows } = await this.transactions.current().query<{ id: string }>(
      `insert into audit_logs
         (actor_type, actor_id, action, entity_type, entity_id, before, after,
          request_id, ip, user_agent, metadata)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       returning id`,
      [
        entry.actorType,
        entry.actorId ?? null,
        entry.action,
        entry.entityType,
        entry.entityId ?? null,
        entry.before === undefined ? null : JSON.stringify(entry.before),
        entry.after === undefined ? null : JSON.stringify(entry.after),
        entry.requestId ?? null,
        entry.ip ?? null,
        entry.userAgent ?? null,
        JSON.stringify(entry.metadata ?? {}),
      ],
    );
    const id = rows[0]?.id;
    if (id === undefined) throw new Error("Audit insert returned no id");
    return id;
  }
}
