import type { IReportSchedules } from "../../application/ports/IReportSchedules.js";
import type { FileFormat, ParamValues } from "../../domain/reporting/Report.js";
import {
  ReportSchedule,
  type ScheduleFrequency,
  type SchedulePeriod,
  type ScheduleStatus,
} from "../../domain/reporting/ReportSchedule.js";
import type { PostgresTransactionContext } from "../database/postgres/PostgresTransactionContext.js";

type Row = {
  id: string;
  name: string;
  report_id: string;
  params: ParamValues;
  period: SchedulePeriod | null;
  format: FileFormat;
  frequency: ScheduleFrequency;
  weekday: number | null;
  month_day: number | null;
  hour: number;
  recipients: string[];
  status: ScheduleStatus;
  owner_id: string;
  next_run_at: Date;
  last_run_at: Date | null;
  last_job_id: string | null;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
};

const COLUMNS = `id, name, report_id, params, period, format, frequency, weekday, month_day, hour,
  recipients, status, owner_id, next_run_at, last_run_at, last_job_id, last_error, created_at,
  updated_at`;

const toSchedule = (r: Row) =>
  ReportSchedule.restore({
    id: r.id,
    name: r.name,
    reportId: r.report_id,
    params: r.params,
    period: r.period,
    format: r.format,
    frequency: r.frequency,
    weekday: r.weekday,
    monthDay: r.month_day,
    hour: r.hour,
    recipients: r.recipients,
    status: r.status,
    ownerId: r.owner_id,
    nextRunAt: r.next_run_at,
    lastRunAt: r.last_run_at,
    lastJobId: r.last_job_id,
    lastError: r.last_error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class PostgresReportSchedules implements IReportSchedules {
  constructor(private readonly transactions: PostgresTransactionContext) {}

  private get tx() {
    return this.transactions.current();
  }

  async insert(schedule: ReportSchedule): Promise<void> {
    const s = schedule.snapshot();
    await this.tx.query(
      `insert into report_schedules (id, name, report_id, params, period, format, frequency,
         weekday, month_day, hour, recipients, status, owner_id, next_run_at, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
      [
        s.id,
        s.name,
        s.reportId,
        JSON.stringify(s.params),
        s.period,
        s.format,
        s.frequency,
        s.weekday,
        s.monthDay,
        s.hour,
        s.recipients,
        s.status,
        s.ownerId,
        s.nextRunAt,
        s.createdAt,
        s.updatedAt,
      ],
    );
  }

  async update(schedule: ReportSchedule): Promise<void> {
    const s = schedule.snapshot();
    await this.tx.query(
      `update report_schedules
          set name = $2, report_id = $3, params = $4, period = $5, format = $6, frequency = $7,
              weekday = $8, month_day = $9, hour = $10, recipients = $11, status = $12,
              next_run_at = $13, last_run_at = $14, last_job_id = $15, last_error = $16,
              updated_at = $17
        where id = $1`,
      [
        s.id,
        s.name,
        s.reportId,
        JSON.stringify(s.params),
        s.period,
        s.format,
        s.frequency,
        s.weekday,
        s.monthDay,
        s.hour,
        s.recipients,
        s.status,
        s.nextRunAt,
        s.lastRunAt,
        s.lastJobId,
        s.lastError,
        s.updatedAt,
      ],
    );
  }

  async remove(id: string): Promise<void> {
    // Runs already built stay with their recipients; they no longer name the schedule.
    await this.tx.query(`update report_jobs set schedule_id = null where schedule_id = $1`, [id]);
    await this.tx.query(`delete from report_schedules where id = $1`, [id]);
  }

  async get(id: string): Promise<ReportSchedule | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.tx.query<Row>(
      `select ${COLUMNS} from report_schedules where id = $1`,
      [id],
    );
    return rows[0] === undefined ? null : toSchedule(rows[0]);
  }

  async lock(id: string): Promise<ReportSchedule | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.tx.query<Row>(
      `select ${COLUMNS} from report_schedules where id = $1 for update`,
      [id],
    );
    return rows[0] === undefined ? null : toSchedule(rows[0]);
  }

  async list(ownerId: string | null): Promise<ReportSchedule[]> {
    const { rows } = await this.tx.query<Row>(
      `select ${COLUMNS} from report_schedules where $1::uuid is null or owner_id = $1
        order by created_at desc, id desc`,
      [ownerId],
    );
    return rows.map(toSchedule);
  }

  async count(): Promise<number> {
    const { rows } = await this.tx.query<{ n: string }>(
      `select count(*) as n from report_schedules`,
    );
    return Number(rows[0]!.n);
  }

  async due(now: Date, limit: number): Promise<ReportSchedule[]> {
    const { rows } = await this.tx.query<Row>(
      `select ${COLUMNS} from report_schedules
        where status = 'active' and next_run_at <= $1
        order by next_run_at, id limit $2 for update skip locked`,
      [now, limit],
    );
    return rows.map(toSchedule);
  }
}
