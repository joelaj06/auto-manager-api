import { DomainError } from "../errors/DomainError.js";

export class WorkOrderError extends DomainError {
  readonly code = "WORK_ORDER_RULE";
  constructor(message: string) {
    super(message);
  }
}

export const WORK_ORDER_TYPES = [
  "preventive",
  "corrective",
  "accident",
  "reconditioning",
  "inspection",
] as const;
export type WorkOrderType = (typeof WORK_ORDER_TYPES)[number];

export const WORK_ORDER_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type WorkOrderPriority = (typeof WORK_ORDER_PRIORITIES)[number];

export const WORK_ORDER_STATUSES = [
  "open",
  "in_progress",
  "awaiting_parts",
  "completed",
  "cancelled",
] as const;
export type WorkOrderStatus = (typeof WORK_ORDER_STATUSES)[number];

export const LINE_KINDS = ["labour", "part", "sublet", "other"] as const;
export type LineKind = (typeof LINE_KINDS)[number];

export const PAYERS = ["company", "driver", "customer", "insurer"] as const;
export type Payer = (typeof PAYERS)[number];

export type WorkOrderLine = Readonly<{
  id: string;
  position: number;
  kind: LineKind;
  description: string;
  /** Hours for labour, units for parts (two decimals). */
  quantity: number;
  unitCostMinor: number;
  amountMinor: number;
  partRef: string | null;
}>;

export type Allocation = Readonly<{
  payer: Payer;
  amountMinor: number;
  driverId: string | null;
  customerId: string | null;
  insurerId: string | null;
  claimRef: string | null;
}>;

export type WorkOrderProps = Readonly<{
  id: string;
  number: string;
  vehicleId: string;
  branchId: string;
  type: WorkOrderType;
  priority: WorkOrderPriority;
  status: WorkOrderStatus;
  title: string;
  description: string | null;
  issueId: string | null;
  damageId: string | null;
  serviceTaskIds: readonly string[];
  vendorId: string | null;
  assignedTo: string | null;
  warranty: boolean;
  offRoad: boolean;
  blockId: string | null;
  statusBefore: string | null;
  workpayAgreementId: string | null;
  expectedBackAt: Date | null;
  downtimeStartedAt: Date | null;
  downtimeEndedAt: Date | null;
  odometerIn: number | null;
  odometerOut: number | null;
  currency: string;
  vendorInvoiceRef: string | null;
  vendorRating: number | null;
  expenseId: string | null;
  driverExpenseId: string | null;
  notes: string | null;
  lines: readonly WorkOrderLine[];
  allocations: readonly Allocation[];
  startedAt: Date | null;
  completedAt: Date | null;
  completedBy: string | null;
  cancelledAt: Date | null;
  cancelledBy: string | null;
  cancelReason: string | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}>;

/** What can change while the job is open. */
export type WorkOrderDetails = Readonly<{
  type: WorkOrderType;
  priority: WorkOrderPriority;
  title: string;
  description: string | null;
  serviceTaskIds: readonly string[];
  vendorId: string | null;
  assignedTo: string | null;
  warranty: boolean;
  expectedBackAt: Date | null;
  notes: string | null;
}>;

const MAX_LINES = 100;
const MAX_MINOR = 1_000_000_000_00;

/** Status moves by hand (completing and cancelling have their own steps). */
const MOVES: Readonly<Record<WorkOrderStatus, readonly WorkOrderStatus[]>> = {
  open: ["in_progress", "awaiting_parts"],
  in_progress: ["awaiting_parts"],
  awaiting_parts: ["in_progress"],
  completed: [],
  cancelled: [],
};

/**
 * A work order (docs/12 §3): `open → in_progress ⇄ awaiting_parts → completed`, or cancelled
 * before. Its lines cost the job; on completion the business pays what the driver, the renter
 * and an insurer do not (decisions 381–388).
 */
export class WorkOrder {
  private constructor(private props: WorkOrderProps) {}

  static open(
    input: WorkOrderDetails &
      Readonly<{
        id: string;
        number: string;
        vehicleId: string;
        branchId: string;
        issueId: string | null;
        damageId: string | null;
        odometerIn: number | null;
        currency: string;
        createdBy: string;
        now: Date;
      }>,
  ): WorkOrder {
    const order = new WorkOrder({
      id: input.id,
      number: input.number,
      vehicleId: input.vehicleId,
      branchId: input.branchId,
      ...details(input),
      status: "open",
      issueId: input.issueId,
      damageId: input.damageId,
      offRoad: false,
      blockId: null,
      statusBefore: null,
      workpayAgreementId: null,
      downtimeStartedAt: null,
      downtimeEndedAt: null,
      odometerIn: input.odometerIn,
      odometerOut: null,
      currency: input.currency,
      vendorInvoiceRef: null,
      vendorRating: null,
      expenseId: null,
      driverExpenseId: null,
      lines: [],
      allocations: [],
      startedAt: null,
      completedAt: null,
      completedBy: null,
      cancelledAt: null,
      cancelledBy: null,
      cancelReason: null,
      createdBy: input.createdBy,
      createdAt: input.now,
      updatedAt: input.now,
    });
    return order;
  }

  static restore(props: WorkOrderProps): WorkOrder {
    return new WorkOrder(props);
  }

  get id(): string {
    return this.props.id;
  }

  get status(): WorkOrderStatus {
    return this.props.status;
  }

  get final(): boolean {
    return this.props.status === "completed" || this.props.status === "cancelled";
  }

  snapshot(): WorkOrderProps {
    return this.props;
  }

  totalMinor(): number {
    return this.props.lines.reduce((s, l) => s + l.amountMinor, 0);
  }

  change(changes: Partial<WorkOrderDetails>, now: Date): void {
    this.assertOpen();
    this.props = { ...this.props, ...details({ ...this.props, ...changes }), updatedAt: now };
  }

  move(to: WorkOrderStatus, now: Date): void {
    this.assertOpen();
    if (!MOVES[this.props.status].includes(to))
      throw new WorkOrderError(
        `A work order ${label(this.props.status)} cannot be marked ${label(to)}`,
      );
    this.props = {
      ...this.props,
      status: to,
      startedAt: this.props.startedAt ?? (to === "in_progress" ? now : null),
      updatedAt: now,
    };
  }

  /** Replaces the lines (amount = quantity × unit cost, rounded to the minor unit). */
  setLines(lines: readonly Omit<WorkOrderLine, "amountMinor" | "position">[], now: Date): void {
    this.assertOpen();
    if (lines.length > MAX_LINES) throw new WorkOrderError(`At most ${MAX_LINES} lines`);
    this.props = {
      ...this.props,
      lines: lines.map((l, position) => {
        const description = l.description.trim();
        if (description.length === 0) throw new WorkOrderError("Describe every line");
        if (
          !(l.quantity > 0) ||
          l.quantity > 100_000 ||
          Math.round(l.quantity * 100) !== l.quantity * 100
        )
          throw new WorkOrderError(
            `${description}: the quantity is above 0 with two decimals at most`,
          );
        if (
          !Number.isInteger(l.unitCostMinor) ||
          l.unitCostMinor < 0 ||
          l.unitCostMinor > MAX_MINOR
        )
          throw new WorkOrderError(`${description}: the unit cost is not valid`);
        return {
          ...l,
          description,
          position,
          partRef: l.partRef?.trim() || null,
          amountMinor: Math.round(l.quantity * l.unitCostMinor),
        };
      }),
      updatedAt: now,
    };
  }

  /** Off the road from `at`: the maintenance block, the status it left and any downtime. */
  wentOffRoad(
    params: Readonly<{
      at: Date;
      blockId: string;
      statusBefore: string | null;
      workpayAgreementId: string | null;
    }>,
  ): void {
    this.assertOpen();
    if (this.props.offRoad) throw new WorkOrderError("The vehicle is already off the road");
    this.props = {
      ...this.props,
      offRoad: true,
      blockId: params.blockId,
      statusBefore: params.statusBefore,
      workpayAgreementId: params.workpayAgreementId,
      downtimeStartedAt: params.at,
      updatedAt: params.at,
    };
  }

  complete(
    params: Readonly<{
      allocations: readonly Allocation[];
      odometerOut: number | null;
      vendorInvoiceRef: string | null;
      vendorRating: number | null;
      userId: string;
      now: Date;
    }>,
  ): void {
    this.assertOpen();
    const total = this.totalMinor();
    const others = params.allocations.filter((a) => a.payer !== "company");
    const recovered = others.reduce((s, a) => s + a.amountMinor, 0);
    if (others.some((a) => !Number.isInteger(a.amountMinor) || a.amountMinor <= 0))
      throw new WorkOrderError("Each payer pays more than nothing");
    if (new Set(others.map((a) => a.payer)).size !== others.length)
      throw new WorkOrderError("Name each payer once");
    if (recovered > total)
      throw new WorkOrderError("Others cannot pay more than the work order costs");
    if (
      params.vendorRating !== null &&
      (!Number.isInteger(params.vendorRating) || params.vendorRating < 1 || params.vendorRating > 5)
    )
      throw new WorkOrderError("Rate the vendor from 1 to 5");
    if (params.vendorRating !== null && this.props.vendorId === null)
      throw new WorkOrderError("Only an outside vendor is rated");
    const company: Allocation = {
      payer: "company",
      amountMinor: total - recovered,
      driverId: null,
      customerId: null,
      insurerId: null,
      claimRef: null,
    };
    this.props = {
      ...this.props,
      status: "completed",
      allocations: [company, ...others],
      odometerOut: params.odometerOut,
      vendorInvoiceRef: params.vendorInvoiceRef?.trim() || null,
      vendorRating: params.vendorRating,
      downtimeEndedAt: this.props.offRoad ? params.now : null,
      completedAt: params.now,
      completedBy: params.userId,
      updatedAt: params.now,
    };
  }

  postedExpenses(expenseId: string | null, driverExpenseId: string | null): void {
    this.props = { ...this.props, expenseId, driverExpenseId };
  }

  cancel(reason: string, userId: string, now: Date): void {
    this.assertOpen();
    const why = reason.trim();
    if (why.length < 3) throw new WorkOrderError("Say why the work order is cancelled");
    this.props = {
      ...this.props,
      status: "cancelled",
      cancelReason: why,
      cancelledAt: now,
      cancelledBy: userId,
      downtimeEndedAt: this.props.offRoad ? now : null,
      updatedAt: now,
    };
  }

  /** Hours off the road so far (or in all, once back). */
  downtimeHours(now: Date): number | null {
    const p = this.props;
    if (p.downtimeStartedAt === null) return null;
    const end = p.downtimeEndedAt ?? now;
    return Math.round(((end.getTime() - p.downtimeStartedAt.getTime()) / 3_600_000) * 10) / 10;
  }

  private assertOpen(): void {
    if (this.final)
      throw new WorkOrderError(`The work order is ${label(this.props.status)}: it cannot change`);
  }
}

function details(input: WorkOrderDetails): WorkOrderDetails {
  const title = input.title.trim();
  if (title.length < 3 || title.length > 160)
    throw new WorkOrderError("Give the work order a title (3 to 160 characters)");
  const blank = (v: string | null) => (v === null || v.trim() === "" ? null : v.trim());
  return {
    type: input.type,
    priority: input.priority,
    title,
    description: blank(input.description),
    serviceTaskIds: [...new Set(input.serviceTaskIds)],
    vendorId: input.vendorId,
    assignedTo: input.assignedTo,
    warranty: input.warranty,
    expectedBackAt: input.expectedBackAt,
    notes: blank(input.notes),
  };
}

const label = (status: WorkOrderStatus) => status.replace("_", " ");
