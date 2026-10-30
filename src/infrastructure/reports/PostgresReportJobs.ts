import type { IReportJobs } from "../../application/ports/IReportJobs.js";
import {
  ReportJob,
  type FileFormat,
  type ParamValues,
  type ReportJobStatus,
} from "../../domain/reporting/Report.js";
import type { PostgresTransactionContext } from "../database/postgres/PostgresTransactionContext.js";

type Row = {
  id: string;
  report_id: string;
  params: ParamValues;
  format: FileFormat;
  status: ReportJobStatus;
  requested_by: string;
  schedule_id: string | null;
  recipients: string[];
  row_count: number | null;
  file_id: string | null;
  error: string | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  expires_at: Date | null;
};

const COLUMNS = `id, report_id, params, format, status, requested_by, schedule_id, recipients,
  row_count, file_id, error, created_at, started_at, finished_at, expires_at`;

const toJob = (r: Row) =>
  ReportJob.restore({
    id: r.id,
    reportId: r.report_id,
    params: r.params,
    format: r.format,
    status: r.status,
    requestedBy: r.requested_by,
    scheduleId: r.schedule_id,
    recipients: r.recipients,
    rowCount: r.row_count,
    fileId: r.file_id,
    error: r.error,
    createdAt: r.created_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    expiresAt: r.expires_at,
  });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class PostgresReportJobs implements IReportJobs {
  constructor(private readonly transactions: PostgresTransactionContext) {}

  private get tx() {
    return this.transactions.current();
  }

  async insert(job: ReportJob): Promise<void> {
    const j = job.snapshot();
    await this.tx.query(
      `insert into report_jobs (id, report_id, params, format, status, requested_by, schedule_id,
         recipients, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        j.id,
        j.reportId,
        JSON.stringify(j.params),
        j.format,
        j.status,
        j.requestedBy,
        j.scheduleId,
        j.recipients,
        j.createdAt,
      ],
    );
  }

  async update(job: ReportJob): Promise<void> {
    const j = job.snapshot();
    await this.tx.query(
      `update report_jobs
          set status = $2, row_count = $3, file_id = $4, error = $5, started_at = $6,
              finished_at = $7, expires_at = $8
        where id = $1`,
      [j.id, j.status, j.rowCount, j.fileId, j.error, j.startedAt, j.finishedAt, j.expiresAt],
    );
  }

  async get(id: string): Promise<ReportJob | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.tx.query<Row>(`select ${COLUMNS} from report_jobs where id = $1`, [
      id,
    ]);
    return rows[0] === undefined ? null : toJob(rows[0]);
  }

  async lock(id: string): Promise<ReportJob | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.tx.query<Row>(
      `select ${COLUMNS} from report_jobs where id = $1 for update`,
      [id],
    );
    return rows[0] === undefined ? null : toJob(rows[0]);
  }

  async listFor(userId: string, limit: number): Promise<ReportJob[]> {
    const { rows } = await this.tx.query<Row>(
      `select ${COLUMNS} from report_jobs where requested_by = $1 or $1 = any(recipients)
        order by created_at desc, id desc limit $2`,
      [userId, limit],
    );
    return rows.map(toJob);
  }

  async active(userId: string): Promise<Readonly<{ tenant: number; user: number }>> {
    // Serialises requests, so two at once cannot both pass the limits.
    await this.tx.query(`select pg_advisory_xact_lock(hashtext('report_jobs'))`);
    const { rows } = await this.tx.query<{ tenant: string; user: string }>(
      `select count(*) as tenant, count(*) filter (where requested_by = $1) as user
         from report_jobs where status in ('queued', 'running')`,
      [userId],
    );
    return { tenant: Number(rows[0]!.tenant), user: Number(rows[0]!.user) };
  }

  async expired(now: Date, limit: number): Promise<string[]> {
    const { rows } = await this.tx.query<{ id: string }>(
      `select id from report_jobs where status = 'ready' and expires_at <= $1
        order by expires_at limit $2`,
      [now, limit],
    );
    return rows.map((r) => r.id);
  }

  async stale(before: Date, limit: number): Promise<string[]> {
    const { rows } = await this.tx.query<{ id: string }>(
      `select id from report_jobs
        where status in ('queued', 'running') and coalesce(started_at, created_at) < $1
        order by created_at limit $2`,
      [before, limit],
    );
    return rows.map((r) => r.id);
  }
}
