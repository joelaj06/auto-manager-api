import { billingSettings, type BillingSettings } from "../../../domain/billing/BillingSettings.js";
import {
  resolveEntitlements,
  Subscription,
  SubscriptionRuleError,
  type Entitlements,
  type LicenceType,
  type Plan,
} from "../../../domain/billing/Subscription.js";
import type {
  IBillingRepository,
  SubscriptionEvent,
} from "../../../domain/repositories/IBillingRepository.js";
import type { IEnterpriseQuoteRepository } from "../../../domain/repositories/IEnterpriseQuoteRepository.js";
import type { PlatformPrincipal } from "../../authorization/PlatformPrincipal.js";
import { ApplicationError } from "../../errors/ApplicationError.js";
import type { IClock } from "../../ports/IClock.js";
import type { IIdGenerator } from "../../ports/IIdGenerator.js";
import type { IPlatformAuditTrail } from "../../ports/IPlatformAuditTrail.js";
import type { IPlatformUnitOfWork } from "../../ports/IPlatformUnitOfWork.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import { recordStaffAction } from "../console/consoleAudit.js";
import { chargeAddedBranches } from "./prorations.js";

export class SubscriptionNotFoundError extends ApplicationError {
  readonly code = "SUBSCRIPTION_NOT_FOUND";
  constructor() {
    super("This tenant has no subscription");
  }
}

export class PlanNotFoundError extends ApplicationError {
  readonly code = "PLAN_NOT_FOUND";
  constructor() {
    super("Plan not found");
  }
}

export type SubscriptionView = Readonly<{
  tenantId: string;
  plan: Readonly<{
    code: string;
    name: string;
    currency: string;
    branchPriceMinor: number | null;
  }>;
  licenceType: LicenceType;
  status: Subscription["status"];
  branchCount: number;
  trialEndsAt: Date | null;
  currentPeriod: Readonly<{ start: string; end: string }> | null;
  licenceLocked: boolean;
  /** Staff allow more active branches than billed (with the reason). */
  branchLimitOverride: Readonly<{ branches: number; reason: string }> | null;
  /** Standard: billed branches × price; enterprise (priced by hand) or no price yet: null. */
  monthlyPriceMinor: number | null;
  entitlements: Entitlements;
}>;

/**
 * Subscriptions (docs/25): a trial when a tenant is provisioned, and the staff controls of
 * manual billing — licence type (until the first payment), trial extension, billed branch
 * count and the standard price per branch. Every change is an audited subscription event.
 */
export class SubscriptionAdministration {
  constructor(
    private readonly deps: Readonly<{
      billing: IBillingRepository;
      quotes: IEnterpriseQuoteRepository;
      unitOfWork: IPlatformUnitOfWork;
      audit: IPlatformAuditTrail;
      requestContext: IRequestContext;
      ids: IIdGenerator;
      clock: IClock;
    }>,
  ) {}

  /**
   * Provisioning: the trial subscription on the standard plan, and the billing details and
   * primary contact from the application. Idempotent.
   */
  async startTrial(tenantId: string, trialEndsAt: Date): Promise<void> {
    const { billing } = this.deps;
    await this.deps.unitOfWork.run(async () => {
      await billing.seedBillingDetails(tenantId);
      if ((await billing.subscriptionOf(tenantId, true)) !== null) return;
      const plan = await this.plan("standard");
      const subscription = Subscription.startTrial({
        id: this.deps.ids.next(),
        tenantId,
        plan,
        trialEndsAt,
      });
      await billing.saveSubscription(subscription);
      await billing.appendEvent(subscription.id, {
        type: "trial_started",
        details: { plan: plan.code, trialEndsAt: trialEndsAt.toISOString() },
        actorType: "system",
        actorId: null,
      });
    });
  }

  async view(tenantId: string): Promise<SubscriptionView> {
    const subscription = await this.deps.billing.subscriptionOf(tenantId);
    if (subscription === null) throw new SubscriptionNotFoundError();
    return this.toView(subscription);
  }

  async events(tenantId: string): Promise<SubscriptionEvent[]> {
    const subscription = await this.deps.billing.subscriptionOf(tenantId);
    if (subscription === null) throw new SubscriptionNotFoundError();
    return this.deps.billing.events(subscription.id, 100);
  }

  async entitlements(tenantId: string): Promise<Entitlements> {
    return (await this.view(tenantId)).entitlements;
  }

  plans(): Promise<Plan[]> {
    return this.deps.billing.plans();
  }

  async setPlanPrice(
    code: string,
    branchPriceMinor: number,
    reason: string,
    actor: PlatformPrincipal,
  ): Promise<Plan> {
    const { billing } = this.deps;
    return this.deps.unitOfWork.run(async () => {
      const plan = await this.plan(code);
      if (plan.pricing !== "flat_per_branch")
        throw new SubscriptionRuleError("The enterprise plan is priced per tenant, by hand");
      await billing.setPlanPrice(code, branchPriceMinor);
      await recordStaffAction(this.deps, actor, {
        action: "billing.plan_price_changed",
        entityType: "plan",
        entityId: plan.id,
        reason,
        before: { branchPriceMinor: plan.branchPriceMinor },
        after: { branchPriceMinor },
      });
      return { ...plan, branchPriceMinor };
    });
  }

  async billingSettings(): Promise<BillingSettings> {
    return this.deps.billing.settings();
  }

  /** Who we are on invoices and the VAT we charge (from the next invoice on). */
  async updateBillingSettings(
    input: BillingSettings,
    reason: string,
    actor: PlatformPrincipal,
  ): Promise<BillingSettings> {
    const { billing } = this.deps;
    return this.deps.unitOfWork.run(async () => {
      const before = await billing.settings();
      const after = billingSettings(input);
      await billing.saveSettings(after, actor.userId);
      await recordStaffAction(this.deps, actor, {
        action: "billing.settings_changed",
        entityType: "billing_settings",
        entityId: "platform",
        reason,
        before,
        after,
      });
      return after;
    });
  }

  /** A tenant's billing details and contacts (console). */
  async billingDetails(tenantId: string) {
    const { billing } = this.deps;
    return { profile: await billing.profile(tenantId), contacts: await billing.contacts(tenantId) };
  }

  async setLicenceType(
    tenantId: string,
    type: LicenceType,
    reason: string,
    actor: PlatformPrincipal,
  ): Promise<SubscriptionView> {
    return this.change(tenantId, actor, reason, "licence_type_changed", async (s) => {
      const before = s.licenceType;
      s.setLicenceType(type, await this.plan(type));
      // Back to the price list: the enterprise quotes and their prices no longer apply.
      if (before === "enterprise" && type === "standard") {
        const now = this.deps.clock.now();
        for (const quote of await this.deps.quotes.quotes(tenantId))
          if (quote.status === "draft" || quote.status === "sent") {
            quote.withdraw(now);
            await this.deps.quotes.save(quote);
          }
        await this.deps.quotes.endPriceItems(s.id, now);
      }
      return { before, after: type };
    });
  }

  async extendTrial(
    tenantId: string,
    until: Date,
    reason: string,
    actor: PlatformPrincipal,
  ): Promise<SubscriptionView> {
    return this.change(tenantId, actor, reason, "trial_extended", (s) => {
      const before = s.snapshot().trialEndsAt;
      s.extendTrial(until, this.deps.clock.now());
      return Promise.resolve({ before, after: until });
    });
  }

  /** More active branches than billed, granted by staff (docs/27 §3.9); null removes it. */
  async setBranchLimitOverride(
    tenantId: string,
    branches: number | null,
    reason: string,
    actor: PlatformPrincipal,
  ): Promise<SubscriptionView> {
    return this.change(tenantId, actor, reason, "branch_limit_overridden", (s) => {
      const before = s.snapshot().branchLimitOverride ?? null;
      s.setBranchLimitOverride(branches, branches === null ? null : reason);
      return Promise.resolve({ before, after: s.snapshot().branchLimitOverride ?? null });
    });
  }

  async setBranchCount(
    tenantId: string,
    branchCount: number,
    reason: string,
    actor: PlatformPrincipal,
  ): Promise<SubscriptionView> {
    return this.change(tenantId, actor, reason, "branch_count_set", async (s) => {
      const before = s.branchCount;
      s.setBranchCount(branchCount);
      // More branches during a paid period are prorated, as when the tenant adds them.
      const prorationMinor = await chargeAddedBranches(this.deps, s, await this.pricedPlan(s), {
        type: "platform_staff",
        id: actor.userId,
      });
      return { before, after: branchCount, prorationMinor };
    });
  }

  async toView(subscription: Subscription): Promise<SubscriptionView> {
    const s = subscription.snapshot();
    const plan = await this.pricedPlan(subscription);
    const monthly =
      plan.pricing === "custom"
        ? (await this.deps.quotes.priceItems(s.id))
            .filter((i) => i.recurrence === "monthly")
            .reduce(
              (sum, i) =>
                sum + (i.kind === "branch_rate" ? s.branchCount : i.quantity) * i.unitMinor,
              0,
            )
        : null;
    return {
      tenantId: s.tenantId,
      plan: {
        code: plan.code,
        name: plan.name,
        currency: plan.currency,
        branchPriceMinor: plan.branchPriceMinor,
      },
      licenceType: s.licenceType,
      status: s.status,
      branchCount: s.branchCount,
      trialEndsAt: s.trialEndsAt,
      currentPeriod:
        s.currentPeriodStart === null || s.currentPeriodEnd === null
          ? null
          : { start: s.currentPeriodStart, end: s.currentPeriodEnd },
      licenceLocked: s.licenceLockedAt !== null,
      branchLimitOverride: s.branchLimitOverride ?? null,
      monthlyPriceMinor:
        monthly !== null
          ? monthly || null
          : plan.branchPriceMinor === null
            ? null
            : plan.branchPriceMinor * s.branchCount,
      entitlements: resolveEntitlements(subscription, plan, this.deps.clock.now()),
    };
  }

  /**
   * The subscription's plan as priced for it: Enterprise takes the per-branch rate of its
   * accepted quote (null before one is accepted).
   */
  async pricedPlan(subscription: Subscription): Promise<Plan> {
    const plan = await this.deps.billing.planById(subscription.snapshot().planId);
    if (plan === null) throw new PlanNotFoundError();
    if (plan.pricing !== "custom") return plan;
    const rate = (await this.deps.quotes.priceItems(subscription.id)).find(
      (i) => i.kind === "branch_rate",
    );
    return { ...plan, branchPriceMinor: rate?.unitMinor ?? null };
  }

  async plan(code: string): Promise<Plan> {
    const plan = await this.deps.billing.planByCode(code);
    if (plan === null) throw new PlanNotFoundError();
    return plan;
  }

  private async change(
    tenantId: string,
    actor: PlatformPrincipal,
    reason: string,
    type: string,
    apply: (
      subscription: Subscription,
    ) => Promise<{ before: unknown; after: unknown; prorationMinor?: number }>,
  ): Promise<SubscriptionView> {
    const { billing } = this.deps;
    const subscription = await this.deps.unitOfWork.run(async () => {
      const locked = await billing.subscriptionOf(tenantId, true);
      if (locked === null) throw new SubscriptionNotFoundError();
      const { before, after } = await apply(locked);
      await billing.saveSubscription(locked);
      await billing.appendEvent(locked.id, {
        type,
        details: { before, after, reason },
        actorType: "platform_staff",
        actorId: actor.userId,
      });
      await recordStaffAction(this.deps, actor, {
        action: `subscription.${type}`,
        entityType: "subscription",
        entityId: locked.id,
        targetTenantId: tenantId,
        reason,
        before,
        after,
      });
      return locked;
    });
    return this.toView(subscription);
  }
}
