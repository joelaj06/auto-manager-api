import { DomainError } from "../../../domain/errors/DomainError.js";
import { Money, type MoneyJson } from "../../../domain/money/Money.js";
import {
  checkParams,
  MAX_ACTIVE_PER_TENANT,
  MAX_ACTIVE_PER_USER,
  MAX_FILE_ROWS,
  MAX_JSON_ROWS,
  ReportJob,
  ReportRuleError,
  type Cell,
  type FileFormat,
  type ParamValues,
  type ReportCategory,
  type ReportColumn,
  type ReportFormat,
  type ReportJobStatus,
  type ReportParam,
  type ReportTable,
} from "../../../domain/reporting/Report.js";
import { PermissionDeniedError } from "../../errors/AuthErrors.js";
import { ApplicationError } from "../../errors/ApplicationError.js";
import type { Principal } from "../../authorization/Principal.js";
import type { IAuditTrail } from "../../ports/IAuditTrail.js";
import type { IClock } from "../../ports/IClock.js";
import type { IIdGenerator } from "../../ports/IIdGenerator.js";
import type { ILogger } from "../../ports/ILogger.js";
import type { INotificationSettingsStore } from "../../ports/INotifications.js";
import type { IPermissionResolver } from "../../ports/IPermissionResolver.js";
import type { IReportJobQueue, IReportJobs } from "../../ports/IReportJobs.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import type { ITenantContext } from "../../ports/ITenantContext.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import type { FileService } from "../files/FileService.js";
import type { Notifier } from "../notifications/Notifier.js";
import { recordUserAction } from "../reference/userAudit.js";
import type { ReportDefinition } from "./ReportDefinition.js";
import type { ReportFiles } from "./ReportFiles.js";
import { reportPrincipal } from "./reportPrincipal.js";

export class ReportNotFoundError extends ApplicationError {
  readonly code = "REPORT_NOT_FOUND";
  constructor() {
    super("Report not found");
  }
}

export class ReportJobNotFoundError extends ApplicationError {
  readonly code = "REPORT_JOB_NOT_FOUND";
  constructor() {
    super("Report job not found");
  }
}

/** Too many report files being built at once (429). */
export class ReportBusyError extends ApplicationError {
  readonly code = "REPORT_BUSY";
  constructor(message: string) {
    super(message);
  }
}

const JOBS_LISTED = 50;
const SWEEP_BATCH = 200;
/** A job queued or running this long was lost: it fails. */
const STALE_MS = 6 * 3_600_000;

export type CatalogueEntry = Readonly<{
  id: string;
  title: string;
  description: string;
  category: ReportCategory;
  params: readonly ReportParam[];
  formats: readonly ReportFormat[];
}>;

/** A table as JSON: money cells with their currency and formatting. */
export type TableView = Readonly<{
  reportId: string;
  title: string;
  subtitle: string | null;
  currency: string;
  columns: readonly ReportColumn[];
  rows: readonly Readonly<Record<string, Cell | MoneyJson>>[];
  totals: Readonly<Record<string, Cell | MoneyJson>> | null;
  summary: ReportTable["summary"];
}>;

export type ReportJobView = Readonly<{
  id: string;
  reportId: string;
  title: string;
  params: ParamValues;
  format: FileFormat;
  status: ReportJobStatus;
  rowCount: number | null;
  error: string | null;
  createdAt: Date;
  finishedAt: Date | null;
  expiresAt: Date | null;
  /** When ready: a short-lived link to the file. */
  download: Readonly<{
    url: string;
    expiresAt: Date | null;
    filename: string;
    sizeBytes: number;
  }> | null;
}>;

export type RunResult =
  Readonly<{ kind: "table"; table: TableView }> | Readonly<{ kind: "job"; job: ReportJobView }>;

/**
 * The report engine (docs/14 §2, §7, decisions 463–466): the catalogue of the reports defined in
 * code that the user may run; a report answered at once as JSON, or queued as a CSV, XLSX or PDF
 * file built by a background job as the user who asked (their permissions checked again), kept
 * privately for 7 days and downloaded by a short-lived link, with a notice when it is ready.
 * At most four files are built at once per business and two per user.
 */
export class Reports {
  constructor(
    private readonly deps: Readonly<{
      definitions: readonly ReportDefinition[];
      jobs: IReportJobs;
      queue: IReportJobQueue;
      files: FileService;
      render: ReportFiles;
      permissions: IPermissionResolver;
      tenantContext: ITenantContext;
      notifier: Notifier;
      settings: INotificationSettingsStore;
      unitOfWork: IUnitOfWork;
      auditTrail: IAuditTrail;
      requestContext: IRequestContext;
      ids: IIdGenerator;
      clock: IClock;
      logger: ILogger;
    }>,
  ) {}

  catalogue(actor: Principal): CatalogueEntry[] {
    return this.deps.definitions
      .filter((d) => actor.grantFor(d.permission) !== undefined)
      .map((d) => ({
        id: d.id,
        title: d.title,
        description: d.description,
        category: d.category,
        params: d.params,
        formats: ["json", "csv", "xlsx", "pdf"] as const,
      }))
      .sort((a, b) =>
        a.category === b.category
          ? a.title.localeCompare(b.title)
          : a.category < b.category
            ? -1
            : 1,
      );
  }

  async run(
    actor: Principal,
    reportId: string,
    input: Readonly<{ params: unknown; format: ReportFormat }>,
  ): Promise<RunResult> {
    const { deps } = this;
    const definition = this.definition(reportId);
    if (actor.grantFor(definition.permission) === undefined)
      throw new PermissionDeniedError(definition.permission);
    const params = checkParams(definition.params, input.params ?? {});
    if (input.format === "json") {
      const table = await definition.run(actor, params);
      if (table.rows.length > MAX_JSON_ROWS)
        throw new ReportRuleError(
          `The report has ${table.rows.length} rows, more than ${MAX_JSON_ROWS} shown on screen: ask for a CSV or XLSX file, or narrow it`,
        );
      return { kind: "table", table: tableView(definition.id, table) };
    }
    const format = input.format;
    const job = await deps.unitOfWork.run(async () => {
      const active = await deps.jobs.active(actor.userId);
      if (active.user >= MAX_ACTIVE_PER_USER)
        throw new ReportBusyError(
          `You have ${active.user} reports being built: wait for one to finish`,
        );
      if (active.tenant >= MAX_ACTIVE_PER_TENANT)
        throw new ReportBusyError("Several reports are being built: try again in a few minutes");
      const job = ReportJob.request({
        id: deps.ids.next(),
        reportId: definition.id,
        params,
        format,
        requestedBy: actor.userId,
        now: deps.clock.now(),
      });
      await deps.jobs.insert(job);
      await recordUserAction(deps, actor.userId, {
        action: "report.requested",
        entityType: "report_job",
        entityId: job.id,
        after: { reportId: definition.id, format, params },
      });
      deps.queue.request(job.id);
      return job;
    });
    return { kind: "job", job: await this.view(job) };
  }

  jobs(actor: Principal): Promise<ReportJobView[]> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const jobs = await deps.jobs.listFor(actor.userId, JOBS_LISTED);
      return Promise.all(jobs.filter((j) => this.sees(actor, j)).map((j) => this.view(j, false)));
    });
  }

  /** The user's own job, or a scheduled run sent to them, with the download link when ready. */
  async jobFor(actor: Principal, id: string): Promise<ReportJobView> {
    const { deps } = this;
    const job = await deps.unitOfWork.run(() => deps.jobs.get(id));
    if (job === null || !this.sees(actor, job)) throw new ReportJobNotFoundError();
    return this.view(job);
  }

  /** The requester sees their job; a recipient while they may still run the report. */
  private sees(actor: Principal, job: ReportJob): boolean {
    const j = job.snapshot();
    if (j.requestedBy === actor.userId) return true;
    if (!job.isFor(actor.userId)) return false;
    const definition = this.deps.definitions.find((d) => d.id === j.reportId);
    return definition !== undefined && actor.grantFor(definition.permission) !== undefined;
  }

  /** The worker: builds the file as the user who asked (idempotent). */
  async generate(jobId: string): Promise<void> {
    const { deps } = this;
    const job = await deps.unitOfWork.run(async () => {
      const job = await deps.jobs.lock(jobId);
      if (job === null || !job.start(deps.clock.now())) return null;
      await deps.jobs.update(job);
      return job;
    });
    if (job === null) return;
    const j = job.snapshot();
    try {
      const definition = deps.definitions.find((d) => d.id === j.reportId);
      if (definition === undefined) throw new ReportRuleError("The report is no longer offered");
      const actor = await this.actor(j.requestedBy, j.id);
      if (actor === null || actor.grantFor(definition.permission) === undefined)
        throw new ReportRuleError("You may no longer run this report");
      const table = await definition.run(actor, j.params);
      const max = MAX_FILE_ROWS[j.format];
      if (table.rows.length > max)
        throw new ReportRuleError(
          `The report has ${table.rows.length} rows; a ${j.format.toUpperCase()} file holds at most ${max}: narrow it`,
        );
      const file = await deps.render.render(table, j.format, {
        ...(definition.landscape === undefined ? {} : { landscape: definition.landscape }),
      });
      const stored = await deps.files.storeGenerated({
        kind: "report_export",
        filename: `${definition.id}-${j.createdAt.toISOString().slice(0, 10)}.${file.extension}`,
        contentType: file.contentType,
        content: file.content,
        owner: { type: "report_job", id: j.id },
        createdBy: j.requestedBy,
      });
      await deps.unitOfWork.run(async () => {
        const locked = (await deps.jobs.lock(j.id))!;
        locked.complete(stored.id, table.rows.length, deps.clock.now());
        await deps.jobs.update(locked);
        if (j.scheduleId === null)
          await deps.notifier.users(await deps.settings.get(), {
            rule: "report_ready",
            userIds: [j.requestedBy],
            dedupeKey: `report_ready:${j.id}`,
            title: `${definition.title} is ready`,
            body: `Your ${j.format.toUpperCase()} report (${table.rows.length} rows) can be downloaded for 7 days.`,
            severity: "info",
            data: { reportJobId: j.id },
          });
      });
      if (j.scheduleId !== null) await this.send(j.id, definition, table.rows.length);
    } catch (error) {
      const known = error instanceof DomainError || error instanceof ApplicationError;
      if (!known)
        deps.logger.error("Report job failed", {
          reportJobId: j.id,
          reportId: j.reportId,
          error: error instanceof Error ? error.message : String(error),
        });
      await deps.unitOfWork.run(async () => {
        const locked = await deps.jobs.lock(j.id);
        if (locked === null) return;
        locked.fail(known ? error.message : "The report could not be built", deps.clock.now());
        await deps.jobs.update(locked);
      });
    }
  }

  /**
   * A scheduled run is sent to its recipients who may still run the report (decision 476): a
   * notice in the app and by email to sign in and download it within the 7 days (no attachment).
   */
  private async send(jobId: string, definition: ReportDefinition, rows: number): Promise<void> {
    const { deps } = this;
    const job = await deps.unitOfWork.run(() => deps.jobs.get(jobId));
    if (job === null) return;
    const j = job.snapshot();
    const userIds: string[] = [];
    for (const userId of j.recipients) {
      const recipient = await this.actor(userId, j.id);
      if (recipient !== null && recipient.grantFor(definition.permission) !== undefined)
        userIds.push(userId);
    }
    if (userIds.length === 0) return;
    await deps.unitOfWork.run(async () =>
      deps.notifier.users(await deps.settings.get(), {
        rule: "scheduled_report",
        userIds,
        dedupeKey: `scheduled_report:${j.id}`,
        title: `${definition.title}: your scheduled report`,
        body: `The ${j.format.toUpperCase()} file (${rows} rows) is ready. Sign in and open Reports to download it within 7 days.`,
        severity: "info",
        data: { reportJobId: j.id, reportScheduleId: j.scheduleId ?? "" },
      }),
    );
  }

  /** Daily: files past their 7 days are removed; jobs lost on the way fail. */
  async sweep(): Promise<void> {
    const { deps } = this;
    const now = deps.clock.now();
    for (const id of await deps.unitOfWork.run(() => deps.jobs.expired(now, SWEEP_BATCH))) {
      const fileId = await deps.unitOfWork.run(async () => {
        const job = await deps.jobs.lock(id);
        if (job === null || job.status !== "ready") return null;
        job.expire();
        await deps.jobs.update(job);
        return job.snapshot().fileId;
      });
      if (fileId !== null) await deps.files.remove(fileId);
    }
    const before = new Date(now.getTime() - STALE_MS);
    for (const id of await deps.unitOfWork.run(() => deps.jobs.stale(before, SWEEP_BATCH)))
      await deps.unitOfWork.run(async () => {
        const job = await deps.jobs.lock(id);
        if (job === null) return;
        job.fail("The report was not built in time: ask for it again", now);
        await deps.jobs.update(job);
      });
  }

  private definition(id: string): ReportDefinition {
    const definition = this.deps.definitions.find((d) => d.id === id);
    if (definition === undefined) throw new ReportNotFoundError();
    return definition;
  }

  /** The requester as they are now (null when disabled or gone). */
  private actor(userId: string, jobId: string): Promise<Principal | null> {
    return reportPrincipal(this.deps, userId, `report:${jobId}`);
  }

  private async view(job: ReportJob, withLink = true): Promise<ReportJobView> {
    const j = job.snapshot();
    const file =
      withLink && j.status === "ready" && j.fileId !== null
        ? await this.deps.files.get(j.fileId)
        : null;
    return {
      id: j.id,
      reportId: j.reportId,
      title: this.deps.definitions.find((d) => d.id === j.reportId)?.title ?? j.reportId,
      params: j.params,
      format: j.format,
      status: j.status,
      rowCount: j.rowCount,
      error: j.error,
      createdAt: j.createdAt,
      finishedAt: j.finishedAt,
      expiresAt: j.expiresAt,
      download:
        file === null || file.url === null
          ? null
          : {
              url: file.url,
              expiresAt: file.urlExpiresAt,
              filename: file.filename,
              sizeBytes: file.sizeBytes,
            },
    };
  }
}

export function tableView(reportId: string, table: ReportTable): TableView {
  const money = new Set(table.columns.filter((c) => c.type === "money").map((c) => c.key));
  const row = (r: Readonly<Record<string, Cell>>) =>
    Object.fromEntries(
      table.columns.map((c) => {
        const value = r[c.key] ?? null;
        return [
          c.key,
          money.has(c.key) && typeof value === "number"
            ? Money.ofMinor(value, table.currency).toJSON()
            : value,
        ];
      }),
    );
  return {
    reportId,
    title: table.title,
    subtitle: table.subtitle,
    currency: table.currency,
    columns: table.columns,
    rows: table.rows.map(row),
    totals: table.totals === null ? null : row(table.totals),
    summary: table.summary,
  };
}
