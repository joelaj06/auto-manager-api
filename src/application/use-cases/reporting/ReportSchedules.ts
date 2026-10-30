import {
  checkParams,
  MAX_ACTIVE_PER_TENANT,
  MAX_ACTIVE_PER_USER,
  ReportJob,
  ReportRuleError,
  type FileFormat,
  type ParamValues,
} from "../../../domain/reporting/Report.js";
import { addDays } from "../../../domain/reporting/DateRange.js";
import {
  MAX_SCHEDULES,
  nextRunDay,
  ReportSchedule,
  runParams,
  type ScheduleDetails,
  type ScheduleFrequency,
  type SchedulePeriod,
  type ScheduleStatus,
  type ScheduleTiming,
} from "../../../domain/reporting/ReportSchedule.js";
import { PermissionDeniedError } from "../../errors/AuthErrors.js";
import { ApplicationError } from "../../errors/ApplicationError.js";
import type { Principal } from "../../authorization/Principal.js";
import type { IAuditTrail } from "../../ports/IAuditTrail.js";
import type { IClock } from "../../ports/IClock.js";
import type { IIdGenerator } from "../../ports/IIdGenerator.js";
import type { IOrganisationSettings } from "../../ports/IOrganisationSettings.js";
import type { IPermissionResolver } from "../../ports/IPermissionResolver.js";
import type { IReportJobQueue, IReportJobs } from "../../ports/IReportJobs.js";
import type { IReportSchedules } from "../../ports/IReportSchedules.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import type { ITenantContext } from "../../ports/ITenantContext.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import { localDateTime, localMidnight } from "../../services/TenantLocalTime.js";
import { recordAction, recordUserAction } from "../reference/userAudit.js";
import type { ReportDefinition } from "./ReportDefinition.js";
import { ReportBusyError, ReportNotFoundError } from "./Reports.js";
import { reportPrincipal } from "./reportPrincipal.js";

export class ReportScheduleNotFoundError extends ApplicationError {
  readonly code = "REPORT_SCHEDULE_NOT_FOUND";
  constructor() {
    super("Report schedule not found");
  }
}

const PERMISSION = "reports.schedules.manage" as const;
/** Schedules started by one sweep of a business. */
const DUE_BATCH = 50;
/** The parameters a period fills in. */
const PERIOD_KEYS = ["from", "to", "asOf", "month"];

export type ScheduleInput = Readonly<{
  name: string;
  reportId: string;
  params: unknown;
  period: SchedulePeriod | null;
  format: FileFormat;
  frequency: ScheduleFrequency;
  weekday: number | null;
  monthDay: number | null;
  hour: number;
  recipients: readonly string[];
}>;

export type ReportScheduleView = Readonly<{
  id: string;
  name: string;
  reportId: string;
  reportTitle: string;
  params: ParamValues;
  period: SchedulePeriod | null;
  format: FileFormat;
  frequency: ScheduleFrequency;
  weekday: number | null;
  monthDay: number | null;
  hour: number;
  recipients: readonly string[];
  status: ScheduleStatus;
  ownerId: string;
  nextRunAt: Date;
  lastRunAt: Date | null;
  lastJobId: string | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}>;

/**
 * Scheduled reports (docs/14 §7, decisions 474–477): a catalogue report with its parameters and
 * a period worked out on the run day, built as a CSV, XLSX or PDF file daily, weekly or monthly at
 * a local hour as the schedule's owner and sent to up to 20 users of the business who may run it.
 * A sweep every 15 minutes starts the runs due; a run waits while the business has four files
 * being built, and a schedule whose owner may no longer run the report is paused.
 */
export class ReportSchedules {
  constructor(
    private readonly deps: Readonly<{
      definitions: readonly ReportDefinition[];
      schedules: IReportSchedules;
      jobs: IReportJobs;
      queue: IReportJobQueue;
      permissions: IPermissionResolver;
      tenantContext: ITenantContext;
      organisation: IOrganisationSettings;
      unitOfWork: IUnitOfWork;
      auditTrail: IAuditTrail;
      requestContext: IRequestContext;
      ids: IIdGenerator;
      clock: IClock;
    }>,
  ) {}

  list(actor: Principal): Promise<ReportScheduleView[]> {
    const { deps } = this;
    const grant = this.grant(actor);
    return deps.unitOfWork.run(async () =>
      (await deps.schedules.list(grant.scope === "all" ? null : actor.userId)).map((s) =>
        this.view(s),
      ),
    );
  }

  get(actor: Principal, id: string): Promise<ReportScheduleView> {
    return this.deps.unitOfWork.run(async () =>
      this.view(this.reach(actor, await this.deps.schedules.get(id))),
    );
  }

  create(actor: Principal, input: ScheduleInput): Promise<ReportScheduleView> {
    const { deps } = this;
    this.grant(actor);
    return deps.unitOfWork.run(async () => {
      if ((await deps.schedules.count()) >= MAX_SCHEDULES)
        throw new ReportRuleError(`A business has at most ${MAX_SCHEDULES} report schedules`);
      const now = deps.clock.now();
      const timezone = await this.timezone();
      const details = await this.details(actor.userId, input, timezone, now);
      const schedule = ReportSchedule.create({
        ...details,
        id: deps.ids.next(),
        ownerId: actor.userId,
        nextRunAt: nextRunAt(details, timezone, now),
        now,
      });
      await deps.schedules.insert(schedule);
      await recordUserAction(deps, actor.userId, {
        action: "report_schedule.created",
        entityType: "report_schedule",
        entityId: schedule.id,
        after: auditOf(schedule),
      });
      return this.view(schedule);
    });
  }

  /** Changed by its owner or a manager of all schedules; it still runs as its owner. */
  change(actor: Principal, id: string, input: ScheduleInput): Promise<ReportScheduleView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const schedule = this.reach(actor, await deps.schedules.lock(id));
      const before = auditOf(schedule);
      const now = deps.clock.now();
      const timezone = await this.timezone();
      const details = await this.details(schedule.snapshot().ownerId, input, timezone, now);
      schedule.change(details, nextRunAt(details, timezone, now), now);
      await deps.schedules.update(schedule);
      await recordUserAction(deps, actor.userId, {
        action: "report_schedule.changed",
        entityType: "report_schedule",
        entityId: schedule.id,
        before,
        after: auditOf(schedule),
      });
      return this.view(schedule);
    });
  }

  pause(actor: Principal, id: string): Promise<ReportScheduleView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const schedule = this.reach(actor, await deps.schedules.lock(id));
      schedule.pause(null, deps.clock.now());
      await deps.schedules.update(schedule);
      await recordUserAction(deps, actor.userId, {
        action: "report_schedule.paused",
        entityType: "report_schedule",
        entityId: schedule.id,
      });
      return this.view(schedule);
    });
  }

  /** Active again from the next run day after now (runs missed while paused are not made up). */
  resume(actor: Principal, id: string): Promise<ReportScheduleView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const schedule = this.reach(actor, await deps.schedules.lock(id));
      const s = schedule.snapshot();
      const owner = await reportPrincipal(deps, s.ownerId, `report_schedule:${s.id}`);
      if (owner === null || owner.grantFor(this.definition(s.reportId).permission) === undefined)
        throw new ReportRuleError("The schedule's owner may no longer run this report");
      const now = deps.clock.now();
      schedule.resume(nextRunAt(s, await this.timezone(), now), now);
      await deps.schedules.update(schedule);
      await recordUserAction(deps, actor.userId, {
        action: "report_schedule.resumed",
        entityType: "report_schedule",
        entityId: schedule.id,
      });
      return this.view(schedule);
    });
  }

  /** Removed; the runs already built stay with their recipients until they expire. */
  remove(actor: Principal, id: string): Promise<void> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const schedule = this.reach(actor, await deps.schedules.lock(id));
      await deps.schedules.remove(schedule.id);
      await recordUserAction(deps, actor.userId, {
        action: "report_schedule.removed",
        entityType: "report_schedule",
        entityId: schedule.id,
        before: auditOf(schedule),
      });
    });
  }

  /** A run now, as a manual request of the owner (their limits apply); the next run stays. */
  runNow(actor: Principal, id: string): Promise<ReportScheduleView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const schedule = this.reach(actor, await deps.schedules.lock(id));
      if (schedule.status !== "active") throw new ReportRuleError("The schedule is paused");
      const s = schedule.snapshot();
      const definition = this.definition(s.reportId);
      const owner = await reportPrincipal(deps, s.ownerId, `report_schedule:${s.id}`);
      if (owner === null || owner.grantFor(definition.permission) === undefined)
        throw new ReportRuleError("The schedule's owner may no longer run this report");
      const active = await deps.jobs.active(s.ownerId);
      if (active.user >= MAX_ACTIVE_PER_USER || active.tenant >= MAX_ACTIVE_PER_TENANT)
        throw new ReportBusyError("Several reports are being built: try again in a few minutes");
      const now = deps.clock.now();
      const today = localDateTime(now, await this.timezone()).date;
      const job = await this.queue(schedule, definition, today, now);
      schedule.ran(job.id, s.nextRunAt, now);
      await deps.schedules.update(schedule);
      await recordUserAction(deps, actor.userId, {
        action: "report_schedule.run",
        entityType: "report_schedule",
        entityId: schedule.id,
        after: { reportJobId: job.id },
      });
      return this.view(schedule);
    });
  }

  /**
   * The sweep of a business: each schedule due is queued as its owner and moved to its next run;
   * while four files are being built the rest wait for the next sweep. A schedule whose report is
   * gone, or whose owner may no longer run it, is paused with the reason.
   */
  async runDue(): Promise<number> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const now = deps.clock.now();
      const timezone = await this.timezone();
      const today = localDateTime(now, timezone).date;
      let queued = 0;
      for (const schedule of await deps.schedules.due(now, DUE_BATCH)) {
        const s = schedule.snapshot();
        const next = nextRunAt(s, timezone, now);
        const definition = deps.definitions.find((d) => d.id === s.reportId);
        const owner = await reportPrincipal(deps, s.ownerId, `report_schedule:${s.id}`);
        let reason: string | null = null;
        if (definition === undefined) reason = "The report is no longer offered";
        else if (owner === null || owner.grantFor(definition.permission) === undefined)
          reason = "The schedule's owner may no longer run this report";
        if (reason !== null || definition === undefined) {
          schedule.pause(reason, now);
          await deps.schedules.update(schedule);
          await recordAction(deps, null, {
            action: "report_schedule.paused",
            entityType: "report_schedule",
            entityId: s.id,
            after: { reason },
          });
          continue;
        }
        if ((await deps.jobs.active(s.ownerId)).tenant >= MAX_ACTIVE_PER_TENANT) {
          schedule.missed("Several reports were being built: the run waits", s.nextRunAt, now);
          await deps.schedules.update(schedule);
          continue;
        }
        try {
          const job = await this.queue(schedule, definition, today, now);
          schedule.ran(job.id, next, now);
          queued += 1;
        } catch (error) {
          if (!(error instanceof ReportRuleError)) throw error;
          schedule.missed(error.message, next, now);
        }
        await deps.schedules.update(schedule);
      }
      return queued;
    });
  }

  /** The run's job, as the owner, sent to the recipients (inside the unit of work). */
  private async queue(
    schedule: ReportSchedule,
    definition: ReportDefinition,
    today: string,
    now: Date,
  ): Promise<ReportJob> {
    const { deps } = this;
    const s = schedule.snapshot();
    const params = checkParams(
      definition.params,
      runParams(
        s,
        definition.params.map((p) => p.key),
        today,
      ),
    );
    const job = ReportJob.request({
      id: deps.ids.next(),
      reportId: definition.id,
      params,
      format: s.format,
      requestedBy: s.ownerId,
      scheduleId: s.id,
      recipients: s.recipients,
      now,
    });
    await deps.jobs.insert(job);
    deps.queue.request(job.id);
    return job;
  }

  /**
   * The schedule's details checked as its owner: a report they may run, parameters that pass on
   * the first run day, and recipients who are active users able to run the report.
   */
  private async details(
    ownerId: string,
    input: ScheduleInput,
    timezone: string,
    now: Date,
  ): Promise<ScheduleDetails> {
    const { deps } = this;
    const definition = this.definition(input.reportId);
    const owner = await reportPrincipal(deps, ownerId, `report_schedule:${ownerId}`);
    if (owner === null || owner.grantFor(definition.permission) === undefined)
      throw new PermissionDeniedError(definition.permission);
    const keys = definition.params.map((p) => p.key);
    if (input.period !== null && !keys.some((k) => PERIOD_KEYS.includes(k)))
      throw new ReportRuleError("This report takes no period: leave the period out");
    const given = input.params ?? {};
    if (given === null || typeof given !== "object" || Array.isArray(given))
      throw new ReportRuleError("Report parameters are an object");
    // The parameters a run would use pass the report's checks; the period's are not kept.
    const checked = checkParams(
      definition.params,
      runParams(
        { params: given as ParamValues, period: input.period },
        keys,
        localDateTime(now, timezone).date,
      ),
    );
    const params = Object.fromEntries(
      Object.entries(checked).filter(([k]) => input.period === null || !PERIOD_KEYS.includes(k)),
    );
    for (const userId of new Set(input.recipients)) {
      const recipient = await reportPrincipal(deps, userId, `report_schedule:${ownerId}`);
      if (recipient === null)
        throw new ReportRuleError(`Recipient ${userId} is not an active user of the business`);
      if (recipient.grantFor(definition.permission) === undefined)
        throw new ReportRuleError(`Recipient ${userId} may not run this report`);
    }
    return {
      name: input.name,
      reportId: definition.id,
      params,
      period: input.period,
      format: input.format,
      frequency: input.frequency,
      weekday: input.weekday,
      monthDay: input.monthDay,
      hour: input.hour,
      recipients: input.recipients,
    };
  }

  private grant(actor: Principal) {
    const grant = actor.grantFor(PERMISSION);
    if (grant === undefined) throw new PermissionDeniedError(PERMISSION);
    return grant;
  }

  /** The schedule if the actor reaches it: their own, or any with the `all` scope. */
  private reach(actor: Principal, schedule: ReportSchedule | null): ReportSchedule {
    const grant = this.grant(actor);
    if (
      schedule === null ||
      (grant.scope !== "all" && schedule.snapshot().ownerId !== actor.userId)
    )
      throw new ReportScheduleNotFoundError();
    return schedule;
  }

  private definition(id: string): ReportDefinition {
    const definition = this.deps.definitions.find((d) => d.id === id);
    if (definition === undefined) throw new ReportNotFoundError();
    return definition;
  }

  private async timezone(): Promise<string> {
    return (await this.deps.organisation.get()).timezone;
  }

  private view(schedule: ReportSchedule): ReportScheduleView {
    const s = schedule.snapshot();
    return {
      id: s.id,
      name: s.name,
      reportId: s.reportId,
      reportTitle: this.deps.definitions.find((d) => d.id === s.reportId)?.title ?? s.reportId,
      params: s.params,
      period: s.period,
      format: s.format,
      frequency: s.frequency,
      weekday: s.weekday,
      monthDay: s.monthDay,
      hour: s.hour,
      recipients: s.recipients,
      status: s.status,
      ownerId: s.ownerId,
      nextRunAt: s.nextRunAt,
      lastRunAt: s.lastRunAt,
      lastJobId: s.lastJobId,
      lastError: s.lastError,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    };
  }
}

/** The first run after `after`: the local hour of the next run day. */
export function nextRunAt(timing: ScheduleTiming, timezone: string, after: Date): Date {
  const at = (day: string) =>
    new Date(localMidnight(day, timezone).getTime() + timing.hour * 3_600_000);
  const day = nextRunDay(timing, localDateTime(after, timezone).date);
  const first = at(day);
  return first > after ? first : at(nextRunDay(timing, addDays(day, 1)));
}

function auditOf(schedule: ReportSchedule): Record<string, unknown> {
  const s = schedule.snapshot();
  return {
    name: s.name,
    reportId: s.reportId,
    params: s.params,
    period: s.period,
    format: s.format,
    frequency: s.frequency,
    weekday: s.weekday,
    monthDay: s.monthDay,
    hour: s.hour,
    recipients: s.recipients,
    status: s.status,
  };
}
