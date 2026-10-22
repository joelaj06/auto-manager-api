import { prorate } from "../../../domain/billing/Proration.js";
import type { Plan, Subscription } from "../../../domain/billing/Subscription.js";
import type { IBillingRepository } from "../../../domain/repositories/IBillingRepository.js";
import type { IClock } from "../../ports/IClock.js";
import type { IIdGenerator } from "../../ports/IIdGenerator.js";

/**
 * After the billed branch count went up (inside the subscription's unit of work, before it is
 * saved): branches the current paid period has not been charged for are prorated onto the next
 * invoice (docs/25 §3). Enterprise prices are set by hand, so their prorations are left to the
 * quote (an event records the gap). Returns the amount charged.
 */
export async function chargeAddedBranches(
  deps: Readonly<{ billing: IBillingRepository; ids: IIdGenerator; clock: IClock }>,
  subscription: Subscription,
  plan: Plan,
  actor: Readonly<{ type: "user" | "platform_staff" | "system"; id: string | null }>,
): Promise<number> {
  const today = deps.clock.now().toISOString().slice(0, 10);
  const due = subscription.chargeAddedBranches(today);
  if (due === null) return 0;
  if (plan.branchPriceMinor === null) {
    await deps.billing.appendEvent(subscription.id, {
      type: "proration_not_priced",
      details: { branches: due.branches, from: today, periodEnd: due.period.end },
      actorType: actor.type,
      actorId: actor.id,
    });
    return 0;
  }
  const charge = prorate({
    branches: due.branches,
    unitMinor: plan.branchPriceMinor,
    from: today,
    period: due.period,
  });
  if (charge === null) return 0;
  const plural = charge.branches === 1 ? "" : "es";
  const id = deps.ids.next();
  await deps.billing.addAdjustment({
    id,
    subscriptionId: subscription.id,
    tenantId: subscription.tenantId,
    kind: "proration",
    description: `${charge.branches} branch${plural} added on ${today}: ${charge.days} of ${charge.periodDays} days to ${charge.periodEnd}`,
    ...charge,
  });
  await deps.billing.appendEvent(subscription.id, {
    type: "proration_charged",
    details: { adjustmentId: id, ...charge },
    actorType: actor.type,
    actorId: actor.id,
  });
  return charge.amountMinor;
}
