import { prorate } from "../../../domain/billing/Proration.js";
import {
  resolveEntitlements,
  type Plan,
  type Subscription,
} from "../../../domain/billing/Subscription.js";
import type { IBillingRepository } from "../../../domain/repositories/IBillingRepository.js";
import type {
  BranchReconciliation,
  IBranchReconciliationRepository,
} from "../../../domain/repositories/IBranchReconciliationRepository.js";
import { ApplicationError } from "../../errors/ApplicationError.js";
import type { IClock } from "../../ports/IClock.js";
import type { IIdGenerator } from "../../ports/IIdGenerator.js";
import type { IPlatformUnitOfWork } from "../../ports/IPlatformUnitOfWork.js";
import {
  SubscriptionNotFoundError,
  type SubscriptionAdministration,
} from "./SubscriptionAdministration.js";
import { chargeAddedBranches } from "./prorations.js";

/** Activating one more branch is beyond the subscription (409, docs/25 §7). */
export class BranchLimitError extends ApplicationError {
  readonly code = "ENTITLEMENT_BRANCH_LIMIT";
  constructor(
    readonly limit: number,
    readonly canBuy: boolean,
    readonly branchPriceMinor: number | null,
    currency: string,
  ) {
    super(
      canBuy
        ? `Your subscription covers ${limit} active branch${limit === 1 ? "" : "es"}. Confirm to add one` +
            (branchPriceMinor === null
              ? " (your account manager will update your price)."
              : ` for ${currency} ${(branchPriceMinor / 100).toFixed(2)} more per month.`)
        : `Your trial includes up to ${limit} active branches. Subscribe to add more.`,
    );
  }
}

export type EntitlementActor = Readonly<{ type: "user" | "platform_staff"; id: string }>;

/** What one more active branch would cost, shown before the tenant (or staff) confirm. */
export type BranchPriceImpact = Readonly<{
  status: string;
  activeBranches: number;
  billedBranches: number;
  branchesMax: number;
  /** One more fits in what is paid for (or the trial): no confirmation, no charge. */
  withinLimit: boolean;
  /** Beyond the limit, a paying tenant may buy it (a trial may not). */
  canBuy: boolean;
  currency: string;
  /** Per branch per month (the price list, or an enterprise quote's rate); null when unpriced. */
  branchPriceMinor: number | null;
  branchesMonthlyBeforeMinor: number | null;
  branchesMonthlyAfterMinor: number | null;
  /** The rest of the paid period, charged on the next invoice. */
  proration: Readonly<{
    amountMinor: number;
    days: number;
    periodDays: number;
    periodEnd: string;
  }> | null;
}>;

/**
 * The branch-limit hook (docs/25 §7) and the billed branch count:
 * - trial: up to the plan's trial limit; the billed count follows the active branches, so the
 *   first invoice covers what the tenant uses;
 * - paying: the billed count is the limit; one more branch needs confirmation of the extra
 *   charge — by the tenant, or by staff on its behalf (raises the count; the rest of the paid
 *   period is prorated onto the next invoice, which then bills the new count);
 * - deactivating a branch lowers the count to the active branches (the saving applies from the
 *   next invoice; reactivating it later needs confirmation again);
 * - reconciling compares the count with the tenant database (docs/22 §2.7): a trial or a count
 *   above the active branches is corrected; more active branches than paid for marks the tenant
 *   over its limit for staff to settle.
 */
export class BranchEntitlements {
  constructor(
    private readonly deps: Readonly<{
      billing: IBillingRepository;
      subscriptions: SubscriptionAdministration;
      reconciliations: IBranchReconciliationRepository;
      unitOfWork: IPlatformUnitOfWork;
      ids: IIdGenerator;
      clock: IClock;
    }>,
  ) {}

  async beforeActivating(
    tenantId: string,
    activeBranches: number,
    options: Readonly<{ confirmPurchase: boolean; actor: EntitlementActor }>,
  ): Promise<void> {
    const { deps } = this;
    await deps.unitOfWork.run(async () => {
      const subscription = await deps.billing.subscriptionOf(tenantId, true);
      if (subscription === null) throw new SubscriptionNotFoundError();
      const plan = await deps.subscriptions.pricedPlan(subscription);
      const entitlements = resolveEntitlements(subscription, plan, deps.clock.now());
      const wanted = activeBranches + 1;
      if (wanted <= entitlements.branchesMax) {
        if (subscription.status === "trialing" && wanted > subscription.branchCount)
          await this.setCount(subscription, wanted, "branch_added", options.actor, false);
        return;
      }
      if (!entitlements.canBuyBranches || !options.confirmPurchase)
        throw new BranchLimitError(
          entitlements.branchesMax,
          entitlements.canBuyBranches,
          plan.branchPriceMinor,
          plan.currency,
        );
      await this.setCount(subscription, wanted, "branch_added", options.actor, true, plan);
    });
  }

  /** After a branch was deactivated: bill only the active branches from the next invoice. */
  async afterDeactivating(
    tenantId: string,
    activeBranches: number,
    actor: EntitlementActor,
  ): Promise<void> {
    const { deps } = this;
    await deps.unitOfWork.run(async () => {
      const subscription = await deps.billing.subscriptionOf(tenantId, true);
      if (subscription === null) return;
      const count = Math.max(1, activeBranches);
      if (count < subscription.branchCount)
        await this.setCount(subscription, count, "branch_removed", actor, false);
      if (activeBranches <= subscription.branchCount)
        await deps.reconciliations.setOverLimit(tenantId, false, deps.clock.now());
    });
  }

  async priceImpact(tenantId: string, activeBranches: number): Promise<BranchPriceImpact> {
    const { deps } = this;
    const subscription = await deps.billing.subscriptionOf(tenantId);
    if (subscription === null) throw new SubscriptionNotFoundError();
    const plan = await deps.subscriptions.pricedPlan(subscription);
    const now = deps.clock.now();
    const entitlements = resolveEntitlements(subscription, plan, now);
    const s = subscription.snapshot();
    const wanted = activeBranches + 1;
    const withinLimit = wanted <= entitlements.branchesMax;
    const billedAfter =
      s.status === "trialing"
        ? Math.max(s.branchCount, wanted)
        : withinLimit
          ? s.branchCount
          : wanted;
    const unit = plan.branchPriceMinor;
    const today = now.toISOString().slice(0, 10);
    const charged = s.periodBranchCount ?? s.branchCount;
    const proration =
      withinLimit || unit === null || s.currentPeriodStart === null || s.currentPeriodEnd === null
        ? null
        : prorate({
            branches: Math.max(0, wanted - charged),
            unitMinor: unit,
            from: today,
            period: { start: s.currentPeriodStart, end: s.currentPeriodEnd },
          });
    return {
      status: s.status,
      activeBranches,
      billedBranches: s.branchCount,
      branchesMax: entitlements.branchesMax,
      withinLimit,
      canBuy: entitlements.canBuyBranches,
      currency: plan.currency,
      branchPriceMinor: unit,
      branchesMonthlyBeforeMinor: unit === null ? null : unit * s.branchCount,
      branchesMonthlyAfterMinor: unit === null ? null : unit * billedAfter,
      proration:
        proration === null
          ? null
          : {
              amountMinor: proration.amountMinor,
              days: proration.days,
              periodDays: proration.periodDays,
              periodEnd: proration.periodEnd,
            },
    };
  }

  /**
   * Compares the billed count with the tenant's active branches and fixes what can be fixed:
   * a trial follows its branches, a paying tenant is never billed for more than it has active.
   * More active than paid for is left to staff (over the limit).
   */
  async reconcile(
    tenantId: string,
    activeBranches: number,
    source: "job" | "staff",
    actor: EntitlementActor | null,
  ): Promise<BranchReconciliation> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const subscription = await deps.billing.subscriptionOf(tenantId, true);
      if (subscription === null) throw new SubscriptionNotFoundError();
      const plan = await deps.subscriptions.pricedPlan(subscription);
      const before = subscription.branchCount;
      const status = subscription.status;
      const now = deps.clock.now();
      let outcome: BranchReconciliation["outcome"] = "matched";
      const target = Math.max(1, activeBranches);
      if (status === "trialing" ? target !== before : status !== "canceled" && target < before) {
        await this.setCount(subscription, target, "branch_count_reconciled", actor, false);
        outcome = "fixed";
      } else if (status !== "trialing" && status !== "canceled" && activeBranches > before) {
        outcome = "over_limit";
      }
      await deps.reconciliations.setOverLimit(tenantId, outcome === "over_limit", now);
      return deps.reconciliations.record({
        tenantId,
        activeBranches,
        billedBefore: before,
        billedAfter: subscription.branchCount,
        branchesMax: resolveEntitlements(subscription, plan, now).branchesMax,
        subscriptionStatus: status,
        outcome,
        source,
        error: null,
      });
    });
  }

  private async setCount(
    subscription: Subscription,
    count: number,
    type: "branch_added" | "branch_removed" | "branch_count_reconciled",
    actor: EntitlementActor | null,
    confirmed: boolean,
    plan: Plan | null = null,
  ): Promise<void> {
    const before = subscription.branchCount;
    const by = actor ?? { type: "system" as const, id: null };
    subscription.setBranchCount(count);
    if (plan !== null) await chargeAddedBranches(this.deps, subscription, plan, by);
    await this.deps.billing.saveSubscription(subscription);
    await this.deps.billing.appendEvent(subscription.id, {
      type,
      details: {
        before,
        after: count,
        ...(type === "branch_added"
          ? { confirmedBy: confirmed ? (actor?.type === "user" ? "tenant" : "staff") : null }
          : {}),
      },
      actorType: by.type,
      actorId: by.id,
    });
  }
}
