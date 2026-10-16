import { ApprovalRequest, type ApprovalStatus } from "../../domain/entities/ApprovalRequest.js";
import type { IApprovalRequestRepository } from "../../domain/repositories/IApprovalRequestRepository.js";
import type { PlatformDb } from "./PlatformDb.js";

type Row = {
  id: string;
  action: string;
  payload: Record<string, unknown>;
  summary: string;
  reason: string;
  ticket: string | null;
  target_tenant_id: string | null;
  requested_by: string;
  requested_at: Date;
  expires_at: Date;
  status: ApprovalStatus;
  decided_by: string | null;
  decided_at: Date | null;
  decision_note: string | null;
  executed_at: Date | null;
  result: Record<string, unknown> | null;
  error: string | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const toEntity = (r: Row) =>
  ApprovalRequest.restore({
    id: r.id,
    action: r.action,
    payload: r.payload,
    summary: r.summary,
    reason: r.reason,
    ticket: r.ticket,
    targetTenantId: r.target_tenant_id,
    requestedBy: r.requested_by,
    requestedAt: r.requested_at,
    expiresAt: r.expires_at,
    status: r.status,
    decidedBy: r.decided_by,
    decidedAt: r.decided_at,
    decisionNote: r.decision_note,
    executedAt: r.executed_at,
    result: r.result,
    error: r.error,
  });

export class PostgresApprovalRequestRepository implements IApprovalRequestRepository {
  constructor(private readonly db: PlatformDb) {}

  async lockById(id: string): Promise<ApprovalRequest | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.db.query<Row>(
      "select * from platform_approval_requests where id = $1 for update",
      [id],
    );
    return rows[0] === undefined ? null : toEntity(rows[0]);
  }

  async list(status: ApprovalStatus | null, limit: number): Promise<ApprovalRequest[]> {
    const { rows } = await this.db.query<Row>(
      `select * from platform_approval_requests
        where ($1::text is null or status = $1)
        order by requested_at desc limit $2`,
      [status, limit],
    );
    return rows.map(toEntity);
  }

  async save(request: ApprovalRequest): Promise<void> {
    const s = request.snapshot();
    await this.db.query(
      `insert into platform_approval_requests
         (id, action, payload, summary, reason, ticket, target_tenant_id, requested_by,
          requested_at, expires_at, status, decided_by, decided_at, decision_note, executed_at,
          result, error)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
       on conflict (id) do update set
         status = excluded.status, decided_by = excluded.decided_by,
         decided_at = excluded.decided_at, decision_note = excluded.decision_note,
         executed_at = excluded.executed_at, result = excluded.result, error = excluded.error`,
      [
        s.id,
        s.action,
        JSON.stringify(s.payload),
        s.summary,
        s.reason,
        s.ticket,
        s.targetTenantId,
        s.requestedBy,
        s.requestedAt,
        s.expiresAt,
        s.status,
        s.decidedBy,
        s.decidedAt,
        s.decisionNote,
        s.executedAt,
        s.result === null ? null : JSON.stringify(s.result),
        s.error,
      ],
    );
  }
}
