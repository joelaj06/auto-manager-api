import {
  addDays,
  circuitBreakerTrips,
  deactivationDate,
  dunningPolicy,
  planDunning,
  type DunningPolicy,
} from "../../../domain/billing/Dunning.js";
import { Money } from "../../../domain/money/Money.js";
import type { IBillingRepository } from "../../../domain/repositories/IBillingRepository.js";
import type {
  AutomationRun,
  DunningCandidate,
  IBillingAutomationRepository,
  NoticeRecord,
  PolicyVersion,
} from "../../../domain/repositories/IBillingAutomationRepository.js";
import type { PlatformPrincipal } from "../../authorization/PlatformPrincipal.js";
import type { IJobHandler } from "../../jobs/IJobHandler.js";
import type { IClock } from "../../ports/IClock.js";
import type { IIdGenerator } from "../../ports/IIdGenerator.js";
import type { ILogger } from "../../ports/ILogger.js";
import type { IPlatformAuditTrail } from "../../ports/IPlatformAuditTrail.js";
import type { IPlatformUnitOfWork } from "../../ports/IPlatformUnitOfWork.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import { recordStaffAction } from "../console/consoleAudit.js";
import type { TenantLifecycleService } from "../tenants/TenantLifecycleService.js";
import type { BillingNotices, NoticeSubject } from "./BillingNotices.js";
import type { GatewayBilling } from "./GatewayBilling.js";
import type { ManualBilling } from "./ManualBilling.js";
import { SubscriptionNotFoundError } from "./SubscriptionAdministration.js";

const DAY_MS = 86_400_000;

type Entry = Readonly<{
  tenantId: string;
  tenantName: string;
  invoiceId: string;
  branchCount: number;
  outstandingMinor: number;
  deactivateOn: string;
  reason?: string;
}>;

/** A tenant the automation will deactivate soon (the review queue, docs/25 §5.6). */
export type PendingDeactivation = Entry &
  Readonly<{
    dueOn: string;
    currency: string;
    extendedUntil: string | null;
    /** Above the policy's branch threshold: staff should check and contact them first. */
    large: boolean;
    disputeHold: string | null;
  }>;

/** What the tenant's apps show while an invoice is unpaid (web and mobile, every admin). */
export type BillingBanner = Readonly<{
  state: "due_soon" | "due" | "overdue" | "extended" | "deactivated";
  invoiceId: string;
  outstandingMinor: number;
  currency: string;
  dueOn: string;
  deactivateOn: string;
  extendedUntil: string | null;
  message: string;
}>;

/**
 * The daily billing automation (docs/25 §5): issues the invoices due soon (standard, or from an
 * enterprise tenant's accepted quote; system actor), then walks every open invoice through the dunning schedule — reminders on every
 * channel, the due-day charge of the default card (retried the next day), past due, the
 * optional read-only step and, at the end of grace, deactivation for non-payment (or trial
 * expiry when the tenant never paid). Billing is paused while a tenant is deactivated.
 *
 * Deactivation is guarded: tenants on a dispute hold are skipped; when the gateway looks
 * unhealthy (failed webhooks, a failed reconciliation) nobody is deactivated; every pending
 * payment attempt is re-verified with the provider first; a run that would deactivate too many
 * tenants stops (circuit breaker); and in dry-run mode it only records who would have been.
 * Each run is recorded with what it did. Idempotent per tenant, invoice and step.
 */
export class BillingAutomation implements IJobHandler<"billing.automation"> {
  readonly job = "billing.automation" as const;

  constructor(
    private readonly deps: Readonly<{
      automation: IBillingAutomationRepository;
      billing: IBillingRepository;
      invoices: ManualBilling;
      gateway: GatewayBilling;
      lifecycle: TenantLifecycleService;
      notices: BillingNotices;
      unitOfWork: IPlatformUnitOfWork;
      audit: IPlatformAuditTrail;
      requestContext: IRequestContext;
      ids: IIdGenerator;
      clock: IClock;
      logger: ILogger;
    }>,
  ) {}

  async handle(): Promise<void> {
    await this.run();
  }

  /** A staff member runs it now (console), e.g. after fixing a gateway problem. */
  async runNow(actor: PlatformPrincipal): Promise<AutomationRun> {
    const run = await this.run();
    await this.deps.unitOfWork.run(() =>
      recordStaffAction(this.deps, actor, {
        action: "billing.automation_run",
        entityType: "billing_automation_run",
        entityId: run.id,
        after: { status: run.status, dryRun: run.dryRun, deactivated: run.deactivated.length },
      }),
    );
    return run;
  }

  async run(): Promise<AutomationRun> {
    const { deps } = this;
    const now = deps.clock.now();
    const today = now.toISOString().slice(0, 10);
    const { policy } = await deps.automation.policy();
    const id = deps.ids.next();
    await deps.automation.startRun({ id, runOn: today, dryRun: policy.dryRun });
    const tally = { invoicesIssued: 0, noticesSent: 0, chargesTried: 0, pastDue: 0 };
    const deactivated: Entry[] = [];
    const wouldDeactivate: Entry[] = [];
    const heldBack: Entry[] = [];
    let status: AutomationRun["status"] = "completed";
    let haltReason: string | null = null;
    try {
      await deps.automation.expireExtensions(today);
      tally.invoicesIssued = await this.issueInvoices(today, policy);

      const due: Readonly<{ candidate: DunningCandidate; entry: Entry }>[] = [];
      for (const candidate of await deps.automation.dunningCandidates()) {
        try {
          const step = await this.dun(candidate, today, policy, tally);
          if (step !== null) due.push({ candidate, entry: step });
        } catch (error) {
          deps.logger.error("Billing automation failed for an invoice", {
            invoiceId: candidate.invoiceId,
            tenantId: candidate.tenantId,
            error,
          });
        }
      }

      const health = await this.gatewayHealth(now, policy);
      const ready: Readonly<{ candidate: DunningCandidate; entry: Entry }>[] = [];
      for (const item of due) {
        const reason =
          item.candidate.disputeHold !== null
            ? `Dispute hold: ${item.candidate.disputeHold}`
            : health;
        if (reason !== null) heldBack.push({ ...item.entry, reason });
        else if (await this.paidAfterAll(item.candidate))
          heldBack.push({ ...item.entry, reason: "Paid on re-verification" });
        else ready.push(item);
      }
      if (circuitBreakerTrips(ready.length, await deps.automation.operatingTenants(), policy)) {
        status = "halted";
        haltReason = `Circuit breaker: ${ready.length} deactivations in one run`;
        wouldDeactivate.push(...ready.map((r) => r.entry));
        deps.logger.error("Billing automation halted by the circuit breaker", {
          deactivations: ready.length,
        });
      } else if (policy.dryRun) {
        wouldDeactivate.push(...ready.map((r) => r.entry));
      } else {
        for (const { candidate, entry } of ready) {
          await this.deactivate(candidate, entry, policy);
          deactivated.push(entry);
        }
      }
    } catch (error) {
      status = "failed";
      haltReason = error instanceof Error ? error.message.slice(0, 500) : "Failed";
      deps.logger.error("Billing automation run failed", { runId: id, error });
    }
    const run: AutomationRun = {
      id,
      runOn: today,
      dryRun: policy.dryRun,
      status,
      haltReason,
      ...tally,
      deactivated,
      wouldDeactivate,
      heldBack,
      startedAt: now,
      finishedAt: deps.clock.now(),
    };
    await deps.automation.finishRun(run);
    deps.logger.info("Billing automation run", {
      runId: id,
      status,
      ...tally,
      deactivated: deactivated.length,
      wouldDeactivate: wouldDeactivate.length,
      heldBack: heldBack.length,
    });
    return run;
  }

  // --- console ---

  policy(): Promise<PolicyVersion> {
    return this.deps.automation.policy();
  }

  policies(limit: number): Promise<PolicyVersion[]> {
    return this.deps.automation.policies(limit);
  }

  async setPolicy(input: DunningPolicy, actor: PlatformPrincipal): Promise<PolicyVersion> {
    const { deps } = this;
    const policy = dunningPolicy(input);
    return deps.unitOfWork.run(async () => {
      const before = await deps.automation.policy();
      const saved = await deps.automation.savePolicy(policy, actor.userId);
      await recordStaffAction(deps, actor, {
        action: "billing.dunning_policy_changed",
        entityType: "dunning_policy",
        entityId: String(saved.version),
        before: before.policy,
        after: policy,
      });
      return saved;
    });
  }

  runs(limit: number): Promise<AutomationRun[]> {
    return this.deps.automation.runs(limit);
  }

  /** Who the automation would deactivate in the next 48 hours, large tenants flagged. */
  async pending(): Promise<PendingDeactivation[]> {
    const { deps } = this;
    const today = deps.clock.now().toISOString().slice(0, 10);
    const horizon = addDays(today, 2);
    const { policy } = await deps.automation.policy();
    const pending: PendingDeactivation[] = [];
    for (const c of await deps.automation.dunningCandidates()) {
      if (c.tenantStatus === "deactivated") continue;
      const deactivateOn = deactivationDate(c.dueOn, policy, c.extendedUntil);
      if (deactivateOn > horizon) continue;
      pending.push({
        tenantId: c.tenantId,
        tenantName: c.tenantName,
        invoiceId: c.invoiceId,
        branchCount: c.branchCount,
        outstandingMinor: c.outstandingMinor,
        currency: c.currency,
        dueOn: c.dueOn,
        deactivateOn,
        extendedUntil: c.extendedUntil,
        large: c.branchCount >= policy.reviewBranchThreshold,
        disputeHold: c.disputeHold,
      });
    }
    return pending.sort((a, b) => a.deactivateOn.localeCompare(b.deactivateOn));
  }

  /** Dispute hold (a billing dispute, a pending refund): no automatic deactivation. */
  async setDisputeHold(
    tenantId: string,
    reason: string | null,
    actor: PlatformPrincipal,
  ): Promise<void> {
    const { deps } = this;
    await deps.unitOfWork.run(async () => {
      if (!(await deps.automation.setDisputeHold(tenantId, reason)))
        throw new SubscriptionNotFoundError();
      await recordStaffAction(deps, actor, {
        action: reason === null ? "billing.dispute_hold_lifted" : "billing.dispute_hold_set",
        entityType: "subscription",
        entityId: tenantId,
        targetTenantId: tenantId,
        reason,
      });
    });
  }

  notices(tenantId: string, limit = 100): Promise<NoticeRecord[]> {
    return this.deps.automation.notices(tenantId, limit);
  }

  /** The banner for the tenant's apps: the oldest unpaid invoice from its first reminder. */
  async banner(tenantId: string): Promise<BillingBanner | null> {
    const { deps } = this;
    const today = deps.clock.now().toISOString().slice(0, 10);
    const { policy } = await deps.automation.policy();
    const firstReminder = Math.max(0, ...policy.reminderDaysBefore);
    const c = (await deps.automation.dunningCandidates()).find(
      (x) => x.tenantId === tenantId && addDays(x.dueOn, -firstReminder) <= today,
    );
    if (c === undefined) return null;
    const deactivateOn = deactivationDate(c.dueOn, policy, c.extendedUntil);
    const state: BillingBanner["state"] =
      c.tenantStatus === "deactivated"
        ? "deactivated"
        : c.extendedUntil !== null && c.extendedUntil >= today
          ? "extended"
          : today > c.dueOn
            ? "overdue"
            : today === c.dueOn
              ? "due"
              : "due_soon";
    const message = {
      deactivated: "Account deactivated for non-payment: pay to restore, or request an extension.",
      extended: `Extension until ${c.extendedUntil}: pay by then to keep working.`,
      overdue: `Payment overdue: access is switched off on ${deactivateOn} unless it is paid.`,
      due: "Your licence is due today.",
      due_soon: `Your licence is due on ${c.dueOn}.`,
    }[state];
    return {
      state,
      invoiceId: c.invoiceId,
      outstandingMinor: c.outstandingMinor,
      currency: c.currency,
      dueOn: c.dueOn,
      deactivateOn,
      extendedUntil: c.extendedUntil,
      message,
    };
  }

  // --- the steps ---

  /** Invoices for periods starting within the lead time, due on the period start. */
  private async issueInvoices(today: string, policy: DunningPolicy): Promise<number> {
    const { deps } = this;
    let issued = 0;
    const until = addDays(today, policy.invoiceLeadDays);
    for (const tenantId of await deps.automation.subscriptionsToInvoice(today, until)) {
      try {
        const draft = await deps.invoices.preview(tenantId);
        const dueInDays = Math.max(
          0,
          Math.round(
            (Date.parse(`${draft.period.start}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) /
              DAY_MS,
          ),
        );
        await deps.invoices.issue(tenantId, { dueInDays }, null);
        issued += 1;
      } catch (error) {
        deps.logger.error("Billing automation could not issue an invoice", { tenantId, error });
      }
    }
    return issued;
  }

  /**
   * One invoice's step today: notices, the charge, past due and read-only. Returns the tenant
   * when it is due for deactivation (decided after the whole run, behind the safeguards).
   */
  private async dun(
    c: DunningCandidate,
    today: string,
    policy: DunningPolicy,
    tally: { noticesSent: number; chargesTried: number; pastDue: number },
  ): Promise<Entry | null> {
    const { deps } = this;
    // Billing is paused while deactivated: the invoice waits for payment or an extension.
    if (c.tenantStatus === "deactivated") return null;
    const plan = planDunning(c.dueOn, today, policy, c.extendedUntil);
    const subject = this.subject(c, plan.deactivateOn);
    if (plan.charge && (await this.charge(c.invoiceId, today))) tally.chargesTried += 1;
    for (const step of plan.notices)
      tally.noticesSent += await deps.notices.send(step, subject, policy.channels);
    if (plan.pastDue && (await this.markPastDue(c))) tally.pastDue += 1;
    if (plan.readOnly && !policy.dryRun && c.tenantStatus !== "read_only")
      await deps.lifecycle.setReadOnlyForBilling(
        c.tenantId,
        c.everPaid ? "non_payment" : "trial_expired",
        `Read-only until ${Money.ofMinor(c.outstandingMinor, c.currency).formatAscii()} is paid (Billing tab).`,
      );
    if (!plan.deactivate) return null;
    return {
      tenantId: c.tenantId,
      tenantName: c.tenantName,
      invoiceId: c.invoiceId,
      branchCount: c.branchCount,
      outstandingMinor: c.outstandingMinor,
      deactivateOn: plan.deactivateOn,
    };
  }

  /** The default card, once per day (due day and the day after). */
  private async charge(invoiceId: string, today: string): Promise<boolean> {
    const { deps } = this;
    if (await deps.automation.systemChargeSince(invoiceId, new Date(`${today}T00:00:00Z`)))
      return false;
    try {
      return (await deps.gateway.chargeDefault(invoiceId)) !== null;
    } catch (error) {
      deps.logger.warn("The automatic card charge failed", { invoiceId, error });
      return true;
    }
  }

  private async markPastDue(c: DunningCandidate): Promise<boolean> {
    const { deps } = this;
    const changed = await deps.unitOfWork.run(async () => {
      const subscription = await deps.billing.subscriptionOf(c.tenantId, true);
      if (subscription === null || !subscription.markPastDue()) return false;
      await deps.billing.saveSubscription(subscription);
      await deps.billing.appendEvent(subscription.id, {
        type: "past_due",
        details: { invoiceId: c.invoiceId, dueOn: c.dueOn },
        actorType: "system",
        actorId: null,
      });
      return true;
    });
    if (c.tenantStatus === "trialing" || c.tenantStatus === "active")
      await deps.lifecycle.markPastDue(c.tenantId);
    return changed;
  }

  /** Gateway-health guard: why deactivation must wait, or null when the gateway looks fine. */
  private async gatewayHealth(now: Date, policy: DunningPolicy): Promise<string | null> {
    const { automation } = this.deps;
    const failed = await automation.failedWebhooksSince(new Date(now.getTime() - DAY_MS));
    if (failed > policy.gatewayGuard.maxFailedWebhooks24h)
      return `Gateway guard: ${failed} failed webhooks in 24 h`;
    if (await automation.reconciliationFailing(new Date(now.getTime() - 2 * DAY_MS)))
      return "Gateway guard: the latest reconciliation failed";
    return null;
  }

  /** Re-verifies pending attempts with the provider; a provider error holds the tenant back. */
  private async paidAfterAll(c: DunningCandidate): Promise<boolean> {
    try {
      return await this.deps.gateway.reverify(c.invoiceId);
    } catch {
      return true;
    }
  }

  private async deactivate(c: DunningCandidate, entry: Entry, policy: DunningPolicy) {
    const { deps } = this;
    const reason = c.everPaid ? "non_payment" : "trial_expired";
    await deps.lifecycle.deactivateForBilling(
      c.tenantId,
      reason,
      c.everPaid
        ? "Deactivated for non-payment. Sign in to the Billing tab to pay and restore access."
        : "The trial ended without a payment. Sign in to the Billing tab to pay and restore access.",
    );
    await deps.notices.send(
      "deactivated",
      this.subject(c, entry.deactivateOn),
      policy.channels.filter((ch) => ch !== "email"), // the owner's email comes with the deactivation
    );
  }

  private subject(c: DunningCandidate, deactivateOn: string): NoticeSubject {
    return {
      tenantId: c.tenantId,
      tenantName: c.tenantName,
      invoiceId: c.invoiceId,
      outstandingMinor: c.outstandingMinor,
      currency: c.currency,
      branchCount: c.branchCount,
      dueOn: c.dueOn,
      deactivateOn,
      extendedUntil: c.extendedUntil,
    };
  }
}
