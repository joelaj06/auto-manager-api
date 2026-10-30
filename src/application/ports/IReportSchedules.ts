import type { ReportSchedule } from "../../domain/reporting/ReportSchedule.js";

/** Report schedules in the tenant database. */
export interface IReportSchedules {
  insert(schedule: ReportSchedule): Promise<void>;
  update(schedule: ReportSchedule): Promise<void>;
  remove(id: string): Promise<void>;
  get(id: string): Promise<ReportSchedule | null>;
  lock(id: string): Promise<ReportSchedule | null>;
  /** Newest first; only the owner's when `ownerId` is given. */
  list(ownerId: string | null): Promise<ReportSchedule[]>;
  count(): Promise<number>;
  /** Active schedules due by `now`, locked and skipped by another sweep that holds them. */
  due(now: Date, limit: number): Promise<ReportSchedule[]>;
}
