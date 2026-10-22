import { DomainError } from "../errors/DomainError.js";

export type LicenceType = "standard" | "enterprise";
export type SubscriptionStatus = "trialing" | "active" | "past_due" | "canceled";

/** A calendar date, `YYYY-MM-DD` (billing periods are whole days in Africa/Accra). */
export type BillingDate = string;

export type Plan = Readonly<{
  id: string;
  code: string;
  name: string;
  currency: string;
  pricing: "flat_per_branch" | "custom";
  /** Monthly price per branch in minor units; null until set (standard) or always (custom). */
  branchPriceMinor: number | null;
  trialDays: number;
  trialBranchLimit: number;
  features: readonly string[];
}>;

export type SubscriptionProps = Readonly<{
  id: string;
  tenantId: string;
  planId: string;
  licenceType: LicenceType;
  status: SubscriptionStatus;
  /** Branches paid for: the branch entitlement once the trial is over. */
  branchCount: number;
  trialEndsAt: Date | null;
  currentPeriodStart: BillingDate | null;
  currentPeriodEnd: BillingDate | null;
  /** Branches charged for the current paid period (its invoice plus prorations). */
  periodBranchCount: number | null;
  licenceLockedAt: Date | null;
  version: number;
}>;

export class LicenceTypeLockedError extends DomainError {
  readonly code = "LICENCE_TYPE_LOCKED";
  constructor() {
    super("The licence type is fixed after the first payment; change it with a new quote");
  }
}

export class SubscriptionRuleError extends DomainError {
  readonly code = "SUBSCRIPTION_RULE";
  constructor(message: string) {
    super(message);
  }
}

/** The longest a trial may run from today when staff extend it. */
export const MAX_TRIAL_EXTENSION_DAYS = 60;
const DAY_MS = 86_400_000;

/**
 * A tenant's subscription (docs/25): starts as a trial when the tenant is provisioned; becomes
 * active when an invoice is paid (manual billing for now), which also fixes the licence type.
 * `branchCount` is what is billed — and, out of trial, how many active branches are allowed.
 */
export class Subscription {
  private constructor(private props: SubscriptionProps) {}

  static startTrial(params: {
    id: string;
    tenantId: string;
    plan: Plan;
    trialEndsAt: Date;
  }): Subscription {
    return new Subscription({
      id: params.id,
      tenantId: params.tenantId,
      planId: params.plan.id,
      licenceType: "standard",
      status: "trialing",
      branchCount: 1,
      trialEndsAt: params.trialEndsAt,
      currentPeriodStart: null,
      currentPeriodEnd: null,
      periodBranchCount: null,
      licenceLockedAt: null,
      version: 1,
    });
  }

  static restore(props: SubscriptionProps): Subscription {
    return new Subscription(props);
  }

  get id(): string {
    return this.props.id;
  }
  get tenantId(): string {
    return this.props.tenantId;
  }
  get status(): SubscriptionStatus {
    return this.props.status;
  }
  get licenceType(): LicenceType {
    return this.props.licenceType;
  }
  get branchCount(): number {
    return this.props.branchCount;
  }

  /** Standard ⇄ Enterprise, only until the first payment (docs/25 §2.1). */
  setLicenceType(type: LicenceType, plan: Plan): void {
    if (this.props.licenceLockedAt !== null) throw new LicenceTypeLockedError();
    if (plan.code !== type)
      throw new SubscriptionRuleError(`The ${type} licence uses the ${type} plan`);
    this.props = { ...this.props, licenceType: type, planId: plan.id };
  }

  extendTrial(until: Date, now: Date): void {
    if (this.props.status !== "trialing")
      throw new SubscriptionRuleError("Only a trial can be extended");
    if (this.props.trialEndsAt !== null && until <= this.props.trialEndsAt)
      throw new SubscriptionRuleError("The new end must be after the current trial end");
    if (until.getTime() > now.getTime() + MAX_TRIAL_EXTENSION_DAYS * DAY_MS)
      throw new SubscriptionRuleError(
        `A trial can run at most ${MAX_TRIAL_EXTENSION_DAYS} days from today`,
      );
    this.props = { ...this.props, trialEndsAt: until };
  }

  setBranchCount(count: number): void {
    if (!Number.isInteger(count) || count < 1 || count > 1_000)
      throw new SubscriptionRuleError("The billed branch count must be between 1 and 1000");
    this.props = { ...this.props, branchCount: count };
  }

  /**
   * The next period to invoice: right after the current one, or from the trial end (or today,
   * whichever is later) for the first invoice. One month long.
   */
  nextPeriod(today: BillingDate): Readonly<{ start: BillingDate; end: BillingDate }> {
    const trialEnd =
      this.props.trialEndsAt === null ? today : this.props.trialEndsAt.toISOString().slice(0, 10);
    const start = this.props.currentPeriodEnd ?? (trialEnd > today ? trialEnd : today);
    return { start, end: addMonths(start, 1) };
  }

  /**
   * A paid invoice: the subscription is active for its period (covering `branches`); the
   * licence type is fixed.
   */
  applyPaidPeriod(
    period: Readonly<{ start: BillingDate; end: BillingDate }>,
    now: Date,
    branches: number = this.props.branchCount,
  ): void {
    const extends_ =
      this.props.currentPeriodEnd === null || period.end > this.props.currentPeriodEnd;
    this.props = {
      ...this.props,
      status: "active",
      currentPeriodStart: extends_ ? period.start : this.props.currentPeriodStart,
      currentPeriodEnd: extends_ ? period.end : this.props.currentPeriodEnd,
      periodBranchCount: extends_ ? branches : this.props.periodBranchCount,
      licenceLockedAt: this.props.licenceLockedAt ?? now,
    };
  }

  /**
   * More branches billed during a paid period: how many the period has not been charged for
   * yet (a branch removed and added again in the same period is not charged twice), and the
   * period to prorate. Records them as charged. Null outside a paid period or when covered.
   */
  chargeAddedBranches(today: BillingDate): Readonly<{
    branches: number;
    period: Readonly<{ start: BillingDate; end: BillingDate }>;
  }> | null {
    const { currentPeriodStart: start, currentPeriodEnd: end, periodBranchCount } = this.props;
    if (this.props.status === "trialing" || start === null || end === null) return null;
    if (today >= end || today < start) return null;
    const charged = periodBranchCount ?? this.props.branchCount;
    const extra = this.props.branchCount - charged;
    if (extra <= 0) return null;
    this.props = { ...this.props, periodBranchCount: this.props.branchCount };
    return { branches: extra, period: { start, end } };
  }

  snapshot(): SubscriptionProps {
    return this.props;
  }
}

/** `date` plus `months` calendar months; the day is clamped to the month's length. */
export function addMonths(date: BillingDate, months: number): BillingDate {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target.toISOString().slice(0, 10);
}

export type Entitlements = Readonly<{
  status: SubscriptionStatus;
  licenceType: LicenceType;
  planCode: string;
  /** Active branches allowed: the trial limit while trialing, otherwise the paid count. */
  branchesMax: number;
  /** Out of trial, more branches can be added by agreeing to pay for them. */
  canBuyBranches: boolean;
  trialEndsAt: Date | null;
  trialEnded: boolean;
  features: readonly string[];
}>;

export function resolveEntitlements(
  subscription: Subscription,
  plan: Plan,
  now: Date,
): Entitlements {
  const s = subscription.snapshot();
  const trialing = s.status === "trialing";
  return {
    status: s.status,
    licenceType: s.licenceType,
    planCode: plan.code,
    branchesMax: trialing ? Math.max(plan.trialBranchLimit, s.branchCount) : s.branchCount,
    canBuyBranches: s.status === "active" || s.status === "past_due",
    trialEndsAt: s.trialEndsAt,
    trialEnded: trialing && s.trialEndsAt !== null && s.trialEndsAt <= now,
    features: plan.features,
  };
}
