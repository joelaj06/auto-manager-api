import {
  resolveEntitlements,
  type Plan,
  type Subscription,
} from "../../../domain/billing/Subscription.js";
import type { IBillingRepository } from "../../../domain/repositories/IBillingRepository.js";
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

/**
 * The branch-limit hook (docs/25 §7) and the billed branch count:
 * - trial: up to the plan's trial limit; the billed count follows the active branches, so the
 *   first invoice covers what the tenant uses;
 * - paying: the billed count is the limit; one more branch needs the tenant's confirmation of
 *   the extra charge (raises the count; the rest of the paid period is prorated onto the next
 *   invoice, which then bills the new count);
 * - deactivating a branch lowers the count to the active branches (the saving applies from the
 *   next invoice; reactivating it later needs confirmation again).
 */
export class BranchEntitlements {
  constructor(
    private readonly deps: Readonly<{
      billing: IBillingRepository;
      subscriptions: SubscriptionAdministration;
      unitOfWork: IPlatformUnitOfWork;
      ids: IIdGenerator;
      clock: IClock;
    }>,
  ) {}

  async beforeActivating(
    tenantId: string,
    activeBranches: number,
    options: Readonly<{ confirmPurchase: boolean; userId: string }>,
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
          await this.setCount(subscription, wanted, "branch_added", options.userId, false);
        return;
      }
      if (!entitlements.canBuyBranches || !options.confirmPurchase)
        throw new BranchLimitError(
          entitlements.branchesMax,
          entitlements.canBuyBranches,
          plan.branchPriceMinor,
          plan.currency,
        );
      await this.setCount(subscription, wanted, "branch_added", options.userId, true, "user", plan);
    });
  }

  /** After a branch was deactivated: bill only the active branches from the next invoice. */
  async afterDeactivating(
    tenantId: string,
    activeBranches: number,
    actor: Readonly<{ type: "user" | "platform_staff"; id: string }>,
  ): Promise<void> {
    const { deps } = this;
    await deps.unitOfWork.run(async () => {
      const subscription = await deps.billing.subscriptionOf(tenantId, true);
      if (subscription === null) return;
      const count = Math.max(1, activeBranches);
      if (count >= subscription.branchCount) return;
      await this.setCount(subscription, count, "branch_removed", actor.id, false, actor.type);
    });
  }

  private async setCount(
    subscription: Subscription,
    count: number,
    type: "branch_added" | "branch_removed",
    actorId: string,
    confirmedByTenant: boolean,
    actorType: "user" | "platform_staff" = "user",
    plan: Plan | null = null,
  ): Promise<void> {
    const before = subscription.branchCount;
    subscription.setBranchCount(count);
    if (plan !== null)
      await chargeAddedBranches(this.deps, subscription, plan, { type: actorType, id: actorId });
    await this.deps.billing.saveSubscription(subscription);
    await this.deps.billing.appendEvent(subscription.id, {
      type,
      details: { before, after: count, confirmedByTenant },
      actorType,
      actorId,
    });
  }
}
