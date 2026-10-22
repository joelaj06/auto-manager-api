import { Postings } from "../../../domain/finance/Postings.js";
import { Money, type MoneyJson } from "../../../domain/money/Money.js";
import type { WorkPayAgreement } from "../../../domain/workpay/WorkPayAgreement.js";
import {
  allocate,
  instalmentStatus,
  outstanding,
  penaltiesToCharge,
  position,
  type Allocation,
  type AgreementPosition,
  type ChargeState,
  type InstalmentState,
  type PenaltyState,
} from "../../../domain/workpay/WorkPayCollections.js";
import { WorkPayRuleError } from "../../../domain/workpay/WorkPayTerms.js";
import type { PermissionKey } from "../../authorization/permissionCatalog.js";
import type { Principal } from "../../authorization/Principal.js";
import { ApplicationError } from "../../errors/ApplicationError.js";
import type { IAuditTrail } from "../../ports/IAuditTrail.js";
import type { IClock } from "../../ports/IClock.js";
import type { IPaymentPurpose, IPaymentReversalListener } from "../../ports/IFinanceRecords.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import type {
  AllocationRecord,
  IWorkPayAgreementRepository,
  IWorkPayLifecycleRecords,
  IWorkPaySchedule,
  IWorkPaySettingsStore,
} from "../../ports/IWorkPayRecords.js";
import type { BranchScope } from "../../services/BranchScope.js";
import type { TenantCalendar } from "../../services/TenantCalendar.js";
import type { LedgerPosting } from "../finance/LedgerPosting.js";
import type { PaymentRecording, PaymentView } from "../finance/PaymentRecording.js";
import { recordUserAction } from "../reference/userAudit.js";
import { AgreementNotFoundError } from "./WorkPayAgreements.js";
import type { WorkPayNotifications } from "./WorkPayNotifications.js";

export class InstalmentNotFoundError extends ApplicationError {
  readonly code = "WORKPAY_INSTALMENT_NOT_FOUND";
  constructor() {
    super("Instalment not found");
  }
}

export class PenaltyNotFoundError extends ApplicationError {
  readonly code = "WORKPAY_PENALTY_NOT_FOUND";
  constructor() {
    super("Late fee not found");
  }
}

export type PaymentMoney = Readonly<{
  amount: string;
  method: "cash" | "momo" | "bank_transfer" | "cheque" | "card";
  momoNetwork?: "mtn" | "telecel" | "at" | null;
  reference?: string | null;
  paidOn?: string;
}>;

export type BalanceView = Readonly<{
  agreementId: string;
  number: string;
  status: string;
  outstanding: MoneyJson;
  overdue: MoneyJson;
  overdueCount: number;
  penaltiesOutstanding: MoneyJson;
  /** Costs the driver bears added to the agreement, still to pay. */
  chargesOutstanding: MoneyJson;
  /** What the driver must pay now to be up to date: overdue instalments, late fees, charges. */
  dueNow: MoneyJson;
  arrearsSince: string | null;
  daysInArrears: number;
  nextDue: Readonly<{ number: number; dueOn: string; outstanding: MoneyJson }> | null;
  penalties: readonly Readonly<{
    id: string;
    instalmentNumber: number;
    chargedOn: string;
    amount: MoneyJson;
    paid: MoneyJson;
    waived: MoneyJson;
  }>[];
  charges: readonly Readonly<{
    id: string;
    description: string;
    chargedOn: string;
    amount: MoneyJson;
    paid: MoneyJson;
    cancelled: MoneyJson;
  }>[];
}>;

export type AllocationView = Readonly<{
  kind: "instalment" | "penalty" | "charge";
  /** The instalment paid, or the one the late fee was for (null for a charge). */
  instalmentNumber: number | null;
  description?: string;
  amount: MoneyJson;
}>;

export type CollectionView = Readonly<{
  payment: PaymentView;
  allocations: readonly AllocationView[];
  balance: BalanceView;
}>;

export type AgreementPaymentView = Readonly<{
  paymentId: string;
  paidAt: Date;
  reversed: boolean;
  amount: MoneyJson;
  allocations: readonly AllocationView[];
}>;

/** What follows an agreement being paid in full (inside its unit of work). */
export type AgreementCompletion = Readonly<{
  agreementCompleted(agreement: WorkPayAgreement, userId: string | null): Promise<void>;
  /** May refuse (the vehicle was transferred already). */
  agreementReopened(agreement: WorkPayAgreement, userId: string | null): Promise<void>;
}>;

/** What is owed on an agreement, row by row (locked when asked). */
export type Ledger = Readonly<{
  instalments: InstalmentState[];
  penalties: PenaltyState[];
  charges: ChargeState[];
}>;

const DAY_MS = 86_400_000;
const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

/**
 * Collecting on Work & Pay agreements (docs/08 §3–5): instalment payments split by the allocation
 * policy (late fees first, then costs charged to the agreement, then the oldest instalments, the
 * rest paid in advance), late fees charged by the agreement's rule after the grace days,
 * waivers, and the status the schedule gives — active, in arrears, defaulted or completed.
 * Reversing a payment through finance takes its allocations back (and an early settlement's
 * discount with it) and the agreement follows.
 *
 * Ledger: the price is a receivable against unearned income from the start; an instalment
 * collected moves the driver's payment off the receivable and earns that much; a late fee is
 * receivable and income when charged.
 */
export class WorkPayCollections implements IPaymentPurpose, IPaymentReversalListener {
  readonly sourceType = "workpay_payment";

  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      agreements: IWorkPayAgreementRepository;
      schedule: IWorkPaySchedule;
      lifecycle: IWorkPayLifecycleRecords;
      settings: IWorkPaySettingsStore;
      payments: PaymentRecording;
      posting: LedgerPosting;
      scope: BranchScope;
      calendar: TenantCalendar;
      auditTrail: IAuditTrail;
      requestContext: IRequestContext;
      clock: IClock;
      /** Told when an agreement becomes paid in full, or stops being (the transfer letter). */
      completion?: AgreementCompletion;
      notifications?: WorkPayNotifications;
    }>,
  ) {}

  /** An instalment payment from the driver: recorded through finance, then allocated. */
  async pay(actor: Principal, id: string, money: PaymentMoney): Promise<CollectionView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const agreement = await this.reach(actor, id, "workpay.payment.record", true);
      agreement.assertCollecting();
      const today = await deps.calendar.today();
      await this.refreshLocked(agreement, today);
      const base = await deps.posting.baseCurrency();
      const owed = this.owed(await this.ledger(agreement.id, true));
      const asked = Money.parse(money.amount, base).amountMinor;
      if (asked <= 0) throw new WorkPayRuleError("A payment must be above zero");
      if (asked > owed)
        throw new WorkPayRuleError(
          `The payment is more than the ${this.money(base)(owed).formatted} still owed`,
        );
      const collected = await this.collect(actor, agreement, money, "Instalment");
      return { ...collected, balance: await this.balanceOf(agreement, today) };
    });
  }

  /**
   * Records a payment from the driver and applies it (call inside the caller's unit of work,
   * agreement locked and refreshed).
   */
  async collect(
    actor: Principal,
    agreement: WorkPayAgreement,
    money: PaymentMoney,
    purpose: string,
    options: Readonly<{ notify?: boolean }> = {},
  ): Promise<Omit<CollectionView, "balance">> {
    const { deps } = this;
    const a = agreement.snapshot();
    const today = await deps.calendar.today();
    const ledger = await this.ledger(a.id, true);
    const payment = await deps.payments.record(actor, {
      direction: "in",
      method: money.method,
      partyType: "driver",
      partyId: a.driverId,
      branchId: a.branchId,
      vehicleId: a.vehicleId,
      amount: money.amount,
      ...(money.paidOn === undefined ? {} : { paidOn: money.paidOn }),
      reference: money.reference ?? null,
      momoNetwork: money.momoNetwork ?? null,
      notes: `${purpose}, work and pay agreement ${a.number}`,
      source: { type: this.sourceType, id: a.id },
    });
    const split = allocate(
      payment.amountBase.amountMinor,
      ledger.instalments,
      ledger.penalties,
      ledger.charges,
    );
    await this.apply(agreement, payment.id, split, ledger, today);
    const entry = Postings.workpayCollected(
      a,
      {
        paymentId: payment.id,
        instalmentsMinor: split.instalmentsMinor,
        penaltiesMinor: split.penaltiesMinor,
        chargesMinor: split.chargesMinor,
        date: payment.paidOn,
      },
      await deps.posting.accounts(),
    );
    if (entry !== null) await deps.posting.post(entry, actor.userId);
    // The receipt goes out before a paid-in-full message that settling may send.
    if (options.notify !== false && deps.notifications !== undefined) {
      const { position: after } = await this.positionOf(agreement, today);
      await deps.notifications.paymentReceived(agreement, {
        paymentId: payment.id,
        amountMinor: payment.amountBase.amountMinor,
        balanceMinor:
          after.outstandingMinor + after.penaltiesOutstandingMinor + after.chargesOutstandingMinor,
        nextDueOn: after.nextDue?.dueOn ?? null,
      });
      // Half the instalments paid with this payment.
      const total = ledger.instalments.reduce(
        (sum, i) => sum + i.amountMinor - i.rescheduledMinor,
        0,
      );
      const before = ledger.instalments.reduce((sum, i) => sum + i.paidMinor, 0);
      const now = before + split.instalmentsMinor;
      if (before * 2 < total && now * 2 >= total && now < total)
        await deps.notifications.milestone(agreement, "half_paid");
    }
    const after = await this.settle(agreement, today, actor.userId);
    await recordUserAction(deps, actor.userId, {
      action: "workpay.payment_recorded",
      entityType: "workpay_agreement",
      entityId: a.id,
      after: { status: agreement.snapshot().status, outstandingMinor: after.outstandingMinor },
      metadata: { paymentId: payment.id, amountMinor: payment.amountBase.amountMinor },
    });
    const m = this.money(await deps.posting.baseCurrency());
    return {
      payment,
      allocations: split.lines.map((l) =>
        this.allocationView(l.kind, l.id, l.amountMinor, ledger, m),
      ),
    };
  }

  /** Waives what is left of an instalment (or part of it), e.g. the vehicle was off the road. */
  async waiveInstalment(
    actor: Principal,
    id: string,
    number: number,
    request: Readonly<{ amount?: string; reason: string }>,
  ): Promise<BalanceView> {
    return this.waive(actor, id, request, (instalments) => {
      const i = instalments.find((x) => x.number === number);
      if (i === undefined) throw new InstalmentNotFoundError();
      return { kind: "instalment", target: i };
    });
  }

  async waivePenalty(
    actor: Principal,
    id: string,
    penaltyId: string,
    request: Readonly<{ amount?: string; reason: string }>,
  ): Promise<BalanceView> {
    return this.waive(actor, id, request, (_, penalties) => {
      const p = penalties.find((x) => x.id === penaltyId);
      if (p === undefined) throw new PenaltyNotFoundError();
      return { kind: "penalty", target: p };
    });
  }

  async balance(actor: Principal, id: string): Promise<BalanceView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const agreement = await this.reach(actor, id, "workpay.view");
      return this.balanceOf(agreement, await deps.calendar.today());
    });
  }

  /** A driver's balance on their own agreement (driver app). */
  async balanceOfOwn(driverId: string, id: string): Promise<BalanceView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      return this.balanceOf(await this.reachOwn(driverId, id), await deps.calendar.today());
    });
  }

  /** The payments made on an agreement with what each one paid, newest first. */
  async paymentsOf(actor: Principal, id: string): Promise<AgreementPaymentView[]> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const agreement = await this.reach(actor, id, "workpay.view");
      const m = this.money(await deps.posting.baseCurrency());
      const ledger = await this.ledger(agreement.id);
      const grouped = new Map<string, AllocationRecord[]>();
      for (const row of await deps.schedule.allocations(agreement.id))
        grouped.set(row.paymentId, [...(grouped.get(row.paymentId) ?? []), row]);
      return [...grouped.entries()].map(([paymentId, rows]) => ({
        paymentId,
        paidAt: rows.reduce((d, r) => (r.createdAt < d ? r.createdAt : d), rows[0]!.createdAt),
        reversed: rows.every((r) => r.releasedAt !== null),
        amount: m(rows.reduce((sum, r) => sum + r.amountMinor, 0)),
        allocations: rows.map((r) => {
          const [kind, target] = targetOf(r);
          return this.allocationView(kind, target, r.amountMinor, ledger, m);
        }),
      }));
    });
  }

  /**
   * The daily arrears pass for one agreement: statuses as of `today`, late fees for overdue
   * instalments (missed days caught up), and the agreement's status.
   */
  async refresh(agreementId: string, today: string): Promise<void> {
    const { deps } = this;
    await deps.unitOfWork.run(async () => {
      const agreement = await deps.agreements.lockById(agreementId);
      if (agreement === null || !agreement.isRunning) return;
      await this.refreshLocked(agreement, today);
    });
  }

  // --- finance hooks ---

  async describe(sourceId: string, paymentId: string) {
    const { deps } = this;
    const agreement = await deps.agreements.findById(sourceId);
    if (agreement === null) return null;
    const rows = (await deps.schedule.allocations(sourceId)).filter(
      (r) => r.paymentId === paymentId,
    );
    const instalments = await deps.schedule.list(sourceId);
    const numbers = [
      ...new Set(
        rows
          .filter((r) => r.instalmentId !== null)
          .map((r) => instalments.find((i) => i.id === r.instalmentId)!.number),
      ),
    ].sort((x, y) => x - y);
    const parts = [
      ...(numbers.length === 0
        ? []
        : [
            numbers.length === 1
              ? `instalment ${numbers[0]}`
              : `instalments ${numbers[0]}–${numbers[numbers.length - 1]}`,
          ]),
      ...(rows.some((r) => r.penaltyId !== null) ? ["late fees"] : []),
      ...(rows.some((r) => r.chargeId !== null) ? ["charges"] : []),
    ];
    const settled = (await deps.lifecycle.quoteForPayment(paymentId)) !== null;
    return {
      description: `Work and pay agreement ${agreement.snapshot().number}${
        settled ? " settled early" : ""
      }${parts.length === 0 ? "" : `: ${parts.join(" and ")}`}`,
      settledMinor: rows.reduce((sum, r) => sum + r.amountMinor, 0),
    };
  }

  /** A reversed payment: what it paid is owed again, the earned income reversed. */
  async paymentReversed(sourceId: string, paymentId: string): Promise<void> {
    const { deps } = this;
    const agreement = await deps.agreements.lockById(sourceId);
    if (agreement === null) return;
    const a = agreement.snapshot();
    const today = await deps.calendar.today();
    const ledger = await this.ledger(a.id, true);
    const now = deps.clock.now();
    const instalments = new Map(ledger.instalments.map((i) => [i.id, i]));
    for (const row of await deps.schedule.openAllocations(paymentId)) {
      await deps.schedule.releaseAllocation(row.id, now);
      if (row.instalmentId !== null) {
        const i = instalments.get(row.instalmentId)!;
        instalments.set(i.id, { ...i, paidMinor: i.paidMinor - row.amountMinor });
      } else if (row.penaltyId !== null) {
        const p = ledger.penalties.find((x) => x.id === row.penaltyId)!;
        await deps.schedule.savePenalty({ ...p, paidMinor: p.paidMinor - row.amountMinor });
      } else {
        const c = ledger.charges.find((x) => x.id === row.chargeId)!;
        await deps.schedule.saveCharge({ ...c, paidMinor: c.paidMinor - row.amountMinor });
      }
    }
    // An early settlement's discount goes with its payment.
    const quote = await deps.lifecycle.quoteForPayment(paymentId);
    if (quote !== null) {
      for (const w of await deps.schedule.reverseQuoteWaivers(quote.id, now)) {
        const i = instalments.get(w.instalmentId)!;
        instalments.set(i.id, { ...i, waivedMinor: i.waivedMinor - w.amountMinor });
      }
      await deps.posting.reverse(
        { type: "workpay_settlement", id: quote.id },
        today,
        `Early settlement reversed, work and pay agreement ${a.number}`,
        null,
      );
      await deps.lifecycle.markQuoteUsed(quote.id, null, null);
    }
    await this.saveStatuses(ledger.instalments, [...instalments.values()], a.graceDays, today);
    await deps.posting.reverse(
      { type: this.sourceType, id: paymentId },
      today,
      `Instalment payment reversed, work and pay agreement ${a.number}`,
      null,
    );
    await this.refreshLocked(agreement, today);
  }

  // --- building blocks for the lifecycle (inside the caller's unit of work) ---

  /** The agreement's instalments, late fees and charges. */
  async ledger(agreementId: string, lock = false): Promise<Ledger> {
    const { schedule } = this.deps;
    return {
      instalments: await schedule.list(agreementId, lock),
      penalties: await schedule.penalties(agreementId, lock),
      charges: await schedule.charges(agreementId, lock),
    };
  }

  /** Everything still owed: instalments, late fees and charges. */
  owed(ledger: Ledger): number {
    return [...ledger.instalments, ...ledger.penalties, ...ledger.charges].reduce(
      (sum, x) => sum + outstanding(x),
      0,
    );
  }

  /** Statuses, late fees and the agreement's status as of `today` (agreement locked). */
  async refreshLocked(agreement: WorkPayAgreement, today: string): Promise<void> {
    const { deps } = this;
    const a = agreement.snapshot();
    const instalments = await deps.schedule.list(a.id, true);
    await this.saveStatuses(instalments, instalments, a.graceDays, today);
    const existing = await deps.schedule.penalties(a.id, true);
    const charges = penaltiesToCharge(instalments, existing, a.penalty, today, a.graceDays);
    if (charges.length > 0) {
      const accounts = await deps.posting.accounts();
      for (const charge of charges) {
        const penaltyId = await deps.schedule.addPenalty({ agreementId: a.id, ...charge });
        if (penaltyId === null) continue;
        // Dated today: a fee caught up for an earlier day must not land in a locked period.
        await deps.posting.post(
          Postings.workpayPenaltyCharged(
            a,
            { penaltyId, amountMinor: charge.amountMinor, date: today },
            accounts,
          ),
          null,
        );
      }
    }
    await this.settle(agreement, today);
  }

  /** Saves the instalments that changed, with their status as of `today`. */
  async saveStatuses(
    before: readonly InstalmentState[],
    after: readonly InstalmentState[],
    graceDays: number,
    today: string,
  ): Promise<void> {
    const old = new Map(before.map((i) => [i.id, i]));
    for (const i of after) {
      const next = { ...i, status: instalmentStatus(i, today, graceDays) };
      const prev = old.get(i.id);
      if (
        prev === undefined ||
        prev.status !== next.status ||
        prev.paidMinor !== next.paidMinor ||
        prev.waivedMinor !== next.waivedMinor ||
        prev.rescheduledMinor !== next.rescheduledMinor
      )
        await this.deps.schedule.saveInstalment(next);
    }
  }

  /** The agreement follows its schedule (status, arrears); returns where it stands. */
  async settle(
    agreement: WorkPayAgreement,
    today: string,
    userId: string | null = null,
  ): Promise<AgreementPosition> {
    const { deps } = this;
    const { position: p } = await this.positionOf(agreement, today);
    const before = agreement.snapshot().status;
    if (before === "completed" && p.status !== "completed")
      await deps.completion?.agreementReopened(agreement, userId);
    const changed = agreement.settle(p, deps.clock.now());
    await deps.agreements.save(agreement);
    if (changed && agreement.status === "completed")
      await deps.completion?.agreementCompleted(agreement, userId);
    if (changed) {
      const a = agreement.snapshot();
      await deps.auditTrail.record({
        action: "workpay.status_changed",
        entityType: "workpay_agreement",
        entityId: a.id,
        actorType: "system",
        actorId: null,
        requestId: deps.requestContext.current()?.requestId ?? null,
        ip: null,
        before: { status: before },
        after: { status: a.status, arrearsSince: a.arrearsSince },
        metadata: { overdueCount: p.overdueCount, overdueMinor: p.overdueMinor },
      });
    }
    return p;
  }

  async balanceOf(agreement: WorkPayAgreement, today: string): Promise<BalanceView> {
    const a = agreement.snapshot();
    const { ledger, position: p } = await this.positionOf(agreement, today);
    const m = this.money(await this.deps.posting.baseCurrency());
    return {
      agreementId: a.id,
      number: a.number,
      status: a.status,
      outstanding: m(p.outstandingMinor),
      overdue: m(p.overdueMinor),
      overdueCount: p.overdueCount,
      penaltiesOutstanding: m(p.penaltiesOutstandingMinor),
      chargesOutstanding: m(p.chargesOutstandingMinor),
      dueNow: m(p.overdueMinor + p.penaltiesOutstandingMinor + p.chargesOutstandingMinor),
      arrearsSince: p.arrearsSince,
      daysInArrears: p.arrearsSince === null ? 0 : daysBetween(p.arrearsSince, today) + 1,
      nextDue:
        p.nextDue === null
          ? null
          : {
              number: p.nextDue.number,
              dueOn: p.nextDue.dueOn,
              outstanding: m(p.nextDue.outstandingMinor),
            },
      penalties: ledger.penalties.map((x) => ({
        id: x.id,
        instalmentNumber: ledger.instalments.find((i) => i.id === x.instalmentId)!.number,
        chargedOn: x.chargedOn,
        amount: m(x.amountMinor),
        paid: m(x.paidMinor),
        waived: m(x.waivedMinor),
      })),
      charges: ledger.charges.map((c) => ({
        id: c.id,
        description: c.description,
        chargedOn: c.chargedOn,
        amount: m(c.amountMinor),
        paid: m(c.paidMinor),
        cancelled: m(c.waivedMinor),
      })),
    };
  }

  /** The agreement within the caller's reach for `permission`. */
  async reach(
    actor: Principal,
    id: string,
    permission: PermissionKey,
    lock = false,
  ): Promise<WorkPayAgreement> {
    const { deps } = this;
    const agreement = lock
      ? await deps.agreements.lockById(id)
      : await deps.agreements.findById(id);
    if (agreement === null) throw new AgreementNotFoundError();
    await deps.scope.assertReaches(
      actor,
      permission,
      agreement.snapshot().branchId,
      () => new AgreementNotFoundError(),
    );
    return agreement;
  }

  /** The driver's own agreement (driver app); not found for anyone else's. */
  async reachOwn(driverId: string, id: string): Promise<WorkPayAgreement> {
    const agreement = await this.deps.agreements.findById(id);
    if (agreement === null || agreement.snapshot().driverId !== driverId)
      throw new AgreementNotFoundError();
    return agreement;
  }

  money(base: string) {
    return (minor: number) => Money.ofMinor(minor, base).toJSON();
  }

  // --- helpers ---

  /** Saves what a payment's split paid, row by row, and records its allocations. */
  private async apply(
    agreement: WorkPayAgreement,
    paymentId: string,
    split: Allocation,
    ledger: Ledger,
    today: string,
  ): Promise<void> {
    const { deps } = this;
    const instalments = new Map(ledger.instalments.map((i) => [i.id, i]));
    for (const line of split.lines) {
      await deps.schedule.addAllocation({
        agreementId: agreement.id,
        paymentId,
        instalmentId: line.kind === "instalment" ? line.id : null,
        penaltyId: line.kind === "penalty" ? line.id : null,
        chargeId: line.kind === "charge" ? line.id : null,
        amountMinor: line.amountMinor,
      });
      if (line.kind === "instalment") {
        const i = instalments.get(line.id)!;
        instalments.set(i.id, { ...i, paidMinor: i.paidMinor + line.amountMinor });
      } else if (line.kind === "penalty") {
        const p = ledger.penalties.find((x) => x.id === line.id)!;
        await deps.schedule.savePenalty({ ...p, paidMinor: p.paidMinor + line.amountMinor });
      } else {
        const c = ledger.charges.find((x) => x.id === line.id)!;
        await deps.schedule.saveCharge({ ...c, paidMinor: c.paidMinor + line.amountMinor });
      }
    }
    await this.saveStatuses(
      ledger.instalments,
      [...instalments.values()],
      agreement.snapshot().graceDays,
      today,
    );
  }

  private async waive(
    actor: Principal,
    id: string,
    request: Readonly<{ amount?: string; reason: string }>,
    pick: (
      instalments: readonly InstalmentState[],
      penalties: readonly PenaltyState[],
    ) =>
      | Readonly<{ kind: "instalment"; target: InstalmentState }>
      | Readonly<{ kind: "penalty"; target: PenaltyState }>,
  ): Promise<BalanceView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const agreement = await this.reach(actor, id, "workpay.penalty.waive", true);
      agreement.assertCollecting();
      const reason = request.reason.trim();
      if (reason.length < 3) throw new WorkPayRuleError("Say why it is waived");
      const a = agreement.snapshot();
      const today = await deps.calendar.today();
      const base = await deps.posting.baseCurrency();
      const instalments = await deps.schedule.list(a.id, true);
      const penalties = await deps.schedule.penalties(a.id, true);
      const picked = pick(instalments, penalties);
      const left = outstanding(picked.target);
      const amountMinor =
        request.amount === undefined ? left : Money.parse(request.amount, base).amountMinor;
      if (left === 0) throw new WorkPayRuleError("Nothing is left to waive on it");
      if (amountMinor <= 0 || amountMinor > left)
        throw new WorkPayRuleError(
          `Waive above zero and at most the ${this.money(base)(left).formatted} left`,
        );
      const waiverId = await deps.schedule.addWaiver({
        agreementId: a.id,
        instalmentId: picked.kind === "instalment" ? picked.target.id : null,
        penaltyId: picked.kind === "penalty" ? picked.target.id : null,
        amountMinor,
        reason,
        waivedBy: actor.userId,
      });
      if (picked.kind === "instalment") {
        const waived = { ...picked.target, waivedMinor: picked.target.waivedMinor + amountMinor };
        await this.saveStatuses(
          instalments,
          instalments.map((i) => (i.id === waived.id ? waived : i)),
          a.graceDays,
          today,
        );
      } else
        await deps.schedule.savePenalty({
          ...picked.target,
          waivedMinor: picked.target.waivedMinor + amountMinor,
        });
      await deps.posting.post(
        Postings.workpayWaived(
          a,
          { waiverId, kind: picked.kind, amountMinor, date: today },
          await deps.posting.accounts(),
        ),
        actor.userId,
      );
      await this.settle(agreement, today, actor.userId);
      await recordUserAction(deps, actor.userId, {
        action: picked.kind === "penalty" ? "workpay.penalty_waived" : "workpay.instalment_waived",
        entityType: "workpay_agreement",
        entityId: a.id,
        after: { status: agreement.snapshot().status },
        metadata: { waiverId, amountMinor, reason },
      });
      return this.balanceOf(agreement, today);
    });
  }

  private async positionOf(agreement: WorkPayAgreement, today: string) {
    const a = agreement.snapshot();
    const settings = await this.deps.settings.get();
    const ledger = await this.ledger(a.id);
    return {
      ledger,
      position: position(
        ledger.instalments,
        ledger.penalties,
        today,
        {
          graceDays: a.graceDays,
          defaultAfterOverdue: settings.defaultAfterOverdue,
          defaultAfterDays: settings.defaultAfterDays,
        },
        ledger.charges,
      ),
    };
  }

  private allocationView(
    kind: AllocationView["kind"],
    id: string,
    amountMinor: number,
    ledger: Ledger,
    m: (minor: number) => MoneyJson,
  ): AllocationView {
    if (kind === "charge")
      return {
        kind,
        instalmentNumber: null,
        description: ledger.charges.find((c) => c.id === id)!.description,
        amount: m(amountMinor),
      };
    const instalmentId =
      kind === "instalment" ? id : ledger.penalties.find((p) => p.id === id)!.instalmentId;
    return {
      kind,
      instalmentNumber: ledger.instalments.find((i) => i.id === instalmentId)!.number,
      amount: m(amountMinor),
    };
  }
}

const targetOf = (r: AllocationRecord): [AllocationView["kind"], string] =>
  r.instalmentId !== null
    ? ["instalment", r.instalmentId]
    : r.penaltyId !== null
      ? ["penalty", r.penaltyId]
      : ["charge", r.chargeId!];
