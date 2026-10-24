import {
  DPR_RESPONSE_DAYS,
  nextQuarterEnd,
  overallStatus,
  quarterEnd,
  STATUS_COMPONENTS,
  type OverallStatus,
} from "../../../domain/console/Compliance.js";
import type { ICommunicationsRepository } from "../../../domain/repositories/ICommunicationsRepository.js";
import type {
  DataProtectionRequest,
  DprKind,
  DprStatus,
  DrillOutcome,
  IDataProtectionRequestRepository,
  IIncidentRepository,
  Incident,
  IncidentImpact,
  IncidentStatus,
  IRestoreDrillRepository,
  RestoreDrill,
} from "../../../domain/repositories/IComplianceRepositories.js";
import type { PlatformPrincipal } from "../../authorization/PlatformPrincipal.js";
import { ApplicationError } from "../../errors/ApplicationError.js";
import type { IJobHandler } from "../../jobs/IJobHandler.js";
import type { IClock } from "../../ports/IClock.js";
import type { IIdGenerator } from "../../ports/IIdGenerator.js";
import type { ILogger } from "../../ports/ILogger.js";
import type { IPlatformAuditTrail } from "../../ports/IPlatformAuditTrail.js";
import type { IPlatformUnitOfWork } from "../../ports/IPlatformUnitOfWork.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import { recordStaffAction } from "./consoleAudit.js";
import type { IAlerts } from "./PlatformAlerts.js";

export class ComplianceNotFoundError extends ApplicationError {
  readonly code = "COMPLIANCE_RECORD_NOT_FOUND";
  constructor() {
    super("Record not found");
  }
}

export class ComplianceRuleError extends ApplicationError {
  readonly code = "COMPLIANCE_RULE";
  constructor(message: string) {
    super(message);
  }
}

const DAY_MS = 86_400_000;
const today = (now: Date) => now.toISOString().slice(0, 10);

type Deps = Readonly<{
  unitOfWork: IPlatformUnitOfWork;
  audit: IPlatformAuditTrail;
  requestContext: IRequestContext;
  ids: IIdGenerator;
  clock: IClock;
}>;

/**
 * The data-protection request tracker (docs/27 §3.15): access, correction, erasure and objection
 * requests with a deadline (30 days by default), an owner, every step taken, and the outcome.
 * Erasure itself is anonymisation by a four-eyes action still to come; the tracker keeps the
 * evidence. Deadlines reach the alerts centre.
 */
export class DataProtectionRequests {
  constructor(
    private readonly deps: Deps & Readonly<{ requests: IDataProtectionRequestRepository }>,
  ) {}

  async open(
    input: Readonly<{
      kind: DprKind;
      tenantId?: string | null;
      requesterName: string;
      requesterContact: string;
      subject: string;
      receivedAt: Date;
      dueAt?: Date;
    }>,
    actor: PlatformPrincipal,
  ): Promise<DataProtectionRequest> {
    const { deps } = this;
    const now = deps.clock.now();
    if (input.receivedAt > now)
      throw new ComplianceRuleError("A request cannot be received in the future");
    const request: DataProtectionRequest = {
      id: deps.ids.next(),
      code: await deps.requests.nextCode(input.receivedAt.getUTCFullYear()),
      kind: input.kind,
      tenantId: input.tenantId ?? null,
      requesterName: input.requesterName.trim(),
      requesterContact: input.requesterContact.trim(),
      subject: input.subject.trim(),
      receivedAt: input.receivedAt,
      dueAt: input.dueAt ?? new Date(input.receivedAt.getTime() + DPR_RESPONSE_DAYS * DAY_MS),
      status: "open",
      assignedTo: actor.userId,
      steps: [{ at: now, by: actor.userId, note: "Request logged" }],
      outcome: null,
      closedAt: null,
      createdBy: actor.userId,
      createdAt: now,
    };
    await deps.unitOfWork.run(async () => {
      await deps.requests.save(request);
      await this.audit(actor, "dpr.opened", request);
    });
    return request;
  }

  async step(
    id: string,
    input: Readonly<{ note: string; assignTo?: string | null }>,
    actor: PlatformPrincipal,
  ): Promise<DataProtectionRequest> {
    return this.change(id, actor, "dpr.step", (r, now) => {
      if (r.status === "completed" || r.status === "rejected")
        throw new ComplianceRuleError("This request is closed");
      return {
        ...r,
        status: "in_progress",
        assignedTo: input.assignTo === undefined ? r.assignedTo : input.assignTo,
        steps: [...r.steps, { at: now, by: actor.userId, note: input.note.trim() }],
      };
    });
  }

  async close(
    id: string,
    input: Readonly<{ status: Extract<DprStatus, "completed" | "rejected">; outcome: string }>,
    actor: PlatformPrincipal,
  ): Promise<DataProtectionRequest> {
    return this.change(id, actor, "dpr.closed", (r, now) => {
      if (r.status === "completed" || r.status === "rejected")
        throw new ComplianceRuleError("This request is already closed");
      return {
        ...r,
        status: input.status,
        outcome: input.outcome.trim(),
        closedAt: now,
        steps: [
          ...r.steps,
          { at: now, by: actor.userId, note: `${input.status}: ${input.outcome.trim()}` },
        ],
      };
    });
  }

  list(filter: Readonly<{ status?: DprStatus; openOnly?: boolean; limit: number }>) {
    return this.deps.requests.list(filter);
  }

  async get(id: string): Promise<DataProtectionRequest> {
    const r = await this.deps.requests.find(id);
    if (r === null) throw new ComplianceNotFoundError();
    return r;
  }

  /** Open requests due within `days` (the daily check). */
  dueWithin(days: number): Promise<DataProtectionRequest[]> {
    return this.deps.requests.dueBefore(new Date(this.deps.clock.now().getTime() + days * DAY_MS));
  }

  private async change(
    id: string,
    actor: PlatformPrincipal,
    action: string,
    apply: (r: DataProtectionRequest, now: Date) => DataProtectionRequest,
  ): Promise<DataProtectionRequest> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const r = await deps.requests.find(id, true);
      if (r === null) throw new ComplianceNotFoundError();
      const updated = apply(r, deps.clock.now());
      await deps.requests.save(updated);
      await this.audit(actor, action, updated);
      return updated;
    });
  }

  private audit(actor: PlatformPrincipal, action: string, r: DataProtectionRequest): Promise<void> {
    return recordStaffAction(this.deps, actor, {
      action,
      entityType: "data_protection_request",
      entityId: r.id,
      targetTenantId: r.tenantId,
      after: { code: r.code, kind: r.kind, status: r.status, dueAt: r.dueAt },
    });
  }
}

/** What the public status page shows (docs/27 §3.1). */
export type PublicStatus = Readonly<{
  status: OverallStatus;
  components: readonly Readonly<{ name: string; status: OverallStatus }>[];
  /** Public: never who opened it. */
  incidents: readonly Omit<Incident, "createdBy">[];
  maintenance: readonly Readonly<{
    title: string;
    message: string;
    startsAt: Date;
    endsAt: Date;
    readOnly: boolean;
  }>[];
  updatedAt: Date;
}>;

/**
 * The public status page (docs/27 §3.1, §5.4): incidents staff open and update
 * (investigating → identified → monitoring → resolved), scheduled maintenance, and the overall
 * and per-component status derived from them — so tenants see an outage without calling us.
 */
export class StatusPage {
  constructor(
    private readonly deps: Deps &
      Readonly<{ incidents: IIncidentRepository; communications: ICommunicationsRepository }>,
  ) {}

  async open(
    input: Readonly<{
      title: string;
      impact: IncidentImpact;
      components: readonly string[];
      message: string;
    }>,
    actor: PlatformPrincipal,
  ): Promise<Incident> {
    const { deps } = this;
    const unknown = input.components.filter(
      (c) => !(STATUS_COMPONENTS as readonly string[]).includes(c),
    );
    if (unknown.length > 0)
      throw new ComplianceRuleError(`Unknown components: ${unknown.join(", ")}`);
    const now = deps.clock.now();
    const id = deps.ids.next();
    await deps.unitOfWork.run(async () => {
      await deps.incidents.save({
        id,
        title: input.title.trim(),
        impact: input.impact,
        status: "investigating",
        components: input.components,
        startedAt: now,
        resolvedAt: null,
        createdBy: actor.userId,
      });
      await deps.incidents.addUpdate(
        id,
        { status: "investigating", message: input.message.trim(), postedAt: now },
        actor.userId,
      );
      await recordStaffAction(deps, actor, {
        action: "incident.opened",
        entityType: "incident",
        entityId: id,
        after: { title: input.title, impact: input.impact },
      });
    });
    return this.get(id);
  }

  async update(
    id: string,
    input: Readonly<{ status: IncidentStatus; message: string; impact?: IncidentImpact }>,
    actor: PlatformPrincipal,
  ): Promise<Incident> {
    const { deps } = this;
    await deps.unitOfWork.run(async () => {
      const incident = await deps.incidents.find(id, true);
      if (incident === null) throw new ComplianceNotFoundError();
      if (incident.status === "resolved")
        throw new ComplianceRuleError("This incident is resolved");
      const now = deps.clock.now();
      const { updates: _updates, ...rest } = incident;
      await deps.incidents.save({
        ...rest,
        status: input.status,
        impact: input.impact ?? incident.impact,
        resolvedAt: input.status === "resolved" ? now : null,
      });
      await deps.incidents.addUpdate(
        id,
        { status: input.status, message: input.message.trim(), postedAt: now },
        actor.userId,
      );
      await recordStaffAction(deps, actor, {
        action: "incident.updated",
        entityType: "incident",
        entityId: id,
        after: { status: input.status },
      });
    });
    return this.get(id);
  }

  async get(id: string): Promise<Incident> {
    const incident = await this.deps.incidents.find(id);
    if (incident === null) throw new ComplianceNotFoundError();
    return incident;
  }

  list(): Promise<Incident[]> {
    return this.deps.incidents.recent(new Date(this.deps.clock.now().getTime() - 90 * DAY_MS), 100);
  }

  /** The public page: open incidents and those of the last 7 days, maintenance coming up. */
  async publicStatus(): Promise<PublicStatus> {
    const now = this.deps.clock.now();
    const incidents = await this.deps.incidents.recent(new Date(now.getTime() - 7 * DAY_MS), 20);
    const windows = await this.deps.communications.upcoming(
      now,
      new Date(now.getTime() + 14 * DAY_MS),
    );
    const maintenanceNow = windows.some((w) => w.startsAt <= now);
    return {
      status: overallStatus(incidents, maintenanceNow),
      components: STATUS_COMPONENTS.map((name) => ({
        name,
        status: overallStatus(
          incidents.filter((i) => i.components.includes(name)),
          maintenanceNow,
        ),
      })),
      incidents: incidents.map(({ createdBy: _staff, ...shown }) => shown),
      maintenance: windows.map((w) => ({
        title: w.title,
        message: w.message,
        startsAt: w.startsAt,
        endsAt: w.endsAt,
        readOnly: w.readOnly,
      })),
      updatedAt: now,
    };
  }
}

/**
 * Restore drills (docs/26 §7): a quarterly game day is always on the calendar — due by the end of
 * the quarter, the next one scheduled when a result is recorded or the date passes (missed,
 * alerted). Results keep the outcome, the RTO and RPO achieved and notes.
 */
export class RestoreDrills {
  constructor(private readonly deps: Deps & Readonly<{ drills: IRestoreDrillRepository }>) {}

  list(limit: number): Promise<RestoreDrill[]> {
    return this.deps.drills.list(limit);
  }

  /** The daily check: one scheduled game day; a passed due date is a missed drill. */
  async ensureScheduled(): Promise<Readonly<{ drill: RestoreDrill; missed: RestoreDrill | null }>> {
    const { deps } = this;
    const date = today(deps.clock.now());
    return deps.unitOfWork.run(async () => {
      const current = await deps.drills.scheduled("quarterly_game_day");
      if (current !== null && current.dueOn >= date) return { drill: current, missed: null };
      let missed: RestoreDrill | null = null;
      if (current !== null) {
        missed = { ...current, status: "missed" };
        await deps.drills.save(missed);
      }
      const drill = this.newDrill(
        missed === null ? quarterEnd(date) : nextQuarterEnd(missed.dueOn),
      );
      await deps.drills.save(drill);
      return { drill, missed };
    });
  }

  async record(
    id: string,
    input: Readonly<{
      outcome: DrillOutcome;
      performedAt: Date;
      rtoMinutes?: number | null;
      rpoMinutes?: number | null;
      notes?: string | null;
    }>,
    actor: PlatformPrincipal,
  ): Promise<Readonly<{ done: RestoreDrill; next: RestoreDrill | null }>> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const drill = await deps.drills.find(id, true);
      if (drill === null) throw new ComplianceNotFoundError();
      if (drill.status === "done") throw new ComplianceRuleError("This drill is already recorded");
      const done: RestoreDrill = {
        ...drill,
        status: "done",
        performedAt: input.performedAt,
        performedBy: actor.userId,
        outcome: input.outcome,
        rtoMinutes: input.rtoMinutes ?? null,
        rpoMinutes: input.rpoMinutes ?? null,
        notes: input.notes?.trim() || null,
      };
      await deps.drills.save(done);
      let next: RestoreDrill | null = null;
      if (drill.kind === "quarterly_game_day" && drill.status === "scheduled") {
        next = this.newDrill(nextQuarterEnd(today(input.performedAt)));
        await deps.drills.save(next);
      }
      await recordStaffAction(deps, actor, {
        action: "drill.recorded",
        entityType: "restore_drill",
        entityId: id,
        after: { outcome: input.outcome, rtoMinutes: done.rtoMinutes, rpoMinutes: done.rpoMinutes },
      });
      return { done, next };
    });
  }

  async reschedule(id: string, dueOn: string, actor: PlatformPrincipal): Promise<RestoreDrill> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const drill = await deps.drills.find(id, true);
      if (drill === null) throw new ComplianceNotFoundError();
      if (drill.status !== "scheduled")
        throw new ComplianceRuleError("Only a scheduled drill moves");
      if (dueOn < today(deps.clock.now())) throw new ComplianceRuleError("Choose a date ahead");
      const moved = { ...drill, dueOn };
      await deps.drills.save(moved);
      await recordStaffAction(deps, actor, {
        action: "drill.rescheduled",
        entityType: "restore_drill",
        entityId: id,
        before: { dueOn: drill.dueOn },
        after: { dueOn },
      });
      return moved;
    });
  }

  private newDrill(dueOn: string): RestoreDrill {
    return {
      id: this.deps.ids.next(),
      kind: "quarterly_game_day",
      dueOn,
      status: "scheduled",
      performedAt: null,
      performedBy: null,
      outcome: null,
      rtoMinutes: null,
      rpoMinutes: null,
      notes: null,
      createdAt: this.deps.clock.now(),
    };
  }
}

/**
 * The daily compliance chores: keep the quarterly restore drill scheduled (alert as it nears and
 * when it is missed), alert on data-protection deadlines, remove expired data exports.
 */
export class ComplianceDaily implements IJobHandler<"compliance.daily"> {
  readonly job = "compliance.daily" as const;

  constructor(
    private readonly deps: Readonly<{
      drills: RestoreDrills;
      requests: DataProtectionRequests;
      exports: Readonly<{ expire(): Promise<number> }>;
      alerts: IAlerts;
      clock: IClock;
      logger: ILogger;
    }>,
  ) {}

  async handle(): Promise<void> {
    const { deps } = this;
    const now = deps.clock.now();
    const date = today(now);
    const { drill, missed } = await deps.drills.ensureScheduled();
    if (missed !== null)
      await deps.alerts.raise({
        key: `drill.missed:${missed.id}`,
        severity: "warning",
        source: "backups",
        title: `The quarterly restore drill due ${missed.dueOn} was missed`,
        detail: { drillId: missed.id, next: drill.dueOn },
        runbook: "docs/31 restore drills",
      });
    const daysLeft = Math.round(
      (Date.parse(`${drill.dueOn}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / DAY_MS,
    );
    if (daysLeft <= 14)
      await deps.alerts.raise({
        key: `drill.due:${drill.id}`,
        severity: "info",
        source: "backups",
        title: `Quarterly restore drill due by ${drill.dueOn} (${daysLeft} days)`,
        detail: { drillId: drill.id },
        runbook: "docs/31 restore drills",
      });
    for (const r of await deps.requests.dueWithin(5)) {
      const overdue = r.dueAt <= now;
      await deps.alerts.raise({
        key: `dpr.${overdue ? "overdue" : "due"}:${r.id}`,
        severity: overdue ? "critical" : "warning",
        source: "privacy",
        title: `Data-protection request ${r.code} (${r.kind}) ${overdue ? "is overdue" : `is due ${r.dueAt.toISOString().slice(0, 10)}`}`,
        detail: { requestId: r.id },
        tenantId: r.tenantId,
      });
    }
    const removed = await deps.exports.expire();
    deps.logger.info("Compliance chores done", { drillDue: drill.dueOn, exportsRemoved: removed });
  }
}
