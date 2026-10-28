import { Money, type MoneyJson } from "../../../domain/money/Money.js";
import {
  WorkOrder,
  WorkOrderError,
  type Allocation,
  type LineKind,
  type WorkOrderDetails,
  type WorkOrderPriority,
  type WorkOrderProps,
  type WorkOrderStatus,
  type WorkOrderType,
} from "../../../domain/maintenance/WorkOrder.js";
import type { IVehicleRepository } from "../../../domain/repositories/IVehicleRepository.js";
import type { Vehicle } from "../../../domain/vehicles/Vehicle.js";
import type { VehicleStatus } from "../../../domain/vehicles/VehicleStatus.js";
import type { Principal } from "../../authorization/Principal.js";
import { ApplicationError } from "../../errors/ApplicationError.js";
import type { IAuditTrail } from "../../ports/IAuditTrail.js";
import type { IExpenseSettingsStore } from "../../ports/IExpenseRecords.js";
import type { IIdGenerator } from "../../ports/IIdGenerator.js";
import type { IOrganisationSettings } from "../../ports/IOrganisationSettings.js";
import type { ITenantReferenceData } from "../../ports/IReferenceData.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import type { IServicePlans } from "../../ports/IServicePlans.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import type { IWorkOrders, VendorRecord } from "../../ports/IWorkOrders.js";
import type { TenantCalendar } from "../../services/TenantCalendar.js";
import type { Expenses, ExpenseRequest } from "../expenses/Expenses.js";
import { recordUserAction } from "../reference/userAudit.js";
import type { DocumentNumbering } from "../reference/DocumentNumbering.js";
import type { RentalAvailability } from "../rentals/RentalAvailability.js";
import type { VehicleDamages } from "../rentals/VehicleDamages.js";
import type { OdometerLog } from "../vehicles/OdometerLog.js";
import type { VehicleAccess } from "../vehicles/VehicleAccess.js";
import type { VehicleIssues } from "../vehicles/VehicleIssues.js";
import type { VehicleRegistry } from "../vehicles/VehicleRegistry.js";
import type { WorkPayLifecycle } from "../workpay/WorkPayLifecycle.js";
import type { ServiceSchedule } from "./ServiceSchedule.js";

export class WorkOrderNotFoundError extends ApplicationError {
  readonly code = "WORK_ORDER_NOT_FOUND";
  constructor() {
    super("Work order not found");
  }
}

const REF_TYPE = "work_order";

/** Statuses a work order moves into maintenance while it is off the road, and back. */
const TO_MAINTENANCE: ReadonlySet<VehicleStatus> = new Set<VehicleStatus>([
  "available",
  "reconditioning",
  "for_sale",
  "repossessed",
  "accident",
  "impounded",
  "stolen",
]);
/** Statuses a vehicle returns to; any other goes back as available (decision 384). */
const RETURN_TO: ReadonlySet<string> = new Set(["reconditioning", "for_sale"]);
/** Vehicles that have left the business are not worked on. */
const GONE: ReadonlySet<VehicleStatus> = new Set<VehicleStatus>([
  "sold",
  "transferred",
  "written_off",
  "scrapped",
]);

export type LineInput = Readonly<{
  kind: LineKind;
  description: string;
  quantity: number;
  /** "120.00" in the base currency. */
  unitCost: string;
  partRef?: string | null;
}>;

export type OpenInput = Readonly<{
  vehicleId: string;
  type: WorkOrderType;
  priority?: WorkOrderPriority;
  title: string;
  description?: string | null;
  issueId?: string | null;
  damageId?: string | null;
  /** Tasks of the vehicle's service plan; a preventive order takes those coming up by default. */
  serviceTaskIds?: readonly string[];
  vendorId?: string | null;
  assignedTo?: string | null;
  warranty?: boolean;
  /** Off the road from now (or from `offRoadFrom`). */
  offRoad?: boolean;
  offRoadFrom?: Date;
  expectedBackAt?: Date | null;
  odometer?: number | null;
  notes?: string | null;
  lines?: readonly LineInput[];
}>;

export type ChangeInput = Partial<
  Omit<WorkOrderDetails, "expectedBackAt"> & Readonly<{ expectedBackAt: Date | null }>
>;

export type CompleteInput = Readonly<{
  odometer?: number | null;
  /** Who pays besides the business; the business pays the rest. */
  allocations?: readonly Readonly<{
    payer: "driver" | "customer" | "insurer";
    amount: string;
    driverId?: string | null;
    insurerId?: string | null;
    claimRef?: string | null;
  }>[];
  vendorInvoiceRef?: string | null;
  vendorRating?: number | null;
}>;

export type WorkOrderQuery = Readonly<{
  status?: WorkOrderStatus;
  type?: WorkOrderType;
  vehicleId?: string;
  vendorId?: string;
  branchId?: string;
  open?: boolean;
  limit: number;
  before?: string;
}>;

export type WorkOrderView = Omit<WorkOrderProps, "lines" | "allocations"> &
  Readonly<{
    lines: readonly (Omit<WorkOrderProps["lines"][number], "unitCostMinor" | "amountMinor"> &
      Readonly<{ unitCost: MoneyJson; amount: MoneyJson }>)[];
    allocations: readonly (Omit<Allocation, "amountMinor"> & Readonly<{ amount: MoneyJson }>)[];
    total: MoneyJson;
    byKind: Readonly<Record<LineKind, MoneyJson>>;
    downtimeHours: number | null;
  }>;

/**
 * Work orders (docs/12 §3, §5): a job on a vehicle in the business's workshop or at a vendor.
 * Off the road it blocks rentals (class bookings moved) and pauses Work & Pay; completing it
 * records the odometer, the service plan tasks done, the damage repaired and the issue resolved,
 * and posts the cost as expenses — the business's share and the driver's — with the renter and
 * an insurer recovering theirs (decisions 381–388).
 */
export class WorkOrders {
  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      orders: IWorkOrders;
      vehicles: IVehicleRepository;
      vehicleAccess: VehicleAccess;
      registry: VehicleRegistry;
      odometer: OdometerLog;
      availability: RentalAvailability;
      schedule: ServiceSchedule;
      plans: IServicePlans;
      issues: VehicleIssues;
      damages: VehicleDamages;
      expenses: Expenses;
      expenseSettings: IExpenseSettingsStore;
      reference: ITenantReferenceData;
      numbering: DocumentNumbering;
      organisation: IOrganisationSettings;
      calendar: TenantCalendar;
      auditTrail: IAuditTrail;
      requestContext: IRequestContext;
      ids: IIdGenerator;
      clock: { now(): Date };
      /** Work & Pay downtime while the vehicle is off the road. */
      workpay?: WorkPayLifecycle;
    }>,
  ) {}

  list(actor: Principal, query: WorkOrderQuery): Promise<WorkOrderView[]> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      if (query.branchId !== undefined)
        await deps.vehicleAccess.branch(actor, "maintenance.view", query.branchId);
      const orders = await deps.orders.list({
        branchIds: deps.vehicleAccess.branchesFor(actor, "maintenance.view"),
        ...(query.branchId === undefined ? {} : { branchId: query.branchId }),
        ...(query.vehicleId === undefined ? {} : { vehicleId: query.vehicleId }),
        ...(query.vendorId === undefined ? {} : { vendorId: query.vendorId }),
        ...(query.type === undefined ? {} : { types: [query.type] }),
        ...(query.status !== undefined
          ? { statuses: [query.status] }
          : query.open === true
            ? { statuses: ["open", "in_progress", "awaiting_parts"] as const }
            : {}),
        ...(query.before === undefined ? {} : { beforeId: query.before }),
        limit: query.limit,
      });
      return orders.map((o) => this.view(o));
    });
  }

  get(actor: Principal, id: string): Promise<WorkOrderView> {
    return this.deps.unitOfWork.run(async () =>
      this.view(await this.reach(actor, id, "maintenance.view")),
    );
  }

  open(actor: Principal, input: OpenInput): Promise<WorkOrderView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const vehicle = await deps.vehicleAccess.reach(
        actor,
        input.vehicleId,
        "maintenance.work_orders.manage",
        true,
      );
      if (GONE.has(vehicle.status) || vehicle.deleted)
        throw new WorkOrderError(`${code(vehicle)} is no longer in the fleet`);
      const now = deps.clock.now();
      const currency = (await deps.organisation.get()).baseCurrency;
      await this.checkParties(input);
      if (input.issueId !== undefined && input.issueId !== null)
        await deps.issues.takenOn(input.issueId, vehicle.id, actor.userId);
      if (input.damageId !== undefined && input.damageId !== null)
        await deps.damages.forWorkOrder(input.damageId, vehicle.id);
      const odometer = input.odometer ?? null;
      if (odometer !== null && odometer !== vehicle.snapshot().currentOdometer)
        await deps.odometer.recordFor(vehicle, { value: odometer }, "service", null, actor.userId);
      const order = WorkOrder.open({
        id: deps.ids.next(),
        number: await deps.numbering.next("work_order", now),
        vehicleId: vehicle.id,
        branchId: vehicle.branchId,
        type: input.type,
        priority: input.priority ?? "normal",
        title: input.title,
        description: input.description ?? null,
        issueId: input.issueId ?? null,
        damageId: input.damageId ?? null,
        serviceTaskIds: await this.tasksFor(vehicle.id, input.type, input.serviceTaskIds),
        vendorId: input.vendorId ?? null,
        assignedTo: input.assignedTo ?? null,
        warranty: input.warranty ?? false,
        expectedBackAt: this.expected(input.expectedBackAt ?? null, now),
        notes: input.notes ?? null,
        odometerIn: odometer ?? vehicle.snapshot().currentOdometer,
        currency,
        createdBy: actor.userId,
        now,
      });
      if (input.lines !== undefined) order.setLines(this.lines(input.lines, currency), now);
      await deps.orders.insert(order);
      if (input.offRoad === true) {
        await this.takeOffRoad(actor, order, vehicle, input.offRoadFrom ?? now);
        await deps.orders.update(order);
      }
      await this.audit(actor, "work_order.opened", order, null);
      return this.view(order);
    });
  }

  change(actor: Principal, id: string, input: ChangeInput): Promise<WorkOrderView> {
    return this.mutate(actor, id, "work_order.changed", async (order, now) => {
      await this.checkParties(input);
      const p = order.snapshot();
      order.change(
        {
          ...input,
          ...(input.serviceTaskIds === undefined
            ? {}
            : { serviceTaskIds: await this.tasksFor(p.vehicleId, p.type, input.serviceTaskIds) }),
          ...(input.expectedBackAt === undefined
            ? {}
            : { expectedBackAt: this.expected(input.expectedBackAt, now) }),
        },
        now,
      );
      const after = order.snapshot();
      // The block follows the expected return.
      if (after.blockId !== null && input.expectedBackAt !== undefined)
        await this.deps.availability.retime(
          after.blockId,
          after.downtimeStartedAt!,
          after.expectedBackAt,
        );
    });
  }

  setLines(actor: Principal, id: string, lines: readonly LineInput[]): Promise<WorkOrderView> {
    return this.mutate(actor, id, "work_order.lines_set", (order, now) => {
      order.setLines(this.lines(lines, order.snapshot().currency), now);
      return Promise.resolve();
    });
  }

  move(
    actor: Principal,
    id: string,
    status: Extract<WorkOrderStatus, "in_progress" | "awaiting_parts">,
  ): Promise<WorkOrderView> {
    return this.mutate(actor, id, `work_order.${status}`, (order, now) => {
      order.move(status, now);
      return Promise.resolve();
    });
  }

  /** The vehicle goes off the road for the job (if it did not when opened). */
  offRoad(
    actor: Principal,
    id: string,
    input: Readonly<{ from?: Date; expectedBackAt?: Date | null }>,
  ): Promise<WorkOrderView> {
    return this.mutate(actor, id, "work_order.off_road", async (order, now) => {
      if (input.expectedBackAt !== undefined)
        order.change({ expectedBackAt: this.expected(input.expectedBackAt, now) }, now);
      const vehicle = (await this.deps.vehicles.lockById(order.snapshot().vehicleId))!;
      await this.takeOffRoad(actor, order, vehicle, input.from ?? now);
    });
  }

  complete(actor: Principal, id: string, input: CompleteInput): Promise<WorkOrderView> {
    const { deps } = this;
    return this.mutate(actor, id, "work_order.completed", async (order, now) => {
      const p = order.snapshot();
      const vehicle = (await deps.vehicles.lockById(p.vehicleId))!;
      const today = await deps.calendar.today();
      const allocations = await this.allocations(order, vehicle, input.allocations ?? []);
      const odometer = input.odometer ?? null;
      const current = vehicle.snapshot().currentOdometer;
      if (odometer !== null && odometer !== current)
        await deps.odometer.recordFor(vehicle, { value: odometer }, "service", p.id, actor.userId);
      order.complete({
        allocations,
        odometerOut: odometer ?? current,
        vendorInvoiceRef: input.vendorInvoiceRef ?? null,
        vendorRating: input.vendorRating ?? null,
        userId: actor.userId,
        now,
      });
      const done = order.snapshot();
      for (const taskId of done.serviceTaskIds)
        await deps.schedule.recordFor(
          p.vehicleId,
          {
            taskId,
            doneOn: today,
            ...(done.odometerOut === null ? {} : { odometer: done.odometerOut }),
            workOrderRef: p.number,
          },
          actor.userId,
        );
      await this.post(order, today, actor.userId);
      if (p.damageId !== null)
        await deps.damages.repairedBy(actor, p.damageId, {
          finalMinor: order.totalMinor(),
          workOrderRef: p.number,
          customerPays: allocations.some((a) => a.payer === "customer"),
        });
      if (p.issueId !== null)
        await deps.issues.fixedBy(p.issueId, `Work order ${p.number} completed`, actor.userId);
      await this.backOnRoad(order, actor.userId);
    });
  }

  cancel(actor: Principal, id: string, reason: string): Promise<WorkOrderView> {
    return this.mutate(actor, id, "work_order.cancelled", async (order, now) => {
      order.cancel(reason, actor.userId, now);
      await this.backOnRoad(order, actor.userId);
    });
  }

  /** A vendor's record: jobs, spend, turnaround and rating, and its recent work orders. */
  vendor(
    actor: Principal,
    vendorId: string,
  ): Promise<
    Readonly<{
      record: Omit<VendorRecord, "spentMinor"> & { spent: MoneyJson };
      recent: WorkOrderView[];
    }>
  > {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const { spentMinor, ...record } = await deps.orders.vendorRecord(vendorId);
      const currency = (await deps.organisation.get()).baseCurrency;
      const recent = await deps.orders.list({
        branchIds: deps.vehicleAccess.branchesFor(actor, "maintenance.view"),
        vendorId,
        limit: 20,
      });
      return {
        record: { ...record, spent: Money.ofMinor(spentMinor, currency).toJSON() },
        recent: recent.map((o) => this.view(o)),
      };
    });
  }

  // --- off and back on the road ---

  private async takeOffRoad(
    actor: Principal,
    order: WorkOrder,
    vehicle: Vehicle,
    at: Date,
  ): Promise<void> {
    const { deps } = this;
    const p = order.snapshot();
    if (p.offRoad) throw new WorkOrderError("The vehicle is already off the road");
    if (vehicle.status === "on_rent")
      throw new WorkOrderError(`${code(vehicle)} is out on rental: check it in first`);
    const reason = `Work order ${p.number}: ${p.title}`;
    const { block } = await deps.availability.offRoad(actor, {
      vehicleId: vehicle.id,
      branchId: vehicle.branchId,
      workOrderId: p.id,
      startsAt: at,
      endsAt: p.expectedBackAt,
      note: reason,
    });
    const agreementId =
      (await deps.workpay?.vehicleOffRoad(vehicle.id, reason, actor.userId)) ?? null;
    let statusBefore: string | null = null;
    if (agreementId === null && TO_MAINTENANCE.has(vehicle.status)) {
      statusBefore = vehicle.status;
      await deps.registry.moveByModule(vehicle, "in_maintenance", {
        ref: { type: REF_TYPE, id: p.id },
        reason,
        userId: actor.userId,
      });
    }
    order.wentOffRoad({ at, blockId: block.id, statusBefore, workpayAgreementId: agreementId });
  }

  /** Completed or cancelled: the block ends, Work & Pay resumes, the status goes back. */
  private async backOnRoad(order: WorkOrder, userId: string): Promise<void> {
    const { deps } = this;
    const p = order.snapshot();
    if (!p.offRoad) return;
    if (p.blockId !== null)
      await deps.availability.free(p.blockId, `Work order ${p.number} ${p.status}`, userId);
    if (p.workpayAgreementId !== null)
      await deps.workpay?.vehicleBack(p.workpayAgreementId, userId);
    if (p.statusBefore === null) return;
    const vehicle = (await deps.vehicles.lockById(p.vehicleId))!;
    if (vehicle.status !== "in_maintenance") return;
    await deps.registry.moveByModule(
      vehicle,
      RETURN_TO.has(p.statusBefore) ? (p.statusBefore as VehicleStatus) : "available",
      { ref: { type: REF_TYPE, id: p.id }, reason: `Work order ${p.number} ${p.status}`, userId },
    );
  }

  // --- money ---

  /** Who pays what besides the business (decision 386). */
  private async allocations(
    order: WorkOrder,
    vehicle: Vehicle,
    given: NonNullable<CompleteInput["allocations"]>,
  ): Promise<Allocation[]> {
    const { deps } = this;
    const p = order.snapshot();
    const total = order.totalMinor();
    const out: Allocation[] = [];
    for (const a of given) {
      const amountMinor = Money.parse(a.amount, p.currency).amountMinor;
      const base = {
        payer: a.payer,
        amountMinor,
        driverId: null,
        customerId: null,
        insurerId: null,
        claimRef: null,
      };
      if (a.payer === "driver") {
        const driverId = a.driverId ?? (await deps.plans.driverOf(vehicle.id))?.driverId ?? null;
        if (driverId === null)
          throw new WorkOrderError(`${code(vehicle)} has no driver: name the driver who pays`);
        if (!(await deps.orders.exists("driver", driverId)))
          throw new WorkOrderError("That driver does not exist");
        out.push({ ...base, driverId });
      } else if (a.payer === "customer") {
        const customerId = p.damageId === null ? null : await deps.orders.damageRenter(p.damageId);
        if (customerId === null)
          throw new WorkOrderError(
            "Only the repair of a damage from a rental is charged to the renter",
          );
        if (amountMinor !== total)
          throw new WorkOrderError("The renter pays all of the repair or none of it");
        out.push({ ...base, customerId });
      } else {
        if (
          a.insurerId !== undefined &&
          a.insurerId !== null &&
          !(await deps.orders.exists("supplier", a.insurerId))
        )
          throw new WorkOrderError("That insurer is not a supplier");
        out.push({ ...base, insurerId: a.insurerId ?? null, claimRef: a.claimRef?.trim() || null });
      }
    }
    return out;
  }

  /**
   * The cost as expenses (category from the expense settings, payee the vendor): the business's
   * share, and the driver's charged to them. In-house labour is wages already paid, so it is
   * costed on the order but not posted (decision 387).
   */
  private async post(order: WorkOrder, today: string, userId: string): Promise<void> {
    const { deps } = this;
    const p = order.snapshot();
    const inHouseLabour =
      p.vendorId === null
        ? p.lines.filter((l) => l.kind === "labour").reduce((s, l) => s + l.amountMinor, 0)
        : 0;
    const driver = p.allocations.find((a) => a.payer === "driver");
    const driverMinor = driver?.amountMinor ?? 0;
    const companyMinor = Math.max(0, order.totalMinor() - inHouseLabour - driverMinor);
    if (companyMinor === 0 && driverMinor === 0) return;
    const { maintenanceCategoryCode } = await deps.expenseSettings.get();
    const category = (await deps.reference.expenseCategories()).find(
      (c) => c.code === maintenanceCategoryCode,
    );
    if (category === undefined)
      throw new WorkOrderError(`There is no "${maintenanceCategoryCode}" expense category`);
    const payee: Partial<ExpenseRequest> =
      p.vendorId === null
        ? { payeeName: "In-house workshop" }
        : { payeeType: "supplier", payeeId: p.vendorId };
    const request = (minor: number, extra: Partial<ExpenseRequest>): ExpenseRequest => ({
      categoryId: category.id,
      description: `Work order ${p.number}: ${p.title}`.slice(0, 300),
      branchId: p.branchId,
      expenseDate: today,
      ...payee,
      amount: Money.ofMinor(minor, p.currency).toDecimalString(),
      vehicleIds: [p.vehicleId],
      reference: p.vendorInvoiceRef,
      ...extra,
    });
    const source = { type: REF_TYPE, id: p.id };
    let expenseId: string | null = null;
    let driverExpenseId: string | null = null;
    if (companyMinor > 0) {
      const expense = await deps.expenses.draftFor(
        userId,
        request(companyMinor, {}),
        p.branchId,
        source,
      );
      await deps.expenses.submitLoaded(expense, userId, { skipReceiptRule: true });
      expenseId = expense.id;
    }
    if (driverMinor > 0) {
      const expense = await deps.expenses.draftFor(
        userId,
        request(driverMinor, {
          description: `Work order ${p.number}: ${p.title} (driver's share)`.slice(0, 300),
          driverId: driver!.driverId,
          chargeToDriver: true,
        }),
        p.branchId,
        source,
      );
      await deps.expenses.submitLoaded(expense, userId, { skipReceiptRule: true });
      driverExpenseId = expense.id;
    }
    order.postedExpenses(expenseId, driverExpenseId);
  }

  // --- helpers ---

  private async mutate(
    actor: Principal,
    id: string,
    action: string,
    apply: (order: WorkOrder, now: Date) => Promise<void>,
  ): Promise<WorkOrderView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const order = await this.reach(actor, id, "maintenance.work_orders.manage", true);
      const before = order.snapshot();
      await apply(order, deps.clock.now());
      await deps.orders.update(order);
      await this.audit(actor, action, order, before);
      return this.view(order);
    });
  }

  private async reach(
    actor: Principal,
    id: string,
    permission: "maintenance.view" | "maintenance.work_orders.manage",
    lock = false,
  ): Promise<WorkOrder> {
    const { deps } = this;
    const order = lock ? await deps.orders.lock(id) : await deps.orders.get(id);
    if (order === null || !deps.vehicleAccess.can(actor, permission, order.snapshot().branchId))
      throw new WorkOrderNotFoundError();
    return order;
  }

  private async checkParties(
    input: Readonly<{ vendorId?: string | null; assignedTo?: string | null }>,
  ): Promise<void> {
    const { orders } = this.deps;
    if (
      input.vendorId !== undefined &&
      input.vendorId !== null &&
      !(await orders.exists("supplier", input.vendorId))
    )
      throw new WorkOrderError("That vendor is not an active supplier");
    if (
      input.assignedTo !== undefined &&
      input.assignedTo !== null &&
      !(await orders.exists("user", input.assignedTo))
    )
      throw new WorkOrderError("That mechanic is not a user of the business");
  }

  /** Tasks of the vehicle's plan; for a preventive order, those coming up when none are named. */
  private async tasksFor(
    vehicleId: string,
    type: WorkOrderType,
    given: readonly string[] | undefined,
  ): Promise<string[]> {
    const plan = await this.deps.schedule.tasksOf(vehicleId);
    if (given === undefined)
      return type === "preventive"
        ? plan.filter((t) => t.status !== null && t.status !== "scheduled").map((t) => t.id)
        : [];
    const unknown = given.find((id) => !plan.some((t) => t.id === id));
    if (unknown !== undefined)
      throw new WorkOrderError("A service task named is not on the vehicle's service plan");
    return [...given];
  }

  private lines(lines: readonly LineInput[], currency: string) {
    return lines.map((l) => ({
      id: this.deps.ids.next(),
      kind: l.kind,
      description: l.description,
      quantity: l.quantity,
      unitCostMinor: Money.parse(l.unitCost, currency).amountMinor,
      partRef: l.partRef ?? null,
    }));
  }

  private expected(at: Date | null, now: Date): Date | null {
    if (at !== null && at <= now)
      throw new WorkOrderError("The vehicle is expected back later than now");
    return at;
  }

  private view(order: WorkOrder): WorkOrderView {
    const p = order.snapshot();
    const m = (minor: number) => Money.ofMinor(minor, p.currency).toJSON();
    const byKind = (kind: LineKind) =>
      m(p.lines.filter((l) => l.kind === kind).reduce((s, l) => s + l.amountMinor, 0));
    return {
      ...p,
      lines: p.lines.map(({ unitCostMinor, amountMinor, ...l }) => ({
        ...l,
        unitCost: m(unitCostMinor),
        amount: m(amountMinor),
      })),
      allocations: p.allocations.map(({ amountMinor, ...a }) => ({ ...a, amount: m(amountMinor) })),
      total: m(order.totalMinor()),
      byKind: {
        labour: byKind("labour"),
        part: byKind("part"),
        sublet: byKind("sublet"),
        other: byKind("other"),
      },
      downtimeHours: order.downtimeHours(this.deps.clock.now()),
    };
  }

  private async audit(
    actor: Principal,
    action: string,
    order: WorkOrder,
    before: WorkOrderProps | null,
  ): Promise<void> {
    const p = order.snapshot();
    const summary = (o: WorkOrderProps) => ({
      number: o.number,
      status: o.status,
      offRoad: o.offRoad,
      totalMinor: o.lines.reduce((s, l) => s + l.amountMinor, 0),
    });
    await recordUserAction(this.deps, actor.userId, {
      action,
      entityType: "work_order",
      entityId: p.id,
      before: before === null ? null : summary(before),
      after: { ...summary(p), vehicleId: p.vehicleId },
    });
  }
}

const code = (vehicle: Vehicle) => vehicle.snapshot().plateNumber ?? vehicle.snapshot().code;
