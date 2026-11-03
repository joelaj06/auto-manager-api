import type { ErasureSubject } from "../../domain/console/ColdArchive.js";
import type { ErasureEntry, IErasureLedger } from "../../application/ports/IErasureLedger.js";
import type { ErasureReport } from "../../application/ports/IPersonalDataEraser.js";
import type { Queryable } from "../database/postgres/Queryable.js";

type Row = Record<string, unknown>;
const date = (v: unknown) => (v === null || v === undefined ? null : (v as Date));
const text = (v: unknown) => (typeof v === "string" ? v : null);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toEntry(r: Row): ErasureEntry {
  return {
    id: String(r.id),
    tenantId: String(r.tenant_id),
    subjectType: r.subject_type as ErasureSubject,
    subjectId: String(r.subject_id),
    requestId: text(r.request_id),
    reason: String(r.reason),
    approvalId: text(r.approval_id),
    requestedBy: String(r.requested_by),
    approvedBy: text(r.approved_by),
    status: r.status as ErasureEntry["status"],
    report: r.report as ErasureEntry["report"],
    error: text(r.error),
    createdAt: r.created_at as Date,
    appliedAt: date(r.applied_at),
    reapplied: Number(r.reapplied),
    lastReappliedAt: date(r.last_reapplied_at),
  };
}

export class PostgresErasureLedger implements IErasureLedger {
  constructor(private readonly db: Queryable) {}

  async create(entry: Parameters<IErasureLedger["create"]>[0]): Promise<string> {
    const { rows } = await this.db.query<{ id: string }>(
      `insert into erasure_ledger
         (tenant_id, subject_type, subject_id, request_id, reason, approval_id, requested_by,
          approved_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
      [
        entry.tenantId,
        entry.subjectType,
        entry.subjectId,
        entry.requestId,
        entry.reason,
        entry.approvalId,
        entry.requestedBy,
        entry.approvedBy,
      ],
    );
    return rows[0]!.id;
  }

  async find(id: string): Promise<ErasureEntry | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.db.query<Row>("select * from erasure_ledger where id = $1", [id]);
    return rows[0] === undefined ? null : toEntry(rows[0]);
  }

  async findSubject(
    tenantId: string,
    type: ErasureSubject,
    subjectId: string,
  ): Promise<ErasureEntry | null> {
    if (!UUID.test(subjectId)) return null;
    const { rows } = await this.db.query<Row>(
      `select * from erasure_ledger
        where tenant_id = $1 and subject_type = $2 and subject_id = $3`,
      [tenantId, type, subjectId],
    );
    return rows[0] === undefined ? null : toEntry(rows[0]);
  }

  async forTenant(tenantId: string): Promise<ErasureEntry[]> {
    const { rows } = await this.db.query<Row>(
      "select * from erasure_ledger where tenant_id = $1 order by created_at, id",
      [tenantId],
    );
    return rows.map(toEntry);
  }

  async list(
    filter: Readonly<{ tenantId?: string; requestId?: string; limit: number }>,
  ): Promise<ErasureEntry[]> {
    const { rows } = await this.db.query<Row>(
      `select * from erasure_ledger
        where ($1::uuid is null or tenant_id = $1) and ($2::uuid is null or request_id = $2)
        order by created_at desc, id desc
        limit $3`,
      [filter.tenantId ?? null, filter.requestId ?? null, filter.limit],
    );
    return rows.map(toEntry);
  }

  async applied(id: string, report: ErasureReport, at: Date): Promise<void> {
    await this.db.query(
      `update erasure_ledger set status = 'applied', report = $2, applied_at = $3, error = null
        where id = $1`,
      [id, JSON.stringify(report), at],
    );
  }

  async failed(id: string, error: string): Promise<void> {
    await this.db.query("update erasure_ledger set error = $2 where id = $1", [
      id,
      error.slice(0, 2_000),
    ]);
  }

  async reapplied(id: string, at: Date): Promise<void> {
    await this.db.query(
      `update erasure_ledger set reapplied = reapplied + 1, last_reapplied_at = $2 where id = $1`,
      [id, at],
    );
  }
}
