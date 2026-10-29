import { checkSplit, type CommissionShare } from "./Commission.js";
import { DomainError } from "../errors/DomainError.js";
import {
  allocate,
  instalmentStatus,
  type InstalmentStatus,
} from "../workpay/WorkPayCollections.js";
import { WorkPayRuleError, dueDates, workPayTerms } from "../workpay/WorkPayTerms.js";
import type { AddOn, Financing } from "./Quote.js";

export class DealRuleError extends DomainError {
  readonly code = "DEAL_RULE";
  constructor(message: string) {
    super(message);
  }
}

export const DEAL_STATUSES = ["draft", "reserved", "sold", "delivered", "cancelled"] as const;
export type DealStatus = (typeof DEAL_STATUSES)[number];
export const LOAN_STATUSES = ["applied", "approved", "declined", "disbursed"] as const;
export type LoanStatus = (typeof LOAN_STATUSES)[number];
export const PLAN_FREQUENCIES = ["weekly", "monthly"] as const;
export type PlanFrequency = (typeof PLAN_FREQUENCIES)[number];

/** A bank loan for part of the price; the bank pays the dealer for the customer. */
export type BankLoan = Readonly<{ lender: string; loanMinor: number; reference: string | null }>;

/** In-house instalments: the cash before delivery, a flat charge and the schedule's shape. */
export type InstalmentPlan = Readonly<{
  downPaymentMinor: number;
  /** Flat charge on what is financed, a percentage ("15" or "12.5"). */
  markupPercent: string;
  frequency: PlanFrequency;
  months: number;
  /** Default: a period after the sale. */
  firstDueOn: string | null;
}>;

export type TradeIn = Readonly<{ appraisalId: string; valueMinor: number }>;

export type DealTerms = Readonly<{
  vehicleId: string;
  customerId: string;
  salesExecutiveId: string;
  priceMinor: number;
  discountMinor: number;
  addOns: readonly AddOn[];
  tradeIn: TradeIn | null;
  financing: Financing;
  loan: BankLoan | null;
  plan: InstalmentPlan | null;
  warrantyMonths: number;
  serviceVouchers: number;
  notes: string | null;
}>;

export type ChecklistItem = Readonly<{ item: string; checked: boolean; note: string | null }>;

export type DealProps = DealTerms &
  Readonly<{
    id: string;
    number: string;
    branchId: string;
    leadId: string | null;
    quoteId: string | null;
    status: DealStatus;
    needsApproval: boolean;
    approvedBy: string | null;
    approvedAt: Date | null;
    loanStatus: LoanStatus | null;
    holdUntil: string | null;
    reservedAt: Date | null;
    soldOn: string | null;
    invoiceId: string | null;
    chargeInvoiceId: string | null;
    planChargeMinor: number | null;
    tradeInPaymentId: string | null;
    agreementDocumentId: string | null;
    deliveredOn: string | null;
    deliveryOdometer: number | null;
    deliveryChecklist: readonly ChecklistItem[] | null;
    deliveryDocumentId: string | null;
    warrantyEndsOn: string | null;
    cancelledAt: Date | null;
    cancelReason: string | null;
    /** What the vehicle cost the books, set at the sale (decision 453). */
    costOfSaleMinor: number | null;
    /** Who shares the commission; empty: the sales executive alone. */
    commissionSplit: readonly CommissionShare[];
    createdBy: string | null;
    createdAt: Date;
    updatedAt: Date;
  }>;

export type DealTotals = Readonly<{
  vehicleMinor: number;
  addOnsMinor: number;
  /** Vehicle and add-ons, before tax. */
  totalMinor: number;
  tradeInMinor: number;
  /** What is left after the trade-in. */
  balanceMinor: number;
}>;

export type ScheduledInstalment = Readonly<{ number: number; dueOn: string; amountMinor: number }>;

export type InstalmentLine = ScheduledInstalment &
  Readonly<{ paidMinor: number; status: InstalmentStatus }>;

export type PlanPosition = Readonly<{
  instalments: readonly InstalmentLine[];
  scheduledMinor: number;
  paidMinor: number;
  outstandingMinor: number;
  overdueMinor: number;
  overdueCount: number;
  nextDue: Readonly<{ number: number; dueOn: string; outstandingMinor: number }> | null;
}>;

const MAX_MINOR = 1_000_000_000_00;
const MAX_ADD_ONS = 20;
const MAX_HOLD_DAYS = 30;
const PERCENT = /^\d{1,3}(\.\d{1,2})?$/;
const DAY_MS = 86_400_000;

const addDays = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

/** The same day `months` later, clamped to the month's end. */
export function addMonths(date: string, months: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const last = new Date(Date.UTC(y, m - 1 + months + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m - 1 + months, Math.min(d, last))).toISOString().slice(0, 10);
}

/**
 * A vehicle sale (docs/10 §6): a stock vehicle at a price less a discount with add-ons, a
 * trade-in taken as part payment, and cash, a bank loan or in-house instalments. Drafted,
 * reserved with a deposit until a date, sold (the invoice and the agreement) and delivered
 * against a checklist once what is due before delivery is paid; cancelled before the sale. A
 * price below the minimum or a discount over the seller's limit is approved first (decisions
 * 445–452).
 */
export class Deal {
  private constructor(private props: DealProps) {}

  static draft(
    input: DealTerms &
      Readonly<{
        id: string;
        number: string;
        branchId: string;
        leadId: string | null;
        quoteId: string | null;
        needsApproval: boolean;
        createdBy: string | null;
        now: Date;
      }>,
  ): Deal {
    const { id, number, branchId, leadId, quoteId, needsApproval, createdBy, now, ...terms } =
      input;
    const checked = checkTerms(terms);
    return new Deal({
      ...checked,
      id,
      number,
      branchId,
      leadId,
      quoteId,
      status: "draft",
      needsApproval,
      approvedBy: null,
      approvedAt: null,
      loanStatus: checked.financing === "bank" ? "applied" : null,
      holdUntil: null,
      reservedAt: null,
      soldOn: null,
      invoiceId: null,
      chargeInvoiceId: null,
      planChargeMinor: null,
      tradeInPaymentId: null,
      agreementDocumentId: null,
      deliveredOn: null,
      deliveryOdometer: null,
      deliveryChecklist: null,
      deliveryDocumentId: null,
      warrantyEndsOn: null,
      cancelledAt: null,
      cancelReason: null,
      costOfSaleMinor: null,
      commissionSplit: [],
      createdBy,
      createdAt: now,
      updatedAt: now,
    });
  }

  static restore(props: DealProps): Deal {
    return new Deal(props);
  }

  get id(): string {
    return this.props.id;
  }

  get status(): DealStatus {
    return this.props.status;
  }

  snapshot(): DealProps {
    return this.props;
  }

  totals(): DealTotals {
    return totalsOf(this.props);
  }

  /** Terms change until the sale; an approval holds only while the price and discount do. */
  revise(terms: DealTerms, needsApproval: boolean, now: Date): void {
    const p = this.props;
    if (p.status !== "draft" && p.status !== "reserved")
      throw new DealRuleError("The deal is closed: its terms no longer change");
    if (terms.vehicleId !== p.vehicleId)
      throw new DealRuleError("A deal stays on its vehicle: cancel it and start another");
    const checked = checkTerms(terms);
    const samePrice =
      checked.priceMinor === p.priceMinor && checked.discountMinor === p.discountMinor;
    const loanStatus =
      checked.financing !== "bank" ? null : p.financing === "bank" ? p.loanStatus : "applied";
    this.props = {
      ...p,
      ...checked,
      needsApproval,
      approvedBy: samePrice ? p.approvedBy : null,
      approvedAt: samePrice ? p.approvedAt : null,
      loanStatus,
      updatedAt: now,
    };
  }

  approve(userId: string, now: Date): void {
    const p = this.props;
    if (p.status !== "draft" && p.status !== "reserved")
      throw new DealRuleError("Only an open deal is approved");
    if (!p.needsApproval) throw new DealRuleError("The deal needs no approval");
    if (p.approvedBy !== null) throw new DealRuleError("The deal is already approved");
    this.props = { ...p, approvedBy: userId, approvedAt: now, updatedAt: now };
  }

  private assertApproved(): void {
    if (this.props.needsApproval && this.props.approvedBy === null)
      throw new DealRuleError(
        "The price is below the minimum or the discount over your limit: have it approved first",
      );
  }

  /** Holds the vehicle for the customer once a deposit is in, until `holdUntil`. */
  reserve(holdUntil: string, today: string, now: Date): void {
    if (this.props.status !== "draft") throw new DealRuleError("Only a draft deal is reserved");
    this.assertApproved();
    this.props = {
      ...this.props,
      status: "reserved",
      holdUntil: checkHold(holdUntil, today),
      reservedAt: now,
      updatedAt: now,
    };
  }

  extendHold(holdUntil: string, today: string, now: Date): void {
    if (this.props.status !== "reserved") throw new DealRuleError("The deal is not reserved");
    this.props = { ...this.props, holdUntil: checkHold(holdUntil, today), updatedAt: now };
  }

  /** The hold ran out (the daily job): back to a draft, the vehicle back on sale. */
  lapse(today: string, now: Date): boolean {
    const p = this.props;
    if (p.status !== "reserved" || p.holdUntil === null || p.holdUntil >= today) return false;
    this.props = { ...p, status: "draft", holdUntil: null, reservedAt: null, updatedAt: now };
    return true;
  }

  /** The bank's answer on the loan; returns the status it had. */
  loan(status: LoanStatus, reference: string | null, now: Date): LoanStatus {
    const p = this.props;
    if (p.financing !== "bank" || p.loanStatus === null || p.loan === null)
      throw new DealRuleError("The deal has no bank loan");
    if (p.status === "cancelled" || p.status === "delivered")
      throw new DealRuleError("The deal is closed");
    const from = p.loanStatus;
    const allowed: Readonly<Record<LoanStatus, readonly LoanStatus[]>> = {
      applied: ["approved", "declined"],
      approved: ["disbursed", "declined"],
      declined: ["applied"],
      disbursed: [],
    };
    if (!allowed[from].includes(status))
      throw new DealRuleError(`The loan is ${from}: it cannot be ${status} now`);
    const ref = reference?.trim() || null;
    this.props = {
      ...p,
      loanStatus: status,
      loan: { ...p.loan, reference: ref ?? p.loan.reference },
      updatedAt: now,
    };
    return from;
  }

  /** Before the sale: approved, and a bank loan the bank has approved. */
  assertSellable(): void {
    const p = this.props;
    if (p.status !== "draft" && p.status !== "reserved")
      throw new DealRuleError("Only an open deal is sold");
    this.assertApproved();
    if (p.financing === "bank" && p.loanStatus !== "approved" && p.loanStatus !== "disbursed")
      throw new DealRuleError("The bank has not approved the loan yet");
  }

  /** The sale is made: its invoices, the trade-in taken in and the instalment charge. */
  sell(
    params: Readonly<{
      soldOn: string;
      invoiceId: string;
      chargeInvoiceId: string | null;
      planChargeMinor: number | null;
      tradeInPaymentId: string | null;
    }>,
    now: Date,
  ): void {
    this.assertSellable();
    this.props = {
      ...this.props,
      ...params,
      status: "sold",
      holdUntil: null,
      updatedAt: now,
    };
  }

  /** The vehicle's cost taken out of the books at the sale. */
  costed(costMinor: number, now: Date): void {
    if (this.props.status !== "sold") throw new DealRuleError("Only a sold deal is costed");
    if (!Number.isInteger(costMinor) || costMinor < 0)
      throw new DealRuleError("A cost is not negative");
    this.props = { ...this.props, costOfSaleMinor: costMinor, updatedAt: now };
  }

  /** Who shares the commission, until the vehicle is delivered (when it accrues). */
  splitCommission(split: readonly CommissionShare[], now: Date): void {
    const p = this.props;
    if (p.status === "delivered" || p.status === "cancelled")
      throw new DealRuleError("The commission is settled: claw it back instead");
    this.props = { ...p, commissionSplit: checkSplit(split), updatedAt: now };
  }

  /** The commission's shares: the split, or the sales executive alone. */
  commissionShares(): readonly CommissionShare[] {
    const p = this.props;
    return p.commissionSplit.length > 0
      ? p.commissionSplit
      : [{ userId: p.salesExecutiveId, percent: 100 }];
  }

  agreementIssued(documentId: string, now: Date): void {
    this.props = { ...this.props, agreementDocumentId: documentId, updatedAt: now };
  }

  /**
   * What must be paid before the car leaves: everything on cash and bank deals; the trade-in
   * and the down payment on in-house instalments.
   */
  dueBeforeDelivery(invoicedMinor: number): number {
    const p = this.props;
    return p.financing === "in_house"
      ? p.tradeIn === null
        ? p.plan!.downPaymentMinor
        : p.tradeIn.valueMinor + p.plan!.downPaymentMinor
      : invoicedMinor;
  }

  deliver(
    params: Readonly<{
      on: string;
      odometer: number;
      checklist: readonly ChecklistItem[];
      documentId: string;
      invoicedMinor: number;
      paidMinor: number;
    }>,
    now: Date,
  ): void {
    const p = this.props;
    if (p.status !== "sold") throw new DealRuleError("Only a sold vehicle is delivered");
    const due = this.dueBeforeDelivery(params.invoicedMinor);
    if (params.paidMinor < due)
      throw new DealRuleError(
        p.financing === "in_house"
          ? "The down payment is not paid in full yet"
          : "The sale is not paid in full yet",
      );
    if (!Number.isInteger(params.odometer) || params.odometer < 0)
      throw new DealRuleError("Read the odometer");
    this.props = {
      ...p,
      status: "delivered",
      deliveredOn: params.on,
      deliveryOdometer: params.odometer,
      deliveryChecklist: checkChecklist(params.checklist),
      deliveryDocumentId: params.documentId,
      warrantyEndsOn: p.warrantyMonths === 0 ? null : addMonths(params.on, p.warrantyMonths),
      updatedAt: now,
    };
  }

  cancel(reason: string, now: Date): void {
    const p = this.props;
    if (p.status !== "draft" && p.status !== "reserved")
      throw new DealRuleError("A sold deal is not cancelled: the vehicle comes back as a return");
    const text = reason.trim();
    if (text.length < 3) throw new DealRuleError("Say why the deal was cancelled");
    this.props = {
      ...p,
      status: "cancelled",
      holdUntil: null,
      cancelledAt: now,
      cancelReason: text,
      updatedAt: now,
    };
  }
}

/**
 * Whether the terms need an approval: the vehicle below its minimum price after the discount,
 * or a discount over `maxDiscountPercent` of the price (null: no limit).
 */
export function needsApproval(
  terms: Pick<DealTerms, "priceMinor" | "discountMinor">,
  minimumPriceMinor: number | null,
  maxDiscountPercent: number | null,
): boolean {
  if (minimumPriceMinor !== null && terms.priceMinor - terms.discountMinor < minimumPriceMinor)
    return true;
  return (
    maxDiscountPercent !== null && terms.discountMinor * 100 > maxDiscountPercent * terms.priceMinor
  );
}

/**
 * The in-house schedule (docs/10 §6, decision 449): Work & Pay terms on what is financed with a
 * flat markup, in whole cedis, weekly or monthly from a period after the sale.
 */
export function instalmentSchedule(
  plan: InstalmentPlan,
  financedMinor: number,
  soldOn: string,
): Readonly<{ chargeMinor: number; schedule: readonly ScheduledInstalment[] }> {
  if (financedMinor <= 0)
    throw new DealRuleError("Nothing is left to pay in instalments: sell it for cash");
  const { firstDueOn } = planDates(plan, soldOn);
  try {
    const terms = workPayTerms({
      vehicleValueMinor: financedMinor,
      pricing: { kind: "markup_percent", percent: plan.markupPercent },
      depositMinor: 0,
      frequency: plan.frequency,
      months: plan.months,
      firstDueOn,
      roundToMinor: financedMinor >= 100 * plan.months * 5 ? 100 : 1,
    });
    return { chargeMinor: terms.markupMinor, schedule: terms.schedule };
  } catch (error) {
    if (error instanceof WorkPayRuleError) throw new DealRuleError(error.message);
    throw error;
  }
}

/** The plan's first and last due dates for a sale on `soldOn` (the amounts do not move them). */
export function planDates(
  plan: InstalmentPlan,
  soldOn: string,
): Readonly<{ firstDueOn: string; lastDueOn: string }> {
  const firstDueOn =
    plan.firstDueOn ?? (plan.frequency === "monthly" ? addMonths(soldOn, 1) : addDays(soldOn, 7));
  if (firstDueOn <= soldOn) throw new DealRuleError("The first instalment falls after the sale");
  const periods = plan.frequency === "monthly" ? plan.months : Math.round((plan.months * 52) / 12);
  return { firstDueOn, lastDueOn: dueDates(firstDueOn, plan.frequency, periods, []).at(-1)! };
}

/**
 * Where the instalments stand: what was paid towards the plan (beyond the trade-in and down
 * payment) pays them in order, as a Work & Pay payment would.
 */
export function planPosition(
  schedule: readonly ScheduledInstalment[],
  paidTowardPlanMinor: number,
  today: string,
): PlanPosition {
  const states = schedule.map((i) => ({
    id: String(i.number),
    number: i.number,
    dueOn: i.dueOn,
    amountMinor: i.amountMinor,
    paidMinor: 0,
    waivedMinor: 0,
    rescheduledMinor: 0,
    status: "upcoming" as const,
  }));
  const scheduledMinor = schedule.reduce((s, i) => s + i.amountMinor, 0);
  const paying = Math.min(Math.max(0, paidTowardPlanMinor), scheduledMinor);
  const paid = new Map<string, number>();
  if (paying > 0)
    for (const line of allocate(paying, states, []).lines) paid.set(line.id, line.amountMinor);
  const instalments = schedule.map((i) => {
    const paidMinor = paid.get(String(i.number)) ?? 0;
    return {
      ...i,
      paidMinor,
      status: instalmentStatus(
        {
          dueOn: i.dueOn,
          amountMinor: i.amountMinor,
          paidMinor,
          waivedMinor: 0,
          rescheduledMinor: 0,
        },
        today,
        0,
      ),
    };
  });
  const overdue = instalments.filter((i) => i.status === "overdue");
  const next = instalments.find((i) => i.paidMinor < i.amountMinor);
  return {
    instalments,
    scheduledMinor,
    paidMinor: paying,
    outstandingMinor: scheduledMinor - paying,
    overdueMinor: overdue.reduce((s, i) => s + i.amountMinor - i.paidMinor, 0),
    overdueCount: overdue.length,
    nextDue:
      next === undefined
        ? null
        : {
            number: next.number,
            dueOn: next.dueOn,
            outstandingMinor: next.amountMinor - next.paidMinor,
          },
  };
}

function checkHold(holdUntil: string, today: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(holdUntil))
    throw new DealRuleError("The hold date is YYYY-MM-DD");
  if (holdUntil < today) throw new DealRuleError("Hold the vehicle until today or later");
  if (holdUntil > addDays(today, MAX_HOLD_DAYS))
    throw new DealRuleError(`A vehicle is held for at most ${MAX_HOLD_DAYS} days`);
  return holdUntil;
}

function checkChecklist(items: readonly ChecklistItem[]): ChecklistItem[] {
  if (items.length === 0) throw new DealRuleError("Go through the handover checklist");
  if (items.length > 30) throw new DealRuleError("A checklist has at most 30 items");
  return items.map((i) => {
    const item = i.item.trim();
    const note = i.note?.trim() || null;
    if (item === "") throw new DealRuleError("Name each checklist item");
    if (!i.checked && note === null)
      throw new DealRuleError(`Say why "${item}" was not handed over`);
    return { item, checked: i.checked, note };
  });
}

function checkTerms(t: DealTerms): DealTerms {
  const amount = (value: number, what: string) => {
    if (!(Number.isSafeInteger(value) && value >= 0 && value <= MAX_MINOR))
      throw new DealRuleError(`The ${what} is zero or more`);
  };
  amount(t.priceMinor, "price");
  amount(t.discountMinor, "discount");
  if (t.priceMinor === 0) throw new DealRuleError("The price is above zero");
  if (t.discountMinor > t.priceMinor) throw new DealRuleError("The discount is above the price");
  if (t.addOns.length > MAX_ADD_ONS)
    throw new DealRuleError(`A deal has at most ${MAX_ADD_ONS} add-ons`);
  const addOns = t.addOns.map((a) => {
    amount(a.amountMinor, "add-on amount");
    const description = a.description.trim();
    if (description === "") throw new DealRuleError("Describe each add-on");
    return { ...a, description };
  });
  if (t.tradeIn !== null) amount(t.tradeIn.valueMinor, "trade-in value");
  const totals = totalsOf({ ...t, addOns });
  if (t.tradeIn !== null && t.tradeIn.valueMinor > totals.totalMinor)
    throw new DealRuleError("The trade-in is worth more than the sale: the dealer would owe");
  if (!Number.isInteger(t.warrantyMonths) || t.warrantyMonths < 0 || t.warrantyMonths > 120)
    throw new DealRuleError("A warranty is 0 to 120 months");
  if (!Number.isInteger(t.serviceVouchers) || t.serviceVouchers < 0 || t.serviceVouchers > 20)
    throw new DealRuleError("A deal gives 0 to 20 service vouchers");

  let loan: BankLoan | null = null;
  let plan: InstalmentPlan | null = null;
  if (t.financing === "bank") {
    if (t.loan === null) throw new DealRuleError("Give the lender and the loan amount");
    const lender = t.loan.lender.trim();
    if (lender === "") throw new DealRuleError("Name the lender");
    amount(t.loan.loanMinor, "loan");
    if (t.loan.loanMinor === 0 || t.loan.loanMinor > totals.balanceMinor)
      throw new DealRuleError("The loan is above zero and at most what is left after the trade-in");
    loan = { lender, loanMinor: t.loan.loanMinor, reference: t.loan.reference?.trim() || null };
  } else if (t.loan !== null) throw new DealRuleError("Only a bank deal has a loan");
  if (t.financing === "in_house") {
    if (t.plan === null) throw new DealRuleError("Set the instalment plan");
    amount(t.plan.downPaymentMinor, "down payment");
    if (t.plan.downPaymentMinor >= totals.balanceMinor)
      throw new DealRuleError("The down payment leaves nothing to pay in instalments");
    if (!PERCENT.test(t.plan.markupPercent) || Number(t.plan.markupPercent) > 100)
      throw new DealRuleError('The instalment charge is 0 to 100 percent, e.g. "15"');
    if (!Number.isInteger(t.plan.months) || t.plan.months < 1 || t.plan.months > 120)
      throw new DealRuleError("The plan runs 1 to 120 months");
    plan = t.plan;
  } else if (t.plan !== null) throw new DealRuleError("Only an in-house deal has instalments");

  return { ...t, addOns, loan, plan, notes: t.notes?.trim() || null };
}

function totalsOf(
  t: Pick<DealTerms, "priceMinor" | "discountMinor" | "addOns" | "tradeIn">,
): DealTotals {
  const vehicleMinor = t.priceMinor - t.discountMinor;
  const addOnsMinor = t.addOns.reduce((s, a) => s + a.amountMinor, 0);
  const totalMinor = vehicleMinor + addOnsMinor;
  const tradeInMinor = t.tradeIn?.valueMinor ?? 0;
  return {
    vehicleMinor,
    addOnsMinor,
    totalMinor,
    tradeInMinor,
    balanceMinor: totalMinor - tradeInMinor,
  };
}
