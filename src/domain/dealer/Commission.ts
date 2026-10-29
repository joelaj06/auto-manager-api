import { DomainError } from "../errors/DomainError.js";
import { divideHalfEven, parseDecimal, pow10 } from "../money/Decimal.js";

export class CommissionRuleError extends DomainError {
  readonly code = "COMMISSION_RULE";
  constructor(message: string) {
    super(message);
  }
}

export const COMMISSION_BASES = ["gross_profit_percent", "price_percent", "flat"] as const;
export type CommissionBasis = (typeof COMMISSION_BASES)[number];
export const COMMISSION_STATUSES = ["accrued", "payable", "paid", "clawed_back"] as const;
export type CommissionStatus = (typeof COMMISSION_STATUSES)[number];

/** From the `fromUnits`th vehicle delivered in the month: a percentage or a flat amount. */
export type CommissionTier = Readonly<{
  fromUnits: number;
  percent: string | null;
  amountMinor: number | null;
}>;

export type CommissionPlanProps = Readonly<{
  id: string;
  name: string;
  /** Null: everyone without a plan of their own. */
  userId: string | null;
  basis: CommissionBasis;
  tiers: readonly CommissionTier[];
  active: boolean;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}>;

export type CommissionShare = Readonly<{ userId: string; percent: number }>;

const MAX_TIERS = 10;
const MAX_SHARES = 5;
const MAX_MINOR = 1_000_000_000_00;
const PERCENT = /^\d{1,3}(\.\d{1,2})?$/;

/**
 * A commission plan (docs/10 §8): a percentage of the gross profit or of the price, or a flat
 * amount per vehicle, in tiers by the vehicles the seller delivers in the month (decision 455).
 */
export class CommissionPlan {
  private constructor(private props: CommissionPlanProps) {}

  static define(
    input: Omit<CommissionPlanProps, "active" | "createdAt" | "updatedAt"> &
      Readonly<{ now: Date }>,
  ): CommissionPlan {
    const { now, ...rest } = input;
    return new CommissionPlan({
      ...rest,
      ...checkPlan(rest),
      active: true,
      createdAt: now,
      updatedAt: now,
    });
  }

  static restore(props: CommissionPlanProps): CommissionPlan {
    return new CommissionPlan(props);
  }

  get id(): string {
    return this.props.id;
  }

  snapshot(): CommissionPlanProps {
    return this.props;
  }

  revise(terms: Pick<CommissionPlanProps, "name" | "basis" | "tiers">, now: Date): void {
    if (!this.props.active) throw new CommissionRuleError("The plan is retired");
    this.props = { ...this.props, ...checkPlan(terms), updatedAt: now };
  }

  retire(now: Date): void {
    if (!this.props.active) throw new CommissionRuleError("The plan is already retired");
    this.props = { ...this.props, active: false, updatedAt: now };
  }

  /** The tier the `units`th vehicle of the month falls in. */
  tierFor(units: number): CommissionTier {
    const tiers = this.props.tiers;
    let tier = tiers[0]!;
    for (const t of tiers) if (t.fromUnits <= units) tier = t;
    return tier;
  }

  /**
   * One seller's commission on a delivered vehicle: the tier of their `units`th vehicle this
   * month, on the gross profit (never below zero) or the price, times their share.
   */
  earn(
    figures: Readonly<{ grossProfitMinor: number; priceMinor: number }>,
    units: number,
    sharePercent: number,
  ): Readonly<{ rate: string; baseMinor: number; amountMinor: number }> {
    const tier = this.tierFor(units);
    const share = (minor: bigint) => Number(divideHalfEven(minor * BigInt(sharePercent), 100n));
    if (this.props.basis === "flat")
      return {
        rate: String(tier.amountMinor),
        baseMinor: tier.amountMinor!,
        amountMinor: share(BigInt(tier.amountMinor!)),
      };
    const baseMinor =
      this.props.basis === "gross_profit_percent"
        ? Math.max(0, figures.grossProfitMinor)
        : figures.priceMinor;
    const r = parseDecimal(tier.percent!);
    const gross = divideHalfEven(BigInt(baseMinor) * r.units, 100n * pow10(r.scale));
    return { rate: tier.percent!, baseMinor, amountMinor: share(gross) };
  }
}

function checkPlan(
  p: Pick<CommissionPlanProps, "name" | "basis" | "tiers">,
): Pick<CommissionPlanProps, "name" | "basis" | "tiers"> {
  const name = p.name.trim();
  if (name.length === 0 || name.length > 120) throw new CommissionRuleError("Name the plan");
  if (p.tiers.length === 0 || p.tiers.length > MAX_TIERS)
    throw new CommissionRuleError(`A plan has 1 to ${MAX_TIERS} tiers`);
  const flat = p.basis === "flat";
  const tiers = p.tiers.map((t, i) => {
    if (!Number.isInteger(t.fromUnits) || t.fromUnits < 1)
      throw new CommissionRuleError("A tier starts from a number of vehicles (1 or more)");
    if (i === 0 && t.fromUnits !== 1)
      throw new CommissionRuleError("The first tier starts from the first vehicle");
    if (i > 0 && t.fromUnits <= p.tiers[i - 1]!.fromUnits)
      throw new CommissionRuleError("Tiers go up by the number of vehicles");
    if (flat) {
      if (
        t.amountMinor === null ||
        !Number.isInteger(t.amountMinor) ||
        t.amountMinor <= 0 ||
        t.amountMinor > MAX_MINOR
      )
        throw new CommissionRuleError("A flat commission is an amount per vehicle");
      return { fromUnits: t.fromUnits, percent: null, amountMinor: t.amountMinor };
    }
    if (t.percent === null || !PERCENT.test(t.percent) || Number(t.percent) > 100)
      throw new CommissionRuleError("A commission percentage is 0 to 100 with 2 decimals");
    return { fromUnits: t.fromUnits, percent: t.percent, amountMinor: null };
  });
  return { name, basis: p.basis, tiers };
}

/** Who shares a sale's commission: up to five sellers, whole percentages adding up to 100. */
export function checkSplit(split: readonly CommissionShare[]): CommissionShare[] {
  if (split.length === 0 || split.length > MAX_SHARES)
    throw new CommissionRuleError(`A commission is shared by 1 to ${MAX_SHARES} people`);
  if (new Set(split.map((s) => s.userId)).size !== split.length)
    throw new CommissionRuleError("Each person shares the commission once");
  for (const s of split)
    if (!Number.isInteger(s.percent) || s.percent < 1 || s.percent > 100)
      throw new CommissionRuleError("A share is a whole percentage from 1 to 100");
  if (split.reduce((sum, s) => sum + s.percent, 0) !== 100)
    throw new CommissionRuleError("The shares add up to 100%");
  return split.map((s) => ({ userId: s.userId, percent: s.percent }));
}

export type CommissionProps = Readonly<{
  id: string;
  dealId: string;
  userId: string;
  branchId: string;
  /** The month it counts in (YYYY-MM). */
  period: string;
  kind: "earned" | "clawback";
  planId: string | null;
  basis: CommissionBasis;
  rate: string;
  baseMinor: number;
  sharePercent: number;
  amountMinor: number;
  status: CommissionStatus;
  accruedOn: string;
  payableOn: string | null;
  payoutId: string | null;
  clawsBackId: string | null;
  clawedBackAt: Date | null;
  clawbackReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}>;

/**
 * A seller's commission on a sale (docs/10 §8, decisions 456–458): accrued at delivery, payable
 * once the sale is paid in full, paid in a monthly payout; clawed back before it is paid, or
 * by a negative entry against the next payout once paid.
 */
export class Commission {
  private constructor(private props: CommissionProps) {}

  static accrue(
    input: Omit<
      CommissionProps,
      | "period"
      | "kind"
      | "status"
      | "payableOn"
      | "payoutId"
      | "clawsBackId"
      | "clawedBackAt"
      | "clawbackReason"
      | "createdAt"
      | "updatedAt"
    > &
      Readonly<{ now: Date }>,
  ): Commission {
    const { now, ...rest } = input;
    return new Commission({
      ...rest,
      period: rest.accruedOn.slice(0, 7),
      kind: "earned",
      status: "accrued",
      payableOn: null,
      payoutId: null,
      clawsBackId: null,
      clawedBackAt: null,
      clawbackReason: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  static restore(props: CommissionProps): Commission {
    return new Commission(props);
  }

  get id(): string {
    return this.props.id;
  }

  get status(): CommissionStatus {
    return this.props.status;
  }

  snapshot(): CommissionProps {
    return this.props;
  }

  /** The sale is paid in full. */
  makePayable(on: string, now: Date): boolean {
    if (this.props.status !== "accrued") return false;
    this.props = { ...this.props, status: "payable", payableOn: on, updatedAt: now };
    return true;
  }

  pay(payoutId: string, now: Date): void {
    if (this.props.status !== "payable")
      throw new CommissionRuleError("The commission is not payable");
    this.props = { ...this.props, status: "paid", payoutId, updatedAt: now };
  }

  /**
   * Withdrawn: an unpaid commission is cancelled (its accrual reversed); a paid one is recovered
   * by the returned negative entry, payable against the seller's next payout.
   */
  clawBack(
    reason: string,
    params: Readonly<{ id: string; today: string; now: Date }>,
  ): Commission | null {
    const p = this.props;
    const text = reason.trim();
    if (text.length < 3) throw new CommissionRuleError("Say why the commission is clawed back");
    if (p.kind === "clawback") throw new CommissionRuleError("A clawback is not clawed back");
    if (p.status === "clawed_back" || p.clawbackReason !== null)
      throw new CommissionRuleError("The commission is already clawed back");
    const now = params.now;
    if (p.status !== "paid") {
      this.props = {
        ...p,
        status: "clawed_back",
        clawedBackAt: now,
        clawbackReason: text,
        updatedAt: now,
      };
      return null;
    }
    // Stays paid: the reason marks it recovered by the negative entry.
    this.props = { ...p, clawbackReason: text, updatedAt: now };
    return new Commission({
      ...p,
      id: params.id,
      period: params.today.slice(0, 7),
      kind: "clawback",
      amountMinor: -p.amountMinor,
      status: "payable",
      accruedOn: params.today,
      payableOn: params.today,
      payoutId: null,
      clawsBackId: p.id,
      clawedBackAt: null,
      clawbackReason: text,
      createdAt: now,
      updatedAt: now,
    });
  }
}

/** Gross profit on a unit (docs/10 §1, decision 454). */
export type GrossProfit = Readonly<{
  /** The sale invoice before tax: the vehicle after discount and the add-ons. */
  revenueMinor: number;
  /** What the vehicle cost the books (net of depreciation), or the consignor's payout. */
  costMinor: number;
  /** Spend on the vehicle since it entered stock (net of recoverable tax). */
  reconditioningMinor: number;
  /** Days in stock until the sale at the holding cost per day. */
  holdingMinor: number;
  commissionMinor: number;
  /** Before commission: what commissions on gross profit are a share of. */
  beforeCommissionMinor: number;
  grossProfitMinor: number;
}>;

export function grossProfit(
  f: Omit<GrossProfit, "beforeCommissionMinor" | "grossProfitMinor">,
): GrossProfit {
  const beforeCommissionMinor =
    f.revenueMinor - f.costMinor - f.reconditioningMinor - f.holdingMinor;
  return {
    ...f,
    beforeCommissionMinor,
    grossProfitMinor: beforeCommissionMinor - f.commissionMinor,
  };
}
