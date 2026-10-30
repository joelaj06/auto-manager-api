import { DomainError } from "../errors/DomainError.js";

export class ReportRuleError extends DomainError {
  readonly code = "REPORT_RULE";
  constructor(message: string) {
    super(message);
  }
}

/** JSON is answered at once; files are built by a background job. */
export const REPORT_FORMATS = ["json", "csv", "xlsx", "pdf"] as const;
export type ReportFormat = (typeof REPORT_FORMATS)[number];
export type FileFormat = Exclude<ReportFormat, "json">;
export const FILE_FORMATS = ["csv", "xlsx", "pdf"] as const satisfies readonly FileFormat[];

export const REPORT_CATEGORIES = [
  "executive",
  "fleet",
  "drivers",
  "workpay",
  "rentals",
  "dealer",
  "maintenance",
  "finance",
] as const;
export type ReportCategory = (typeof REPORT_CATEGORIES)[number];

/**
 * How a column's values are written: money in minor units of the report's currency, a percentage
 * as a number (12.5 for 12.5%), a date as YYYY-MM-DD.
 */
export type ColumnType = "text" | "number" | "money" | "percent" | "date";
export type ReportColumn = Readonly<{
  key: string;
  header: string;
  type: ColumnType;
  /** Relative width in a PDF (1 by default). */
  width?: number;
}>;

export type Cell = string | number | null;
export type ReportRow = Readonly<Record<string, Cell>>;

/** What a report returns: one table, with an optional totals row and summary lines. */
export type ReportTable = Readonly<{
  title: string;
  /** The period or date it covers ("2026-10-01 to 2026-10-30"). */
  subtitle: string | null;
  currency: string;
  columns: readonly ReportColumn[];
  rows: readonly ReportRow[];
  totals: ReportRow | null;
  /** Label–value lines above the table (in a PDF) and after it (in a spreadsheet). */
  summary: readonly Readonly<{ label: string; value: string }>[];
}>;

/** A parameter a report takes, described for the catalogue (the UI builds its form from it). */
export type ReportParam = Readonly<{
  key: string;
  label: string;
  type: "date" | "month" | "uuid" | "enum" | "text";
  required: boolean;
  options?: readonly string[];
}>;

export type ParamValues = Readonly<Record<string, string>>;

const CHECKS: Readonly<Record<ReportParam["type"], RegExp>> = {
  date: /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/,
  month: /^\d{4}-(0[1-9]|1[0-2])$/,
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  enum: /^/,
  text: /^.{1,200}$/s,
};

/** The given values checked against the parameters: unknown keys and bad values refused. */
export function checkParams(params: readonly ReportParam[], given: unknown): ParamValues {
  if (given === null || typeof given !== "object" || Array.isArray(given))
    throw new ReportRuleError("Report parameters are an object");
  const values = given as Record<string, unknown>;
  for (const key of Object.keys(values))
    if (!params.some((p) => p.key === key))
      throw new ReportRuleError(`The report takes no parameter "${key}"`);
  const out: Record<string, string> = {};
  for (const p of params) {
    const value = values[p.key];
    if (value === undefined || value === null || value === "") {
      if (p.required) throw new ReportRuleError(`${p.label} is required`);
      continue;
    }
    if (typeof value !== "string" || !CHECKS[p.type].test(value))
      throw new ReportRuleError(`${p.label} is not a valid ${p.type}`);
    if (p.type === "enum" && !(p.options ?? []).includes(value))
      throw new ReportRuleError(`${p.label} is one of ${(p.options ?? []).join(", ")}`);
    out[p.key] = value;
  }
  return out;
}

export const REPORT_JOB_STATUSES = ["queued", "running", "ready", "failed", "expired"] as const;
export type ReportJobStatus = (typeof REPORT_JOB_STATUSES)[number];

/** A report file is kept, and downloadable, this long (decision 465). */
export const REPORT_KEEP_DAYS = 7;
/** Report jobs queued or running at once (decision 464). */
export const MAX_ACTIVE_PER_TENANT = 4;
export const MAX_ACTIVE_PER_USER = 2;
/** Rows in a report answered as JSON, and in one file (decision 463). */
export const MAX_JSON_ROWS = 2_000;
export const MAX_FILE_ROWS: Readonly<Record<FileFormat, number>> = {
  csv: 100_000,
  xlsx: 100_000,
  pdf: 2_000,
};

export type ReportJobProps = Readonly<{
  id: string;
  reportId: string;
  params: ParamValues;
  format: FileFormat;
  status: ReportJobStatus;
  requestedBy: string;
  /** The schedule that asked for it (null when a user asked). */
  scheduleId: string | null;
  /** Users the schedule sends it to; they may see and download it too. */
  recipients: readonly string[];
  rowCount: number | null;
  fileId: string | null;
  error: string | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  expiresAt: Date | null;
}>;

const DAY_MS = 86_400_000;

/**
 * A report asked for as a file (docs/14 §2): queued, built by a job as the user who asked,
 * ready to download for 7 days, then expired and its file removed; or failed with the reason.
 */
export class ReportJob {
  private constructor(private props: ReportJobProps) {}

  static request(
    input: Pick<ReportJobProps, "id" | "reportId" | "params" | "format" | "requestedBy"> &
      Partial<Pick<ReportJobProps, "scheduleId" | "recipients">> &
      Readonly<{ now: Date }>,
  ): ReportJob {
    const { now, scheduleId, recipients, ...rest } = input;
    return new ReportJob({
      ...rest,
      scheduleId: scheduleId ?? null,
      recipients: recipients ?? [],
      status: "queued",
      rowCount: null,
      fileId: null,
      error: null,
      createdAt: now,
      startedAt: null,
      finishedAt: null,
      expiresAt: null,
    });
  }

  static restore(props: ReportJobProps): ReportJob {
    return new ReportJob(props);
  }

  get id(): string {
    return this.props.id;
  }

  get status(): ReportJobStatus {
    return this.props.status;
  }

  snapshot(): ReportJobProps {
    return this.props;
  }

  /** Who may see the job: whoever asked for it and the schedule's recipients. */
  isFor(userId: string): boolean {
    return this.props.requestedBy === userId || this.props.recipients.includes(userId);
  }

  /** Taken by the worker; a job left running (a lost attempt) is taken again. */
  start(now: Date): boolean {
    if (this.props.status !== "queued" && this.props.status !== "running") return false;
    this.props = { ...this.props, status: "running", startedAt: now };
    return true;
  }

  complete(fileId: string, rowCount: number, now: Date): void {
    if (this.props.status !== "running") throw new ReportRuleError("The report is not being built");
    this.props = {
      ...this.props,
      status: "ready",
      fileId,
      rowCount,
      finishedAt: now,
      expiresAt: new Date(now.getTime() + REPORT_KEEP_DAYS * DAY_MS),
    };
  }

  fail(reason: string, now: Date): void {
    if (this.props.status !== "queued" && this.props.status !== "running") return;
    this.props = {
      ...this.props,
      status: "failed",
      error: reason.trim().slice(0, 500) || "The report could not be built",
      finishedAt: now,
    };
  }

  /** Past its keeping time: the file is removed. */
  expire(): void {
    if (this.props.status !== "ready") throw new ReportRuleError("Only a ready report expires");
    this.props = { ...this.props, status: "expired" };
  }
}
