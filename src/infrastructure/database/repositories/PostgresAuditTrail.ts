import type { AuditEntry } from "../../../application/dto/AuditEntry.js";
import type { IAuditTrail } from "../../../application/ports/IAuditTrail.js";
import type { PostgresTransactionContext } from "../postgres/PostgresTransactionContext.js";

const ACTION = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

/** Writes to the tenant's append-only audit_logs table (enforced by grants and a trigger). */
export class PostgresAuditTrail implements IAuditTrail {
  constructor(private readonly transactions: PostgresTransactionContext) {}

  async record(entry: AuditEntry): Promise<string> {
    if (!ACTION.test(entry.action)) throw new Error(`Invalid audit action: ${entry.action}`);

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
