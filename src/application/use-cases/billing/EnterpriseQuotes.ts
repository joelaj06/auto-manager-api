import {
  EnterpriseQuote,
  type QuoteProps,
  type QuoteTerms,
} from "../../../domain/billing/EnterpriseQuote.js";
import { Money } from "../../../domain/money/Money.js";
import type { IBillingRepository } from "../../../domain/repositories/IBillingRepository.js";
import type {
  IEnterpriseQuoteRepository,
  PriceItem,
} from "../../../domain/repositories/IEnterpriseQuoteRepository.js";
import type { PlatformPrincipal } from "../../authorization/PlatformPrincipal.js";
import { ApplicationError } from "../../errors/ApplicationError.js";
import type { IClock } from "../../ports/IClock.js";
import type { IIdGenerator } from "../../ports/IIdGenerator.js";
import type { ILogger } from "../../ports/ILogger.js";
import type { IPlatformAuditTrail } from "../../ports/IPlatformAuditTrail.js";
import type { IPlatformUnitOfWork } from "../../ports/IPlatformUnitOfWork.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import { recordStaffAction } from "../console/consoleAudit.js";
import type { PdfFile } from "../documents/PrintedDocuments.js";
import type { BillingDocuments } from "./BillingDocuments.js";
import type { BillingNotices } from "./BillingNotices.js";
import { chargeAddedBranches } from "./prorations.js";
import {
  SubscriptionNotFoundError,
  type SubscriptionAdministration,
} from "./SubscriptionAdministration.js";

export class QuoteNotFoundError extends ApplicationError {
  readonly code = "QUOTE_NOT_FOUND";
  constructor() {
    super("Quote not found");
  }
}

/** Quotes are for Enterprise tenants, and only a Super Admin sends them (409 / 403). */
export class QuoteNotAllowedError extends ApplicationError {
  constructor(
    readonly code: "NOT_ENTERPRISE" | "QUOTE_APPROVAL_REQUIRED",
    message: string,
  ) {
    super(message);
  }
}

export type QuoteView = QuoteProps & Readonly<{ expired: boolean }>;

const SUPER_ADMIN = "super_admin";

/**
 * Enterprise quotes (docs/25 §2.1, docs/27 §3.6): Billing staff build them by hand for a tenant
 * whose licence type is Enterprise; a Super Admin approves by sending; the tenant accepts in
 * the Billing tab (or staff record its acceptance). The accepted quote becomes the
 * subscription's price items — monthly items on every invoice (the per-branch rate on the billed
 * branches), one-time items on the next invoice only — and its branches the billed count; the
 * quote it replaces is superseded. Every step is a subscription event and audited.
 */
export class EnterpriseQuotes {
  constructor(
    private readonly deps: Readonly<{
      quotes: IEnterpriseQuoteRepository;
      billing: IBillingRepository;
      subscriptions: SubscriptionAdministration;
      documents: BillingDocuments;
      notices: BillingNotices;
      unitOfWork: IPlatformUnitOfWork;
      audit: IPlatformAuditTrail;
      requestContext: IRequestContext;
      ids: IIdGenerator;
      clock: IClock;
      logger: ILogger;
    }>,
  ) {}

  // --- console ---

  async create(tenantId: string, terms: QuoteTerms, actor: PlatformPrincipal): Promise<QuoteView> {
    const { deps } = this;
    const quote = await deps.unitOfWork.run(async () => {
      const subscription = await deps.billing.subscriptionOf(tenantId, true);
      if (subscription === null) throw new SubscriptionNotFoundError();
      if (subscription.licenceType !== "enterprise")
        throw new QuoteNotAllowedError(
          "NOT_ENTERPRISE",
          "Set the tenant's licence type to Enterprise before quoting",
        );
      const plan = await deps.subscriptions.plan("enterprise");
      const now = deps.clock.now();
      const draft = EnterpriseQuote.draft({
        id: deps.ids.next(),
        code: await deps.quotes.nextQuoteCode(now.getUTCFullYear()),
        tenantId,
        subscriptionId: subscription.id,
        version: await deps.quotes.nextVersion(tenantId),
        currency: plan.currency,
        terms,
        createdBy: actor.userId,
        now,
      });
      await deps.quotes.save(draft);
      await this.audit(actor, "billing.quote_created", draft);
      return draft;
    });
    return this.view(quote);
  }

  async update(id: string, terms: QuoteTerms, actor: PlatformPrincipal): Promise<QuoteView> {
    return this.change(id, actor, "billing.quote_updated", (q, now) => q.edit(terms, now));
  }

  /** The Super Admin's approval: the quote goes to the tenant, valid until its date. */
  async send(id: string, actor: PlatformPrincipal): Promise<QuoteView> {
    if (!actor.systemRoles.has(SUPER_ADMIN))
      throw new QuoteNotAllowedError(
        "QUOTE_APPROVAL_REQUIRED",
        "Only a Super Admin approves and sends a quote",
      );
    const view = await this.change(id, actor, "billing.quote_sent", (q, now) =>
      q.send(actor.userId, now),
    );
    await this.tellTenant(view);
    return view;
  }

  async withdraw(id: string, reason: string, actor: PlatformPrincipal): Promise<QuoteView> {
    return this.change(id, actor, "billing.quote_withdrawn", (q, now) => q.withdraw(now), reason);
  }

  /** Staff record that the tenant accepted (a signed copy, an email …). */
  async acceptForTenant(id: string, reason: string, actor: PlatformPrincipal): Promise<QuoteView> {
    const quote = await this.accept(id, null, { type: "platform_staff", id: actor.userId });
    await this.deps.unitOfWork.run(() =>
      this.audit(actor, "billing.quote_accepted", quote, reason),
    );
    return this.view(quote);
  }

  async list(tenantId: string): Promise<QuoteView[]> {
    return (await this.deps.quotes.quotes(tenantId)).map((q) => this.view(q));
  }

  async quote(id: string, tenantId?: string): Promise<QuoteView> {
    return this.view(await this.find(id, tenantId));
  }

  async pdf(id: string, tenantId?: string): Promise<PdfFile> {
    const quote = await this.find(id, tenantId);
    return this.deps.documents.quote(
      quote.snapshot(),
      await this.deps.billing.tenantName(quote.snapshot().tenantId),
      await this.deps.billing.settings(),
    );
  }

  async priceItems(tenantId: string): Promise<PriceItem[]> {
    const subscription = await this.deps.billing.subscriptionOf(tenantId);
    if (subscription === null) throw new SubscriptionNotFoundError();
    return this.deps.quotes.priceItems(subscription.id);
  }

  // --- tenant (Billing tab): only quotes that were sent ---

  async tenantQuotes(tenantId: string): Promise<QuoteView[]> {
    return (await this.list(tenantId)).filter((q) => q.sentAt !== null);
  }

  async acceptAsTenant(id: string, tenantId: string, userId: string): Promise<QuoteView> {
    return this.view(await this.accept(id, tenantId, { type: "user", id: userId }));
  }

  // --- helpers ---

  /**
   * Acceptance: the previous accepted quote is superseded, the price items replaced, and the
   * billed branches set to the quote's (more branches during a paid period are prorated at the
   * new rate).
   */
  private async accept(
    id: string,
    tenantId: string | null,
    by: Readonly<{ type: "user" | "platform_staff"; id: string }>,
  ): Promise<EnterpriseQuote> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const quote = await this.find(id, tenantId ?? undefined, true);
      const q = quote.snapshot();
      const subscription = await deps.billing.subscriptionOf(q.tenantId, true);
      if (subscription === null) throw new SubscriptionNotFoundError();
      if (subscription.licenceType !== "enterprise")
        throw new QuoteNotAllowedError("NOT_ENTERPRISE", "The tenant is no longer Enterprise");
      const now = deps.clock.now();
      quote.accept(by, now);
      const previous = await deps.quotes.accepted(q.tenantId, true);
      if (previous !== null) {
        previous.supersede(now);
        await deps.quotes.save(previous);
      }
      await deps.quotes.save(quote);
      await deps.quotes.replacePriceItems(subscription.id, q.id, q.lines, now);
      const before = subscription.branchCount;
      const branches = quote.branches;
      let prorationMinor = 0;
      if (branches !== null && branches !== before) {
        subscription.setBranchCount(branches);
        prorationMinor = await chargeAddedBranches(
          deps,
          subscription,
          await deps.subscriptions.pricedPlan(subscription),
          by,
        );
      }
      await deps.billing.saveSubscription(subscription);
      await deps.billing.appendEvent(subscription.id, {
        type: "quote_accepted",
        details: {
          quoteId: q.id,
          code: q.code,
          version: q.version,
          supersedes: previous?.snapshot().code ?? null,
          recurringMinor: q.recurringMinor,
          oneTimeMinor: q.oneTimeMinor,
          branches: { before, after: subscription.branchCount },
          prorationMinor,
        },
        actorType: by.type,
        actorId: by.id,
      });
      return quote;
    });
  }

  private async change(
    id: string,
    actor: PlatformPrincipal,
    action: string,
    apply: (quote: EnterpriseQuote, now: Date) => void,
    reason?: string,
  ): Promise<QuoteView> {
    const { deps } = this;
    const quote = await deps.unitOfWork.run(async () => {
      const locked = await this.find(id, undefined, true);
      apply(locked, deps.clock.now());
      await deps.quotes.save(locked);
      await this.audit(actor, action, locked, reason);
      return locked;
    });
    return this.view(quote);
  }

  private async find(id: string, tenantId?: string, lock = false): Promise<EnterpriseQuote> {
    const quote = await this.deps.quotes.quote(id, lock);
    if (quote === null) throw new QuoteNotFoundError();
    const q = quote.snapshot();
    // Tenants see only their own quotes, once sent.
    if (tenantId !== undefined && (q.tenantId !== tenantId || q.sentAt === null))
      throw new QuoteNotFoundError();
    return quote;
  }

  private audit(
    actor: PlatformPrincipal,
    action: string,
    quote: EnterpriseQuote,
    reason?: string,
  ): Promise<void> {
    const q = quote.snapshot();
    return recordStaffAction(this.deps, actor, {
      action,
      entityType: "enterprise_quote",
      entityId: q.id,
      targetTenantId: q.tenantId,
      after: {
        code: q.code,
        version: q.version,
        status: q.status,
        recurringMinor: q.recurringMinor,
        oneTimeMinor: q.oneTimeMinor,
      },
      ...(reason === undefined ? {} : { reason }),
    });
  }

  private async tellTenant(q: QuoteView): Promise<void> {
    const m = (minor: number) => Money.ofMinor(minor, q.currency).formatAscii();
    try {
      await this.deps.notices.announce(
        q.tenantId,
        `quote_sent_v${q.version}`,
        {
          subject: "Your Autoforce Enterprise quote is ready",
          body: `Quote ${q.code}: ${m(q.recurringMinor)} a month${q.oneTimeMinor > 0 ? ` and ${m(q.oneTimeMinor)} once` : ""}, valid until ${q.validUntil ?? ""}. Review and accept it in the Billing tab.`,
          severity: "info",
        },
        ["email", "in_app", "push"],
      );
    } catch (error) {
      this.deps.logger.warn("Could not tell the tenant about a quote", { quoteId: q.id, error });
    }
  }

  private view(quote: EnterpriseQuote): QuoteView {
    return { ...quote.snapshot(), expired: quote.expired(this.deps.clock.now()) };
  }
}
