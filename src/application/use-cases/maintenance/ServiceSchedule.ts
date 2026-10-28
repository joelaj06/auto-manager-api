import {
  alertFor,
  duePoint,
  dueStatus,
  rebase,
  type AlertStatus,
  type DueBase,
  type DueStatus,
} from "../../../domain/maintenance/ServiceDue.js";
import { planFor, ServicePlanError } from "../../../domain/maintenance/ServicePlan.js";
import type { Principal } from "../../authorization/Principal.js";
import type { ITenantDailyTask } from "../../jobs/ITenantDailyTask.js";
import type { IAuditTrail } from "../../ports/IAuditTrail.js";
import type { IIdGenerator } from "../../ports/IIdGenerator.js";
import type { INotificationSettingsStore } from "../../ports/INotifications.js";
import type { IOrganisationSettings } from "../../ports/IOrganisationSettings.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import type {
  IServicePlans,
  ServiceDueRow,
  ServiceDueView,
  ServiceRecordProps,
} from "../../ports/IServicePlans.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import type { TenantCalendar } from "../../services/TenantCalendar.js";
import type { Notifier } from "../notifications/Notifier.js";
import { recordUserAction } from "../reference/userAudit.js";
import type { VehicleAccess } from "../vehicles/VehicleAccess.js";

const DRIVER_SMS =
  "Hello {{driverName}}, {{vehicle}} is due for {{task}} ({{dueAt}}). Please bring it in for the service. {{businessName}}";

export type DueItem = Readonly<{
  id: string;
  status: DueStatus;
  vehicle: Readonly<{
    id: string;
    code: string;
    plateNumber: string | null;
    name: string;
    odometer: number | null;
  }>;
  plan: Readonly<{ id: string; name: string }>;
  task: Readonly<{ id: string; name: string }>;
  dueKm: number | null;
  dueOn: string | null;
  /** Negative once past. */
  kmLeft: number | null;
  daysLeft: number | null;
  /** Counted from the last service, or from when the plan started applying. */
  since: Readonly<{ km: number | null; on: string }>;
}>;

export type DueQuery = Readonly<{
  status?: DueStatus;
  branchId?: string;
  vehicleId?: string;
  limit: number;
}>;

export type ServiceDoneInput = Readonly<{
  taskId: string;
  /** Default today. */
  doneOn?: string;
  /** Default the vehicle's odometer. */
  odometer?: number | null;
  note?: string | null;
  workOrderRef?: string | null;
}>;

export type VehicleSchedule = Readonly<{
  plan: Readonly<{ id: string; name: string }> | null;
  due: readonly DueItem[];
  history: readonly (ServiceRecordProps & { taskName: string })[];
}>;

/**
 * The due engine (docs/12 §2): every vehicle follows its most specific plan, and each task is
 * due again by km and/or days from its last service — `upcoming`, `due`, `overdue`. Recomputed
 * for a vehicle on every odometer reading and service recorded, for the fleet when plans change
 * and nightly (dates move on); each new status alerts the branch's maintenance staff once, and the
 * driver by SMS once due (decisions 376–380).
 */
export class ServiceSchedule implements ITenantDailyTask {
  readonly name = "service_due";

  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      plans: IServicePlans;
      vehicleAccess: VehicleAccess;
      settings: INotificationSettingsStore;
      organisation: IOrganisationSettings;
      notifier: Notifier;
      calendar: TenantCalendar;
      auditTrail: IAuditTrail;
      requestContext: IRequestContext;
      ids: IIdGenerator;
      clock: { now(): Date };
    }>,
  ) {}

  /** Nightly: dates move on even when no odometer reading comes in. */
  run(localDate: string): Promise<void> {
    return this.deps.unitOfWork.run(() => this.recompute(null, localDate));
  }

  /** After an odometer reading (inside the reading's unit of work). */
  vehicleRead(vehicleId: string): Promise<void> {
    return this.recompute([vehicleId]);
  }

  /**
   * Brings the due rows of these vehicles (all when null) in line with their plans, odometers
   * and service records, and sends the alerts of statuses newly reached.
   */
  async recompute(vehicleIds: readonly string[] | null, date?: string): Promise<void> {
    const { deps } = this;
    const today = date ?? (await deps.calendar.today());
    const now = deps.clock.now();
    const vehicles = await deps.plans.vehicles(vehicleIds);
    const plans = await deps.plans.plans(false);
    const stored = new Map(
      (await deps.plans.dueRows(vehicleIds)).map((r) => [`${r.vehicleId}:${r.taskId}`, r]),
    );
    const last = new Map(
      (await deps.plans.lastRecords(vehicleIds)).map((r) => [`${r.vehicleId}:${r.taskId}`, r]),
    );
    const kept = new Set<string>();
    const alerts: [string, AlertStatus][] = [];
    for (const vehicle of vehicles) {
      if (!vehicle.inService) continue;
      const plan = planFor(plans, vehicle);
      if (plan === null) continue;
      for (const task of plan.tasks) {
        const key = `${vehicle.vehicleId}:${task.id}`;
        const before = stored.get(key);
        const done = last.get(key);
        const base = rebase(
          done !== undefined
            ? { km: done.odometer, on: done.doneOn }
            : before !== undefined
              ? { km: before.baseKm ?? vehicle.odometer, on: before.baseOn }
              : ({ km: vehicle.odometer, on: today } satisfies DueBase),
          vehicle.odometer,
        );
        const point = duePoint(task, base);
        // A km-only task waits for the first odometer reading.
        if (point.dueKm === null && point.dueOn === null) continue;
        const status = dueStatus(task, point, { km: vehicle.odometer, today });
        const samePoint =
          before !== undefined && before.dueKm === point.dueKm && before.dueOn === point.dueOn;
        const alerted = samePoint ? before.alerted : null;
        const alert = alertFor(status, alerted);
        const row: ServiceDueRow = {
          id: before?.id ?? deps.ids.next(),
          vehicleId: vehicle.vehicleId,
          taskId: task.id,
          planId: plan.id,
          branchId: vehicle.branchId,
          baseKm: base.km,
          baseOn: base.on,
          dueKm: point.dueKm,
          dueOn: point.dueOn,
          status,
          alerted: alert ?? alerted,
          computedAt: now,
        };
        kept.add(row.id);
        if (before === undefined || changed(before, row)) await deps.plans.saveDue(row);
        if (alert !== null) alerts.push([row.id, alert]);
      }
    }
    await deps.plans.removeDue(
      [...stored.values()].filter((r) => !kept.has(r.id)).map((r) => r.id),
    );
    if (alerts.length > 0) await this.alert(alerts);
  }

  // --- reading ---

  due(actor: Principal, query: DueQuery): Promise<DueItem[]> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      if (query.branchId !== undefined)
        await deps.vehicleAccess.branch(actor, "maintenance.view", query.branchId);
      if (query.vehicleId !== undefined)
        await deps.vehicleAccess.reach(actor, query.vehicleId, "maintenance.view");
      const today = await deps.calendar.today();
      const rows = await deps.plans.due({
        branchIds: deps.vehicleAccess.branchesFor(actor, "maintenance.view"),
        ...(query.branchId === undefined ? {} : { branchId: query.branchId }),
        ...(query.vehicleId === undefined ? {} : { vehicleId: query.vehicleId }),
        ...(query.status === undefined
          ? { statuses: ["upcoming", "due", "overdue"] as const }
          : { statuses: [query.status] }),
        limit: query.limit,
      });
      return rows.map((r) => item(r, today));
    });
  }

  vehicle(actor: Principal, vehicleId: string): Promise<VehicleSchedule> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      await deps.vehicleAccess.reach(actor, vehicleId, "maintenance.view");
      const today = await deps.calendar.today();
      const rows = await deps.plans.due({ branchIds: "all", vehicleId, limit: 200 });
      const [vehicle] = await deps.plans.vehicles([vehicleId]);
      const plan =
        vehicle === undefined || !vehicle.inService
          ? null
          : planFor(await deps.plans.plans(false), vehicle);
      return {
        plan: plan === null ? null : { id: plan.id, name: plan.name },
        due: rows.map((r) => item(r, today)),
        history: await deps.plans.records(vehicleId, 100),
      };
    });
  }

  /**
   * Rentals (docs/12 §2): what of the vehicle's schedule falls due before the booking ends —
   * already due or overdue, or due by the return date. Warnings, never a refusal.
   */
  async warnings(vehicleId: string, returnAt: Date): Promise<string[]> {
    const { deps } = this;
    const returnOn = await deps.calendar.dateOf(returnAt);
    const rows = await deps.plans.due({ branchIds: "all", vehicleId, limit: 50 });
    return rows
      .filter(
        (r) =>
          r.status === "due" || r.status === "overdue" || (r.dueOn !== null && r.dueOn <= returnOn),
      )
      .map(
        (r) =>
          `${vehicleName(r)}: ${r.taskName} ${r.status === "overdue" ? "is overdue" : "falls due"} (${dueAt(r)}) — before the return`,
      );
  }

  // --- recording a service ---

  /** A service done (in the workshop or outside): the task counts again from it. */
  serviceDone(actor: Principal, vehicleId: string, input: ServiceDoneInput) {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      await deps.vehicleAccess.reach(actor, vehicleId, "maintenance.work_orders.manage", true);
      const record = await this.recordFor(vehicleId, input, actor.userId);
      await recordUserAction(deps, actor.userId, {
        action: "vehicle.service_recorded",
        entityType: "vehicle",
        entityId: vehicleId,
        after: record,
      });
      return { record, schedule: await this.vehicle(actor, vehicleId) };
    });
  }

  /** For work orders (P6-2) and the endpoint: the vehicle locked by the caller. */
  async recordFor(
    vehicleId: string,
    input: ServiceDoneInput,
    userId: string | null,
  ): Promise<ServiceRecordProps> {
    const { deps } = this;
    const today = await deps.calendar.today();
    const [vehicle] = await deps.plans.vehicles([vehicleId]);
    const task = await deps.plans.task(input.taskId);
    if (vehicle === undefined || task === null)
      throw new ServicePlanError("That task is not on a service plan");
    const plan = planFor(await deps.plans.plans(false), vehicle);
    if (plan === null || !plan.tasks.some((t) => t.id === task.id))
      throw new ServicePlanError(`${task.name} is not on ${vehicle.code}'s service plan`);
    const doneOn = input.doneOn ?? today;
    if (doneOn > today) throw new ServicePlanError("A service cannot be recorded ahead of time");
    const odometer = input.odometer === undefined ? vehicle.odometer : input.odometer;
    if (odometer !== null && vehicle.odometer !== null && odometer > vehicle.odometer)
      throw new ServicePlanError(
        `The odometer is at ${vehicle.odometer} km: record the reading first`,
      );
    const record: ServiceRecordProps = {
      id: deps.ids.next(),
      vehicleId,
      taskId: task.id,
      doneOn,
      odometer,
      note: blank(input.note),
      workOrderRef: blank(input.workOrderRef),
      recordedBy: userId,
      createdAt: deps.clock.now(),
    };
    await deps.plans.addRecord(record);
    await this.recompute([vehicleId], today);
    return record;
  }

  // --- alerts ---

  private async alert(alerts: readonly (readonly [string, AlertStatus])[]): Promise<void> {
    const { deps } = this;
    const settings = await deps.settings.get();
    if (!settings.rules.service_due.enabled) return;
    const organisation = await deps.organisation.get();
    const status = new Map(alerts);
    for (const row of await deps.plans.dueView([...status.keys()])) {
      const reached = status.get(row.id)!;
      const vehicle = vehicleName(row);
      const dedupeKey = `service_due:${row.id}:${row.dueKm ?? ""}:${row.dueOn ?? ""}:${reached}`;
      await deps.notifier.staff(settings, {
        rule: "service_due",
        permission: "maintenance.view",
        branchId: row.branchId,
        dedupeKey,
        title: `${vehicle}: ${row.taskName} ${STATUS_TEXT[reached]}`,
        body: `${row.taskName} of ${vehicle} (${row.vehicleCode}) is ${STATUS_TEXT[reached]}: ${dueAt(row)}. Odometer ${row.odometer ?? "not read"}${row.odometer === null ? "" : " km"}.`,
        severity: reached === "overdue" ? "critical" : reached === "due" ? "warning" : "info",
        data: { vehicleId: row.vehicleId, serviceDueId: row.id },
      });
      if (reached === "upcoming") continue;
      const driver = await deps.plans.driverOf(row.vehicleId);
      if (driver === null) continue;
      await deps.notifier.sms(settings, organisation.timezone, {
        rule: "service_due",
        driverId: driver.driverId,
        phone: driver.phone,
        dedupeKey,
        standardText: DRIVER_SMS,
        values: {
          driverName: driver.name,
          vehicle,
          task: row.taskName,
          dueAt: dueAt(row),
          businessName: organisation.name,
        },
      });
    }
  }
}

const STATUS_TEXT: Readonly<Record<AlertStatus, string>> = {
  upcoming: "coming up",
  due: "due",
  overdue: "overdue",
};

const changed = (a: ServiceDueRow, b: ServiceDueRow) =>
  a.planId !== b.planId ||
  a.branchId !== b.branchId ||
  a.baseKm !== b.baseKm ||
  a.baseOn !== b.baseOn ||
  a.dueKm !== b.dueKm ||
  a.dueOn !== b.dueOn ||
  a.status !== b.status ||
  a.alerted !== b.alerted;

const vehicleName = (r: Pick<ServiceDueView, "plateNumber" | "vehicleCode">) =>
  r.plateNumber ?? r.vehicleCode;

/** "at 15,000 km or on 2026-12-01". */
function dueAt(r: Pick<ServiceDueView, "dueKm" | "dueOn">): string {
  const parts: string[] = [];
  if (r.dueKm !== null) parts.push(`at ${r.dueKm.toLocaleString("en-GB")} km`);
  if (r.dueOn !== null) parts.push(`on ${r.dueOn}`);
  return parts.join(" or ");
}

function item(r: ServiceDueView, today: string): DueItem {
  return {
    id: r.id,
    status: r.status,
    vehicle: {
      id: r.vehicleId,
      code: r.vehicleCode,
      plateNumber: r.plateNumber,
      name: `${r.make} ${r.model}`,
      odometer: r.odometer,
    },
    plan: { id: r.planId, name: r.planName },
    task: { id: r.taskId, name: r.taskName },
    dueKm: r.dueKm,
    dueOn: r.dueOn,
    kmLeft: r.dueKm === null || r.odometer === null ? null : r.dueKm - r.odometer,
    daysLeft: r.dueOn === null ? null : daysBetween(today, r.dueOn),
    since: { km: r.baseKm, on: r.baseOn },
  };
}

const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

const blank = (value: string | null | undefined): string | null => {
  const text = value?.trim() ?? "";
  return text === "" ? null : text;
};
