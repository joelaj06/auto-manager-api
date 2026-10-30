import type { FileFormat, ReportJob, ReportTable } from "../../domain/reporting/Report.js";

/** Report jobs in the tenant database. */
export interface IReportJobs {
  insert(job: ReportJob): Promise<void>;
  update(job: ReportJob): Promise<void>;
  get(id: string): Promise<ReportJob | null>;
  lock(id: string): Promise<ReportJob | null>;
  /** A user's jobs, newest first. */
  listFor(userId: string, limit: number): Promise<ReportJob[]>;
  /** Jobs queued or running, in the tenant and of the user. */
  active(userId: string): Promise<Readonly<{ tenant: number; user: number }>>;
  /** Ready jobs whose keeping time ended. */
  expired(now: Date, limit: number): Promise<string[]>;
  /** Jobs queued or running since before `before` (lost). */
  stale(before: Date, limit: number): Promise<string[]>;
}

/** Hands a queued report job to the worker once the request's transaction has committed. */
export interface IReportJobQueue {
  request(jobId: string): void;
}

/** A report table written as a spreadsheet file. */
export interface IReportFileWriter {
  /** UTF-8 with a byte-order mark, so spreadsheets read the currency signs right. */
  csv(table: ReportTable): Buffer;
  xlsx(table: ReportTable): Buffer;
}

export type RenderedReport = Readonly<{
  content: Buffer;
  contentType: string;
  extension: FileFormat;
}>;
