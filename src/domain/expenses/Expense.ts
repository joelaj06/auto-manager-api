import { DomainError } from "../errors/DomainError.js";
import { Money } from "../money/Money.js";
import type { TaxCode } from "../tax/TaxCode.js";

export const EXPENSE_STATUSES = [
  "draft",
  "submitted",
  "approved",
  "rejected",
  "paid",
  "void",
] as const;
export type ExpenseStatus = (typeof EXPENSE_STATUSES)[number];
export type PayeeType = "supplier" | "driver";

export class ExpenseRuleError extends DomainError {
  readonly code = "EXPENSE_RULE";
  constructor(message: string) {
    super(message);
  }
}

/**
 * A share of the expense (a vehicle's part of a split bill, or the whole without a vehicle), in
 * the expense's currency and in the base currency at its rate.
 */
export type ExpenseLine = Readonly<{
  vehicleId: string | null;
  amountMinor: number;
  netMinor: number;
  taxMinor: number;
  amountBaseMinor: number;
  netBaseMinor: number;
  taxBaseMinor: number;
}>;

/**
 * The currency an expense is in and its rate to the base currency (base units per 1 unit; "1"
 * for the base currency), fixed with the expense (decision 410).
 */
export type ExpenseCurrency = Readonly<{ currency: string; fxRate: string; base: string }>;

export type ExpenseDetails = Readonly<{
  categoryId: string;
  description: string;
  branchId: string;
  expenseDate: string;
  payee: Readonly<{ type: PayeeType; id: string }> | null;
  payeeName: string | null;
  driverId: string | null;
  chargeToDriver: boolean;
  reference: string | null;
  notes: string | null;
}>;

export type ExpenseProps = ExpenseDetails &
  Readonly<{
    id: string;
    number: string | null;
    status: ExpenseStatus;
    currency: string;
    fxRate: string;
    amountMinor: number;
    taxCode: string | null;
    taxComponents: readonly Readonly<{
      key: string;
      name: string;
      rate: string;
      amountMinor: number;
    }>[];
    netMinor: number;
    taxMinor: number;
    /** The amounts in the base currency at the expense's rate (what is posted and reported). */
    amountBaseMinor: number;
    netBaseMinor: number;
    taxBaseMinor: number;
    lines: readonly ExpenseLine[];
    sourceType: string | null;
    sourceId: string | null;
    submittedBy: string | null;
    submittedAt: Date | null;
    approvalRuleId: string | null;
    approvedBy: string | null;
    approvedAt: Date | null;
    rejectedBy: string | null;
    rejectedAt: Date | null;
    rejectionReason: string | null;
    paymentId: string | null;
    paidAt: Date | null;
    /** Paid at another rate: the exchange gain (positive) or loss (negative) in base units. */
    fxDifferenceMinor: number;
    voidReason: string | null;
    voidedBy: string | null;
    voidedAt: Date | null;
    createdBy: string | null;
    createdAt: Date;
    updatedAt: Date;
  }>;

/** The amount of an expense and how it is split. */
export type ExpenseAmount = Readonly<{
  /** Gross, as on the receipt (minor units of the expense's currency). */
  amountMinor: number;
  /** Purchase tax included in the amount (VAT-registered businesses recover it). */
  taxCode: TaxCode | null;
  /** Shares per vehicle (weights; empty: no vehicle). Equal weights split evenly. */
  split: readonly Readonly<{ vehicleId: string; weight: number }>[];
}>;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_SPLIT = 200;

/**
 * An expense (docs/12 §8): draft → submitted → approved → paid, or rejected (then corrected and
 * resubmitted) or void. Amounts are what the receipt says (tax-inclusive); with a purchase tax
 * code the tax is worked back and recoverable. Split across vehicles, every share and its tax
 * add up exactly to the whole. Approval and payment are separate (approved ≠ paid).
 */
export class Expense {
  private constructor(private props: ExpenseProps) {}

  static draft(
    params: Readonly<{
      id: string;
      details: ExpenseDetails;
      amount: ExpenseAmount;
      currency: ExpenseCurrency;
      source: Readonly<{ type: string; id: string }> | null;
      createdBy: string | null;
      now: Date;
    }>,
  ): Expense {
    return new Expense({
      ...checked(params.details),
      ...computed(params.amount, params.currency, params.details.expenseDate),
      id: params.id,
      number: null,
      status: "draft",
      sourceType: params.source?.type ?? null,
      sourceId: params.source?.id ?? null,
      submittedBy: null,
      submittedAt: null,
      approvalRuleId: null,
      approvedBy: null,
      approvedAt: null,
      rejectedBy: null,
      rejectedAt: null,
      rejectionReason: null,
      paymentId: null,
      paidAt: null,
      fxDifferenceMinor: 0,
      voidReason: null,
      voidedBy: null,
      voidedAt: null,
      createdBy: params.createdBy,
      createdAt: params.now,
      updatedAt: params.now,
    });
  }

  static restore(props: ExpenseProps): Expense {
    return new Expense(props);
  }

  get id(): string {
    return this.props.id;
  }

  get status(): ExpenseStatus {
    return this.props.status;
  }

  snapshot(): ExpenseProps {
    return this.props;
  }

  /** Corrects a draft or a rejected expense. */
  revise(
    details: ExpenseDetails,
    amount: ExpenseAmount,
    currency: ExpenseCurrency,
    now: Date,
  ): void {
    if (this.props.status !== "draft" && this.props.status !== "rejected")
      throw new ExpenseRuleError("Only a draft or a rejected expense can be changed");
    this.props = {
      ...this.props,
      ...checked(details),
      ...computed(amount, currency, details.expenseDate),
      updatedAt: now,
    };
  }

  submit(number: string, userId: string | null, now: Date): void {
    if (this.props.status !== "draft" && this.props.status !== "rejected")
      throw new ExpenseRuleError(`A ${this.props.status} expense cannot be submitted`);
    if (this.props.payee === null && this.props.payeeName === null)
      throw new ExpenseRuleError("Say who was paid (a supplier, a driver or a name)");
    this.props = {
      ...this.props,
      number: this.props.number ?? number,
      status: "submitted",
      submittedBy: userId,
      submittedAt: now,
      rejectedBy: null,
      rejectedAt: null,
      rejectionReason: null,
      updatedAt: now,
    };
  }

  /** `userId` null with a rule: approved automatically by that rule. */
  approve(userId: string | null, ruleId: string | null, now: Date): void {
    if (this.props.status !== "submitted")
      throw new ExpenseRuleError(`A ${this.props.status} expense cannot be approved`);
    if (userId !== null && userId === this.props.submittedBy)
      throw new ExpenseRuleError("Someone else approves the expenses you submit");
    this.props = {
      ...this.props,
      status: "approved",
      approvedBy: userId,
      approvedAt: now,
      approvalRuleId: ruleId,
      updatedAt: now,
    };
  }

  reject(userId: string, reason: string, now: Date): void {
    if (this.props.status !== "submitted")
      throw new ExpenseRuleError(`A ${this.props.status} expense cannot be rejected`);
    if (reason.trim().length < 3) throw new ExpenseRuleError("Give a reason for rejecting it");
    this.props = {
      ...this.props,
      status: "rejected",
      rejectedBy: userId,
      rejectedAt: now,
      rejectionReason: reason.trim(),
      updatedAt: now,
    };
  }

  /** Paid; at another rate than the expense's, `fxDifferenceMinor` is the gain or loss. */
  markPaid(paymentId: string, now: Date, fxDifferenceMinor = 0): void {
    if (this.props.status !== "approved")
      throw new ExpenseRuleError("Only an approved, unpaid expense can be paid");
    this.props = {
      ...this.props,
      status: "paid",
      paymentId,
      paidAt: now,
      fxDifferenceMinor,
      updatedAt: now,
    };
  }

  /** Its payment was reversed: approved and unpaid again. */
  reopen(now: Date): void {
    if (this.props.status !== "paid") throw new ExpenseRuleError("This expense is not paid");
    this.props = {
      ...this.props,
      status: "approved",
      paymentId: null,
      paidAt: null,
      fxDifferenceMinor: 0,
      updatedAt: now,
    };
  }

  void(userId: string | null, reason: string, now: Date): void {
    if (this.props.status === "paid")
      throw new ExpenseRuleError("Reverse the payment of this expense first");
    if (this.props.status === "void") throw new ExpenseRuleError("This expense is already void");
    if (reason.trim().length < 3) throw new ExpenseRuleError("Give a reason for voiding it");
    this.props = {
      ...this.props,
      status: "void",
      voidReason: reason.trim(),
      voidedBy: userId,
      voidedAt: now,
      updatedAt: now,
    };
  }
}

function checked(d: ExpenseDetails): ExpenseDetails {
  const description = d.description.trim();
  if (description === "" || description.length > 300)
    throw new ExpenseRuleError("Describe the expense in up to 300 characters");
  if (!DATE.test(d.expenseDate)) throw new ExpenseRuleError("The date is YYYY-MM-DD");
  if (d.chargeToDriver && d.driverId === null)
    throw new ExpenseRuleError("Choose the driver who bears this cost");
  const text = (value: string | null, max: number) => {
    const trimmed = value?.trim() ?? "";
    if (trimmed.length > max) throw new ExpenseRuleError(`Keep it under ${max} characters`);
    return trimmed === "" ? null : trimmed;
  };
  return {
    ...d,
    description,
    payeeName: text(d.payeeName, 160),
    reference: text(d.reference, 60),
    notes: text(d.notes, 2_000),
  };
}

function computed(
  amount: ExpenseAmount,
  money: ExpenseCurrency,
  date: string,
): Pick<
  ExpenseProps,
  | "currency"
  | "fxRate"
  | "amountMinor"
  | "taxCode"
  | "taxComponents"
  | "netMinor"
  | "taxMinor"
  | "amountBaseMinor"
  | "netBaseMinor"
  | "taxBaseMinor"
  | "lines"
> {
  const { currency } = money;
  if (!Number.isSafeInteger(amount.amountMinor) || amount.amountMinor <= 0)
    throw new ExpenseRuleError("An expense has an amount");
  if (amount.split.length > MAX_SPLIT)
    throw new ExpenseRuleError(`Split across at most ${MAX_SPLIT} vehicles`);
  if (new Set(amount.split.map((s) => s.vehicleId)).size !== amount.split.length)
    throw new ExpenseRuleError("A vehicle appears twice in the split");
  const gross = Money.ofMinor(amount.amountMinor, currency);
  const taxed = amount.taxCode === null ? null : amount.taxCode.apply(gross, date, true);
  const net = taxed?.net ?? gross;
  const tax = taxed?.tax ?? Money.zero(currency);
  const weights = amount.split.length === 0 ? [1] : amount.split.map((s) => s.weight);
  if (weights.some((w) => !Number.isSafeInteger(w) || w <= 0))
    throw new ExpenseRuleError("Split weights are whole numbers above 0");
  const grossParts = gross.allocate(weights);
  const netParts = net.allocate(weights);
  // The base amounts: the whole converted once and split like the expense, so they add up.
  const foreign = currency !== money.base;
  const grossBase = foreign ? gross.convert(money.fxRate, money.base) : gross;
  const netBase = foreign ? net.convert(money.fxRate, money.base) : net;
  if (grossBase.amountMinor <= 0)
    throw new ExpenseRuleError("The amount is too small at this exchange rate");
  const grossBaseParts = grossBase.allocate(weights);
  const netBaseParts = netBase.allocate(weights);
  const lines: ExpenseLine[] = weights.map((_, i) => ({
    vehicleId: amount.split[i]?.vehicleId ?? null,
    amountMinor: grossParts[i]!.amountMinor,
    netMinor: netParts[i]!.amountMinor,
    taxMinor: grossParts[i]!.amountMinor - netParts[i]!.amountMinor,
    amountBaseMinor: grossBaseParts[i]!.amountMinor,
    netBaseMinor: netBaseParts[i]!.amountMinor,
    taxBaseMinor: grossBaseParts[i]!.amountMinor - netBaseParts[i]!.amountMinor,
  }));
  return {
    currency,
    fxRate: foreign ? money.fxRate : "1",
    amountBaseMinor: grossBase.amountMinor,
    netBaseMinor: netBase.amountMinor,
    taxBaseMinor: grossBase.amountMinor - netBase.amountMinor,
    amountMinor: gross.amountMinor,
    taxCode: amount.taxCode?.code ?? null,
    taxComponents:
      taxed?.components.map((c) => ({
        key: c.key,
        name: c.name,
        rate: c.rate,
        amountMinor: c.amount.amountMinor,
      })) ?? [],
    netMinor: net.amountMinor,
    taxMinor: tax.amountMinor,
    lines,
  };
}
