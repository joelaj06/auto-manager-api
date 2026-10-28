import {
  IncidentRuleError,
  TrafficOffence,
  type OffenceDetails,
  type OffenceProps,
  type OffenceStatus,
  type OffenceType,
} from "../../../domain/incidents/Incident.js";
import { Money, type MoneyJson } from "../../../domain/money/Money.js";
import type { Principal } from "../../authorization/Principal.js";
import { ApplicationError } from "../../errors/ApplicationError.js";
import type { IAuditTrail } from "../../ports/IAuditTrail.js";
import type { IIdGenerator } from "../../ports/IIdGenerator.js";
import type { IIncidents } from "../../ports/IIncidents.js";
import type { INotificationSettingsStore } from "../../ports/INotifications.js";
import type { IOrganisationSettings } from "../../ports/IOrganisationSettings.js";
import type { ITenantReferenceData } from "../../ports/IReferenceData.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import type { TenantCalendar } from "../../services/TenantCalendar.js";
import type { Expenses } from "../expenses/Expenses.js";
import type { Notifier } from "../notifications/Notifier.js";
import { recordUserAction } from "../reference/userAudit.js";
import type { VehicleAccess } from "../vehicles/VehicleAccess.js";

export class OffenceNotFoundError extends ApplicationError {
  readonly code = "TRAFFIC_OFFENCE_NOT_FOUND";
  constructor() {
    super("Traffic offence not found");
  }
}

/** The expense category fines are entered in (seeded). */
const FINES_CATEGORY = "fines";

const DRIVER_SMS =
  "Hello {{driverName}}, a {{offence}} offence was recorded on {{vehicle}} on {{date}} (fine {{fine}}). Please contact the office. {{businessName}}";

export type OffenceInput = Readonly<{
  type: OffenceType;
  offenceAt: Date;
  location?: string | null;
  authority: string;
  noticeRef?: string | null;
  fine: string;
  dueOn?: string | null;
  /** Default: the driver of the vehicle's assignment at the time. */
  driverId?: string | null;
  /** Who pays the fine in the end (default: the driver, when there is one). */
  driverPays?: boolean;
  notes?: string | null;
}>;

export type OffenceView = Omit<OffenceProps, "fineMinor"> &
  Readonly<{ fine: MoneyJson; overdue: boolean }>;

/**
 * Traffic offences (docs/06 §8): a fine on a vehicle with the driver who had it (told by SMS),
 * paid by the business — an expense to the authority, charged to the driver when they pay — or
 * by the driver directly, contested, or waived (decision 401).
 */
export class TrafficOffences {
  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      incidents: IIncidents;
      vehicleAccess: VehicleAccess;
      expenses: Expenses;
      reference: ITenantReferenceData;
      organisation: IOrganisationSettings;
      settings: INotificationSettingsStore;
      notifier: Notifier;
      calendar: TenantCalendar;
      auditTrail: IAuditTrail;
      requestContext: IRequestContext;
      ids: IIdGenerator;
      clock: { now(): Date };
    }>,
  ) {}

  list(
    actor: Principal,
    query: Readonly<{
      vehicleId?: string;
      driverId?: string;
      status?: OffenceStatus;
      /** Not paid or waived yet. */
      outstanding?: boolean;
      before?: string;
      limit: number;
    }>,
  ): Promise<OffenceView[]> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const found = await deps.incidents.offences({
        branchIds: deps.vehicleAccess.branchesFor(actor, "incidents.view"),
        ...(query.vehicleId === undefined ? {} : { vehicleId: query.vehicleId }),
        ...(query.driverId === undefined ? {} : { driverId: query.driverId }),
        ...(query.status !== undefined
          ? { statuses: [query.status] }
          : query.outstanding === true
            ? { statuses: ["unpaid", "contested"] as const }
            : {}),
        ...(query.before === undefined ? {} : { beforeId: query.before }),
        limit: query.limit,
      });
      return this.views(found);
    });
  }

  get(actor: Principal, id: string): Promise<OffenceView> {
    return this.deps.unitOfWork.run(
      async () => (await this.views([await this.reach(actor, id, "incidents.view")]))[0]!,
    );
  }

  record(
    actor: Principal,
    input: OffenceInput & Readonly<{ vehicleId: string }>,
  ): Promise<OffenceView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const vehicle = await deps.vehicleAccess.reach(actor, input.vehicleId, "incidents.manage");
      const offence = TrafficOffence.record({
        id: deps.ids.next(),
        vehicleId: vehicle.id,
        branchId: vehicle.branchId,
        ...(await this.details(input, vehicle.id, null, null)),
        createdBy: actor.userId,
        now: deps.clock.now(),
      });
      await deps.incidents.insertOffence(offence);
      await this.tellDriver(offence, vehicle.snapshot().plateNumber ?? vehicle.snapshot().code);
      await this.audit(actor, "traffic_offence.recorded", offence, null);
      return (await this.views([offence]))[0]!;
    });
  }

  change(actor: Principal, id: string, input: Partial<OffenceInput>): Promise<OffenceView> {
    return this.mutate(actor, id, "traffic_offence.changed", async (offence, now) => {
      const p = offence.snapshot();
      const currency = await this.currency();
      const merged: OffenceInput = {
        ...p,
        fine: Money.ofMinor(p.fineMinor, currency).toDecimalString(),
        ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)),
      };
      offence.change(await this.details(merged, p.vehicleId, p.driverId, p.id), now);
    });
  }

  contest(actor: Principal, id: string): Promise<OffenceView> {
    return this.mutate(actor, id, "traffic_offence.contested", (offence, now) => {
      offence.contest(now);
      return Promise.resolve();
    });
  }

  waive(actor: Principal, id: string, note: string): Promise<OffenceView> {
    return this.mutate(actor, id, "traffic_offence.waived", (offence, now) => {
      offence.waive(note, now);
      return Promise.resolve();
    });
  }

  /**
   * Paid. By the business: an expense to the authority in the fines category, charged to the
   * driver when the driver pays (submitted, approval rules apply). By the driver: recorded only.
   */
  pay(
    actor: Principal,
    id: string,
    input: Readonly<{ by: "business" | "driver"; paidOn?: string; reference?: string | null }>,
  ): Promise<OffenceView> {
    return this.mutate(actor, id, "traffic_offence.paid", async (offence, now) => {
      const { deps } = this;
      const p = offence.snapshot();
      const today = await deps.calendar.today();
      const paidOn = input.paidOn ?? today;
      if (paidOn > today) throw new IncidentRuleError("A fine cannot be paid later than today");
      let expenseId: string | null = null;
      if (input.by === "business" && p.fineMinor > 0) {
        const category = (await deps.reference.expenseCategories()).find(
          (c) => c.code === FINES_CATEGORY,
        );
        if (category === undefined || !category.active)
          throw new IncidentRuleError(`There is no active "${FINES_CATEGORY}" expense category`);
        const charge = p.driverPays && p.driverId !== null;
        const expense = await deps.expenses.draftFor(
          actor.userId,
          {
            categoryId: category.id,
            description: `Fine: ${p.type.replace("_", " ")}${p.noticeRef === null ? "" : ` (${p.noticeRef})`}`,
            branchId: p.branchId,
            expenseDate: paidOn,
            payeeName: p.authority,
            driverId: p.driverId,
            chargeToDriver: charge,
            amount: Money.ofMinor(p.fineMinor, await this.currency()).toDecimalString(),
            vehicleIds: [p.vehicleId],
            reference: input.reference ?? p.noticeRef,
          },
          p.branchId,
          { type: "traffic_offence", id: p.id },
        );
        await deps.expenses.submitLoaded(expense, actor.userId, { skipReceiptRule: true });
        expenseId = expense.id;
      }
      offence.paid(input.by, paidOn, expenseId, now);
    });
  }

  // --- helpers ---

  private async details(
    input: OffenceInput,
    vehicleId: string,
    current: string | null,
    exceptId: string | null,
  ): Promise<OffenceDetails> {
    const { deps } = this;
    let driverId: string | null;
    if (input.driverId === undefined)
      driverId =
        current ?? (await deps.incidents.driverAt(vehicleId, input.offenceAt))?.driverId ?? null;
    else if (input.driverId === null) driverId = null;
    else {
      if ((await deps.incidents.driver(input.driverId)) === null)
        throw new IncidentRuleError("That driver does not exist");
      driverId = input.driverId;
    }
    const noticeRef = input.noticeRef?.trim() || null;
    if (
      noticeRef !== null &&
      (await deps.incidents.noticeTaken(input.authority.trim(), noticeRef, exceptId))
    )
      throw new IncidentRuleError(
        `Notice ${noticeRef} of ${input.authority.trim()} is already recorded`,
      );
    return {
      driverId,
      type: input.type,
      offenceAt: input.offenceAt,
      location: input.location ?? null,
      authority: input.authority,
      noticeRef,
      fineMinor: Money.parse(input.fine, await this.currency()).amountMinor,
      dueOn: input.dueOn ?? null,
      driverPays: input.driverPays ?? driverId !== null,
      notes: input.notes ?? null,
    };
  }

  private async tellDriver(offence: TrafficOffence, vehicle: string): Promise<void> {
    const { deps } = this;
    const p = offence.snapshot();
    if (p.driverId === null) return;
    const driver = await deps.incidents.driver(p.driverId);
    if (driver === null) return;
    const settings = await deps.settings.get();
    const organisation = await deps.organisation.get();
    await deps.notifier.sms(settings, organisation.timezone, {
      rule: "traffic_offence",
      driverId: driver.driverId,
      phone: driver.phone,
      dedupeKey: `traffic_offence:${p.id}`,
      standardText: DRIVER_SMS,
      values: {
        driverName: driver.name,
        vehicle,
        offence: p.type.replace("_", " "),
        date: await deps.calendar.dateOf(p.offenceAt),
        fine: Money.ofMinor(p.fineMinor, organisation.baseCurrency).format(),
        businessName: organisation.name,
      },
    });
  }

  private async mutate(
    actor: Principal,
    id: string,
    action: string,
    run: (offence: TrafficOffence, now: Date) => Promise<void>,
  ): Promise<OffenceView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const offence = await this.reach(actor, id, "incidents.manage", true);
      const before = offence.snapshot();
      await run(offence, deps.clock.now());
      await deps.incidents.updateOffence(offence);
      await this.audit(actor, action, offence, before);
      return (await this.views([offence]))[0]!;
    });
  }

  private async reach(
    actor: Principal,
    id: string,
    permission: "incidents.view" | "incidents.manage",
    lock = false,
  ): Promise<TrafficOffence> {
    const { deps } = this;
    const offence = lock
      ? await deps.incidents.lockOffence(id)
      : await deps.incidents.getOffence(id);
    if (
      offence === null ||
      !deps.vehicleAccess.can(actor, "incidents.view", offence.snapshot().branchId)
    )
      throw new OffenceNotFoundError();
    await deps.vehicleAccess.branch(actor, permission, offence.snapshot().branchId);
    return offence;
  }

  private async views(offences: readonly TrafficOffence[]): Promise<OffenceView[]> {
    const currency = await this.currency();
    const today = await this.deps.calendar.today();
    return offences.map((o) => {
      const { fineMinor, ...p } = o.snapshot();
      return {
        ...p,
        fine: Money.ofMinor(fineMinor, currency).toJSON(),
        overdue: p.status === "unpaid" && p.dueOn !== null && p.dueOn < today,
      };
    });
  }

  private async currency(): Promise<string> {
    return (await this.deps.organisation.get()).baseCurrency;
  }

  private async audit(
    actor: Principal,
    action: string,
    offence: TrafficOffence,
    before: OffenceProps | null,
  ): Promise<void> {
    const summary = (o: OffenceProps) => ({
      status: o.status,
      fineMinor: o.fineMinor,
      driverId: o.driverId,
      driverPays: o.driverPays,
    });
    await recordUserAction(this.deps, actor.userId, {
      action,
      entityType: "traffic_offence",
      entityId: offence.id,
      before: before === null ? null : summary(before),
      after: { ...summary(offence.snapshot()), vehicleId: offence.snapshot().vehicleId },
    });
  }
}
