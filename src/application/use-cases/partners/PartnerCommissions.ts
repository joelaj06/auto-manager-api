import { Money } from "../../../domain/money/Money.js";
import {
  commissionTerms,
  payoutRecord,
  type CommissionTerms,
  type CommissionTermsInput,
  type PayoutMethod,
} from "../../../domain/partners/Commissions.js";
import type { IBillingRepository } from "../../../domain/repositories/IBillingRepository.js";
import type {
  CommissionEntry,
  EntryFilter,
  IPartnerCommissionRepository,
  PartnerBalance,
  PayoutRecord,
  PayoutStatus,
} from "../../../domain/repositories/IPartnerCommissionRepository.js";
import type { IPartnerRepository } from "../../../domain/repositories/IPartnerRepository.js";
import type { PlatformPrincipal } from "../../authorization/PlatformPrincipal.js";
import { PermissionDeniedError } from "../../errors/AuthErrors.js";
import { ApplicationError } from "../../errors/ApplicationError.js";
import type { IClock } from "../../ports/IClock.js";
import type { IIdGenerator } from "../../ports/IIdGenerator.js";
import type { ILogger } from "../../ports/ILogger.js";
import type { IPdfRenderer, PdfBlock } from "../../ports/IPdfRenderer.js";
import type { IPlatformAuditTrail } from "../../ports/IPlatformAuditTrail.js";
import type { IPlatformUnitOfWork } from "../../ports/IPlatformUnitOfWork.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import { recordStaffAction } from "../console/consoleAudit.js";
import type { PdfFile } from "../documents/PrintedDocuments.js";
import { PartnerNotFoundError } from "./PartnerAdministration.js";
import type { PartnerNotifier } from "./PartnerNotifier.js";

export class PayoutNotFoundError extends ApplicationError {
  readonly code = "PAYOUT_NOT_FOUND";
  constructor() {
    super("Payout not found");
  }
}

export class AttributionNotFoundError extends ApplicationError {
  readonly code = "ATTRIBUTION_NOT_FOUND";
  constructor() {
    super("This tenant is not attributed to a reseller");
  }
}

/** A payout that cannot be made or changed as asked (409). */
export class PayoutRuleError extends ApplicationError {
  constructor(
    readonly code:
      | "NOTHING_PAYABLE"
      | "BELOW_MINIMUM_PAYOUT"
      | "PAYOUT_SECOND_APPROVER"
      | "PAYOUT_STATE"
      | "PROOF_NOT_FOUND",
    message: string,
  ) {
    super(message);
  }
}

export type PayoutInput = Readonly<{
  method: PayoutMethod;
  reference?: string | null;
  details?: Readonly<Record<string, string>>;
  proofFileIds?: readonly string[];
  notes?: string | null;
  paidAt: Date;
}>;

export type PayoutView = PayoutRecord & Readonly<{ entries?: readonly CommissionEntry[] }>;

/** A month of a reseller's commissions (docs/29 §5): earned, clawed back, adjusted and paid. */
export type CommissionStatement = Readonly<{
  partnerId: string;
  partnerName: string;
  period: string;
  currency: string;
  openingBalanceMinor: number;
  commissionsMinor: number;
  clawbacksMinor: number;
  adjustmentsMinor: number;
  payoutsMinor: number;
  closingBalanceMinor: number;
  entries: readonly CommissionEntry[];
  payouts: readonly PayoutRecord[];
}>;

const STATEMENT_LIMIT = 1_000;
const PERIOD = /^(\d{4})-(0[1-9]|1[0-2])$/;

/**
 * Reseller commissions for staff and for the reseller (docs/29 §4–§7): versioned terms per
 * reseller (Super Admin, step-up; never retroactive, optionally applied to existing tenants)
 * and per-tenant overrides; the "payable now" queue and liability; adjustments; payouts by any
 * method, always with their record — cash waits for a second approver, the reseller
 * acknowledges receipt — and reversals instead of edits; monthly statements (JSON, CSV, PDF).
 * Resellers only ever see their own partner's data, resolved from the signed-in user.
 */
export class PartnerCommissions {
  constructor(
    private readonly deps: Readonly<{
      commissions: IPartnerCommissionRepository;
      partners: IPartnerRepository;
      billing: IBillingRepository;
      /** The partner's documents (payout proofs are uploaded there). */
      documentIds: (partnerId: string) => Promise<readonly string[]>;
      notifier: PartnerNotifier;
      renderer: IPdfRenderer;
      unitOfWork: IPlatformUnitOfWork;
      audit: IPlatformAuditTrail;
      requestContext: IRequestContext;
      ids: IIdGenerator;
      clock: IClock;
      logger: ILogger;
    }>,
  ) {}

  // --- terms ---

  async terms(
    partnerId: string,
  ): Promise<Readonly<{ current: CommissionTerms | null; history: CommissionTerms[] }>> {
    await this.partner(partnerId);
    const history = await this.deps.commissions.termsHistory(partnerId);
    return { current: history[0] ?? null, history };
  }

  async setTerms(
    partnerId: string,
    input: CommissionTermsInput,
    options: Readonly<{ reason: string; applyToExistingTenants: boolean }>,
    actor: PlatformPrincipal,
  ): Promise<CommissionTerms> {
    const { deps } = this;
    const terms = commissionTerms(input);
    const saved = await deps.unitOfWork.run(async () => {
      await this.partner(partnerId);
      const before = await deps.commissions.latestTerms(partnerId);
      const added = await deps.commissions.addTerms(partnerId, terms, options.reason, actor.userId);
      const rebound = options.applyToExistingTenants
        ? await deps.commissions.rebindTenants(partnerId, added.id)
        : 0;
      await recordStaffAction(deps, actor, {
        action: "partner.commission_terms_changed",
        entityType: "partner",
        entityId: partnerId,
        reason: options.reason,
        before,
        after: { ...terms, version: added.version, tenantsRebound: rebound },
      });
      return added;
    });
    await this.tell(partnerId, {
      subject: "Your commission terms changed",
      body: `New terms (version ${saved.version}): Standard ${saved.standardPercent ?? "none"}${saved.standardPercent === null ? "" : " %"}, Enterprise ${saved.enterprisePercent ?? "none"}${saved.enterprisePercent === null ? "" : " %"}. Commission already earned is unchanged.`,
      key: `terms:${saved.id}`,
    });
    return saved;
  }

  /** A different percentage for one tenant (e.g. a large Enterprise deal); null removes it. */
  async setTenantOverride(
    tenantId: string,
    percent: string | null,
    reason: string,
    actor: PlatformPrincipal,
  ): Promise<void> {
    const { deps } = this;
    const value =
      percent === null
        ? null
        : commissionTerms({
            standardPercent: percent,
            enterprisePercent: null,
            holdDays: 0,
            minPayoutMinor: 0,
            capPerTenantMinor: null,
          }).standardPercent;
    await deps.unitOfWork.run(async () => {
      const before = await deps.commissions.attribution(tenantId, true);
      if (before === null) throw new AttributionNotFoundError();
      await deps.commissions.setOverride(tenantId, value, value === null ? null : reason);
      await recordStaffAction(deps, actor, {
        action: "partner.commission_override_set",
        entityType: "tenant",
        entityId: tenantId,
        targetTenantId: tenantId,
        reason,
        before: { overridePercent: before.overridePercent },
        after: { overridePercent: value },
      });
    });
  }

  // --- ledger ---

  async payable(): Promise<PartnerBalance[]> {
    await this.deps.commissions.releaseDue(this.deps.clock.now());
    return (await this.deps.commissions.balances()).filter(
      (b) => b.payableMinor > 0 || b.awaitingApprovalMinor > 0,
    );
  }

  /** Accrued, payable and awaiting approval: what Autoforce owes resellers. */
  async liability(): Promise<PartnerBalance[]> {
    await this.deps.commissions.releaseDue(this.deps.clock.now());
    return this.deps.commissions.balances();
  }

  async entries(filter: EntryFilter): Promise<CommissionEntry[]> {
    await this.deps.commissions.releaseDue(this.deps.clock.now());
    return this.deps.commissions.entries(filter);
  }

  async adjust(
    partnerId: string,
    input: Readonly<{ amountMinor: number; reason: string }>,
    actor: PlatformPrincipal,
  ): Promise<CommissionEntry> {
    const { deps } = this;
    if (!Number.isInteger(input.amountMinor) || input.amountMinor === 0)
      throw new PayoutRuleError("PAYOUT_STATE", "An adjustment is a whole amount, not zero");
    return deps.unitOfWork.run(async () => {
      await this.partner(partnerId);
      const entry = {
        id: deps.ids.next(),
        partnerId,
        tenantId: null,
        kind: "adjustment" as const,
        invoiceId: null,
        sourcePaymentId: null,
        sourceRefundId: null,
        commissionType: null,
        termsId: null,
        baseMinor: null,
        ratePercent: null,
        amountMinor: input.amountMinor,
        currency: await this.currency(),
        status: "payable" as const,
        releaseAt: null,
        reason: input.reason.trim(),
        createdBy: actor.userId,
      };
      await deps.commissions.addEntry(entry);
      await recordStaffAction(deps, actor, {
        action: "partner.commission_adjusted",
        entityType: "partner",
        entityId: partnerId,
        reason: input.reason,
        after: { entryId: entry.id, amountMinor: input.amountMinor },
      });
      return { ...entry, payoutId: null, createdAt: deps.clock.now() };
    });
  }

  // --- payouts ---

  /**
   * Records money paid to the reseller out of band, settling everything payable now. Cash waits
   * for a second approver (any amount, decision 56); other methods are paid on record.
   */
  async recordPayout(
    partnerId: string,
    input: PayoutInput,
    actor: PlatformPrincipal,
  ): Promise<PayoutView> {
    const { deps } = this;
    const proofFileIds = [...new Set(input.proofFileIds ?? [])];
    const details = input.details ?? {};
    payoutRecord(input.method, { reference: input.reference ?? null, details, proofFileIds });
    const now = deps.clock.now();
    if (input.paidAt > now)
      throw new PayoutRuleError("PAYOUT_STATE", "A payout cannot be in the future");
    const documents = new Set(await deps.documentIds(partnerId));
    if (proofFileIds.some((id) => !documents.has(id)))
      throw new PayoutRuleError(
        "PROOF_NOT_FOUND",
        "Upload the proof to the reseller's documents first",
      );
    const payout = await deps.unitOfWork.run(async () => {
      await this.partner(partnerId);
      await deps.commissions.releaseDue(now);
      const open = await deps.commissions.openPayable(partnerId);
      const total = open.reduce((sum, e) => sum + e.amountMinor, 0);
      if (open.length === 0 || total <= 0)
        throw new PayoutRuleError("NOTHING_PAYABLE", "Nothing is payable to this reseller now");
      const minimum = (await deps.commissions.latestTerms(partnerId))?.minPayoutMinor ?? 0;
      if (total < minimum)
        throw new PayoutRuleError(
          "BELOW_MINIMUM_PAYOUT",
          `${this.money(total, open[0]!.currency)} is below the reseller's minimum payout; it carries forward`,
        );
      const cash = input.method === "cash";
      const record: PayoutRecord = {
        id: deps.ids.next(),
        code: await deps.commissions.nextPayoutCode(now.getUTCFullYear()),
        partnerId,
        totalMinor: total,
        currency: open[0]!.currency,
        method: input.method,
        reference: input.reference?.trim() || null,
        details,
        proofFileIds,
        notes: input.notes?.trim() || null,
        status: cash ? "awaiting_approval" : "paid",
        paidAt: input.paidAt,
        recordedBy: actor.userId,
        recordedAt: now,
        approvedBy: null,
        approvedAt: null,
        acknowledgedBy: null,
        acknowledgedAt: null,
        reversedBy: null,
        reversedAt: null,
        reversalReason: null,
      };
      await deps.commissions.insertPayout(
        record,
        open.map((e) => e.id),
      );
      if (!cash) await deps.commissions.markEntriesPaid(record.id);
      await recordStaffAction(deps, actor, {
        action: "partner.payout_recorded",
        entityType: "partner_payout",
        entityId: record.id,
        after: {
          partnerId,
          code: record.code,
          totalMinor: total,
          method: input.method,
          status: record.status,
        },
      });
      return record;
    });
    if (payout.status === "paid") await this.tellPaid(payout);
    return this.payoutView(payout.id);
  }

  /** The second approver of a cash payout (never the one who recorded it). */
  async approvePayout(id: string, actor: PlatformPrincipal): Promise<PayoutView> {
    const { deps } = this;
    const payout = await deps.unitOfWork.run(async () => {
      const p = await this.lockedPayout(id);
      if (p.status !== "awaiting_approval")
        throw new PayoutRuleError(
          "PAYOUT_STATE",
          "Only a cash payout awaiting approval is approved",
        );
      if (p.recordedBy === actor.userId)
        throw new PayoutRuleError(
          "PAYOUT_SECOND_APPROVER",
          "Another staff member must approve a cash payout",
        );
      const approved: PayoutRecord = {
        ...p,
        status: "paid",
        approvedBy: actor.userId,
        approvedAt: deps.clock.now(),
      };
      await deps.commissions.savePayout(approved);
      await deps.commissions.markEntriesPaid(id);
      await recordStaffAction(deps, actor, {
        action: "partner.payout_approved",
        entityType: "partner_payout",
        entityId: id,
        after: { code: p.code, totalMinor: p.totalMinor },
      });
      return approved;
    });
    await this.tellPaid(payout);
    return this.payoutView(id);
  }

  /** Payouts are never edited: a reversal returns its entries to payable. */
  async reversePayout(id: string, reason: string, actor: PlatformPrincipal): Promise<PayoutView> {
    const { deps } = this;
    await deps.unitOfWork.run(async () => {
      const p = await this.lockedPayout(id);
      if (p.status === "reversed")
        throw new PayoutRuleError("PAYOUT_STATE", "This payout was already reversed");
      await deps.commissions.savePayout({
        ...p,
        status: "reversed",
        reversedBy: actor.userId,
        reversedAt: deps.clock.now(),
        reversalReason: reason.trim(),
      });
      await deps.commissions.releaseEntries(id);
      await recordStaffAction(deps, actor, {
        action: "partner.payout_reversed",
        entityType: "partner_payout",
        entityId: id,
        reason,
        before: { status: p.status, totalMinor: p.totalMinor },
      });
    });
    return this.payoutView(id);
  }

  payouts(
    filter: Readonly<{
      partnerId?: string;
      status?: PayoutStatus;
      unacknowledged?: boolean;
      limit: number;
    }>,
  ): Promise<PayoutRecord[]> {
    return this.deps.commissions.payouts(filter);
  }

  async payout(id: string, partnerId?: string): Promise<PayoutView> {
    const view = await this.payoutView(id);
    if (partnerId !== undefined && view.partnerId !== partnerId) throw new PayoutNotFoundError();
    return view;
  }

  // --- statements ---

  async statement(partnerId: string, period: string): Promise<CommissionStatement> {
    const { deps } = this;
    const match = PERIOD.exec(period);
    if (match === null) throw new PayoutRuleError("PAYOUT_STATE", "A period is YYYY-MM");
    const from = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1));
    const to = new Date(Date.UTC(Number(match[1]), Number(match[2]), 1));
    const partner = await this.partner(partnerId);
    await deps.commissions.releaseDue(deps.clock.now());
    const entries = await deps.commissions.entries({ partnerId, from, to, limit: STATEMENT_LIMIT });
    const payouts = (
      await deps.commissions.payouts({ partnerId, status: "paid", limit: STATEMENT_LIMIT })
    ).filter((p) => p.paidAt >= from && p.paidAt < to);
    const sum = (kind: CommissionEntry["kind"]) =>
      entries.filter((e) => e.kind === kind).reduce((s, e) => s + e.amountMinor, 0);
    const opening = await deps.commissions.balanceAt(partnerId, from);
    const payoutsMinor = payouts.reduce((s, p) => s + p.totalMinor, 0);
    const commissionsMinor = sum("commission");
    const clawbacksMinor = sum("clawback");
    const adjustmentsMinor = sum("adjustment");
    return {
      partnerId,
      partnerName: partner.snapshot().profile.name,
      period,
      currency: entries[0]?.currency ?? (await this.currency()),
      openingBalanceMinor: opening,
      commissionsMinor,
      clawbacksMinor,
      adjustmentsMinor,
      payoutsMinor,
      closingBalanceMinor:
        opening + commissionsMinor + clawbacksMinor + adjustmentsMinor - payoutsMinor,
      entries: [...entries].reverse(),
      payouts,
    };
  }

  async statementCsv(partnerId: string, period: string): Promise<string> {
    const s = await this.statement(partnerId, period);
    const rows = [
      [
        "date",
        "kind",
        "type",
        "tenant",
        "invoice",
        "base_minor",
        "rate_percent",
        "amount_minor",
        "status",
        "reference",
      ],
      ...s.entries.map((e) => [
        e.createdAt.toISOString(),
        e.kind,
        e.commissionType ?? "",
        e.tenantId ?? "",
        e.invoiceId ?? "",
        e.baseMinor === null ? "" : String(e.baseMinor),
        e.ratePercent ?? "",
        String(e.amountMinor),
        e.status,
        text(e.reason ?? ""),
      ]),
      ...s.payouts.map((p) => [
        p.paidAt.toISOString(),
        "payout",
        p.method,
        "",
        "",
        "",
        "",
        String(-p.totalMinor),
        p.status,
        text(`${p.code} ${p.reference ?? ""}`.trim()),
      ]),
    ];
    return rows.map((r) => r.map(csvCell).join(",")).join("\n") + "\n";
  }

  async statementPdf(partnerId: string, period: string): Promise<PdfFile> {
    const s = await this.statement(partnerId, period);
    const m = (minor: number) => this.money(minor, s.currency);
    const blocks: PdfBlock[] = [
      {
        type: "fields",
        rows: [
          { label: "Reseller", value: s.partnerName },
          { label: "Period", value: s.period },
          { label: "Opening balance", value: m(s.openingBalanceMinor) },
          { label: "Commissions", value: m(s.commissionsMinor) },
          { label: "Clawbacks", value: m(s.clawbacksMinor) },
          { label: "Adjustments", value: m(s.adjustmentsMinor) },
          { label: "Paid out", value: m(s.payoutsMinor) },
        ],
      },
      {
        type: "table",
        columns: [
          { header: "Date", width: 0.16 },
          { header: "Entry", width: 0.5 },
          { header: "Status", width: 0.14 },
          { header: "Amount", width: 0.2, align: "right" },
        ],
        rows: [
          ...s.entries.map((e) => [
            e.createdAt.toISOString().slice(0, 10),
            e.kind === "commission"
              ? `Commission (${e.commissionType ?? ""}, ${e.ratePercent ?? ""} % of ${m(e.baseMinor ?? 0)})`
              : e.kind === "clawback"
                ? "Clawback (client payment refunded)"
                : `Adjustment: ${e.reason ?? ""}`,
            e.status,
            m(e.amountMinor),
          ]),
          ...s.payouts.map((p) => [
            p.paidAt.toISOString().slice(0, 10),
            `Payout ${p.code} (${p.method}${p.reference === null ? "" : `, ${p.reference}`})`,
            p.status,
            m(-p.totalMinor),
          ]),
        ],
        total: ["Closing balance", "", "", m(s.closingBalanceMinor)],
      },
    ];
    const reference = `${s.period}-${partnerId.slice(0, 8)}`;
    return {
      filename: `commission-statement-${s.period}.pdf`,
      content: await this.deps.renderer.render({
        title: "Commission statement",
        reference,
        issuer: { name: "Autoforce Manager", lines: [], logo: null },
        blocks,
        footer: `Autoforce Manager · commission statement ${s.period}`,
        createdAt: this.deps.clock.now(),
      }),
    };
  }

  // --- the reseller's own console ---

  myEntries(user: PlatformPrincipal, filter: Omit<EntryFilter, "partnerId" | "tenantId">) {
    return this.entries({ ...filter, partnerId: partnerOf(user) });
  }

  async myBalance(user: PlatformPrincipal): Promise<PartnerBalance | null> {
    await this.deps.commissions.releaseDue(this.deps.clock.now());
    return (await this.deps.commissions.balances(partnerOf(user)))[0] ?? null;
  }

  myPayouts(user: PlatformPrincipal, limit: number): Promise<PayoutRecord[]> {
    return this.payouts({ partnerId: partnerOf(user), limit });
  }

  async myTerms(partnerId: string): Promise<CommissionTerms | null> {
    return this.deps.commissions.latestTerms(partnerId);
  }

  /** The reseller confirms it received the money (cash especially). */
  async acknowledge(user: PlatformPrincipal, id: string): Promise<PayoutView> {
    const { deps } = this;
    const partnerId = partnerOf(user);
    await deps.unitOfWork.run(async () => {
      const p = await this.lockedPayout(id);
      if (p.partnerId !== partnerId) throw new PayoutNotFoundError();
      if (p.status !== "paid")
        throw new PayoutRuleError("PAYOUT_STATE", "Only a paid payout can be acknowledged");
      if (p.acknowledgedAt !== null) return;
      await deps.commissions.savePayout({
        ...p,
        acknowledgedBy: user.userId,
        acknowledgedAt: deps.clock.now(),
      });
      await deps.audit.record({
        actorType: "partner",
        actorId: user.userId,
        action: "partner.payout_acknowledged",
        entityType: "partner_payout",
        entityId: id,
        requestId: deps.requestContext.current()?.requestId ?? null,
        ip: deps.requestContext.current()?.ip ?? null,
      });
    });
    return this.payout(id, partnerId);
  }

  myStatement(user: PlatformPrincipal, period: string) {
    return this.statement(partnerOf(user), period);
  }

  myStatementPdf(user: PlatformPrincipal, period: string) {
    return this.statementPdf(partnerOf(user), period);
  }

  myStatementCsv(user: PlatformPrincipal, period: string) {
    return this.statementCsv(partnerOf(user), period);
  }

  // --- helpers ---

  private async payoutView(id: string): Promise<PayoutView> {
    const payout = await this.deps.commissions.payout(id);
    if (payout === null) throw new PayoutNotFoundError();
    return { ...payout, entries: await this.deps.commissions.payoutEntries(id) };
  }

  private async lockedPayout(id: string): Promise<PayoutRecord> {
    const payout = await this.deps.commissions.payout(id, true);
    if (payout === null) throw new PayoutNotFoundError();
    return payout;
  }

  private async partner(partnerId: string) {
    const partner = await this.deps.partners.findById(partnerId);
    if (partner === null) throw new PartnerNotFoundError();
    return partner;
  }

  /** Commissions are in the currency we bill in (the standard plan's). */
  private async currency(): Promise<string> {
    return (await this.deps.billing.planByCode("standard"))?.currency ?? "GHS";
  }

  private money(minor: number, currency: string): string {
    return Money.ofMinor(minor, currency).formatAscii();
  }

  private tellPaid(p: PayoutRecord): Promise<void> {
    return this.tell(p.partnerId, {
      subject: "Commission paid",
      body: `We paid you ${this.money(p.totalMinor, p.currency)} (${p.method}${p.reference === null ? "" : `, reference ${p.reference}`}), payout ${p.code}.${p.method === "cash" ? " Please confirm you received it in your console." : ""}`,
      key: `payout:${p.id}`,
    });
  }

  private async tell(
    partnerId: string,
    message: Readonly<{ subject: string; body: string; key: string }>,
  ): Promise<void> {
    try {
      await this.deps.notifier.tell(partnerId, message);
    } catch (error) {
      this.deps.logger.warn("Could not tell a reseller", { partnerId, error });
    }
  }
}

/** The signed-in user's partner; partner routes only admit partner users. */
function partnerOf(user: PlatformPrincipal): string {
  if (user.partnerId === null) throw new PermissionDeniedError("platform.partner");
  return user.partnerId;
}

const csvCell = (value: string) =>
  /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;

/** Free text a spreadsheet must not run as a formula. */
const text = (value: string) => (/^[=+\-@]/.test(value) ? `'${value}` : value);
