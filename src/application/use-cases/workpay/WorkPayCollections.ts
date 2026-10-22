import { Postings } from "../../../domain/finance/Postings.js";
import { Money, type MoneyJson } from "../../../domain/money/Money.js";
import type { WorkPayAgreement } from "../../../domain/workpay/WorkPayAgreement.js";
import {
  allocate,
  instalmentStatus,
  outstanding,
  penaltiesToCharge,
  position,
  type AgreementPosition,
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
  IWorkPaySchedule,
  IWorkPaySettingsStore,
} from "../../ports/IWorkPayRecords.js";
import type { BranchScope } from "../../services/BranchScope.js";
import type { TenantCalendar } from "../../services/TenantCalendar.js";
import type { LedgerPosting } from "../finance/LedgerPosting.js";
import type { PaymentRecording, PaymentView } from "../finance/PaymentRecording.js";
import { recordUserAction } from "../reference/userAudit.js";
import { AgreementNotFoundError } from "./WorkPayAgreements.js";

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
  /** What the driver must pay now to be up to date: overdue instalments and late fees. */
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
}>;

export type CollectionView = Readonly<{
  payment: PaymentView;
  allocations: readonly Readonly<{
    kind: "instalment" | "penalty";
    instalmentNumber: number;
    amount: MoneyJson;
  }>[];
  balance: BalanceView;
}>;

export type AgreementPaymentView = Readonly<{
  paymentId: string;
  paidAt: Date;
  reversed: boolean;
  amount: MoneyJson;
  allocations: CollectionView["allocations"];
}>;

const DAY_MS = 86_400_000;
const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

/**
 * Collecting on Work & Pay agreements (docs/08 §3–5): instalment payments split by the allocation
 * policy (late fees first, then the oldest instalments, the rest paid in advance), late fees
 * charged by the agreement's rule after the grace days, waivers, and the status the schedule
 * gives — active, in arrears, defaulted or completed. Reversing a payment through finance takes
 * its allocations back and the agreement follows.
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
      settings: IWorkPaySettingsStore;
      payments: PaymentRecording;
      posting: LedgerPosting;
      scope: BranchScope;
      calendar: TenantCalendar;
      auditTrail: IAuditTrail;
      requestContext: IRequestContext;
      clock: IClock;
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
      const a = agreement.snapshot();
      const instalments = await deps.schedule.list(a.id, true);
      const penalties = await deps.schedule.penalties(a.id, true);
      const base = await deps.posting.baseCurrency();
      const owed =
        instalments.reduce((sum, i) => sum + outstanding(i), 0) +
        penalties.reduce((sum, p) => sum + outstanding(p), 0);
      const asked = Money.parse(money.amount, base).amountMinor;
      if (asked <= 0) throw new WorkPayRuleError("A payment must be above zero");
      if (asked > owed)
        throw new WorkPayRuleError(
          `The payment is more than the ${Money.ofMinor(owed, base).toJSON().formatted} still owed`,
        );

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
        notes: `Instalment, work and pay agreement ${a.number}`,
        source: { type: this.sourceType, id: a.id },
      });
      const split = allocate(payment.amountBase.amountMinor, instalments, penalties);
      const byId = new Map<string, InstalmentState>(instalments.map((i) => [i.id, i]));
      const penaltyById = new Map<string, PenaltyState>(penalties.map((p) => [p.id, p]));
      for (const line of split.lines) {
        await deps.schedule.addAllocation({
          agreementId: a.id,
          paymentId: payment.id,
          instalmentId: line.kind === "instalment" ? line.id : null,
          penaltyId: line.kind === "penalty" ? line.id : null,
          amountMinor: line.amountMinor,
        });
        if (line.kind === "instalment") {
          const i = byId.get(line.id)!;
          byId.set(i.id, { ...i, paidMinor: i.paidMinor + line.amountMinor });
        } else {
          const p = penaltyById.get(line.id)!;
          penaltyById.set(p.id, { ...p, paidMinor: p.paidMinor + line.amountMinor });
        }
      }
      for (const p of penaltyById.values())
        if (split.lines.some((l) => l.id === p.id)) await deps.schedule.savePenalty(p);
      await this.saveStatuses(instalments, [...byId.values()], a.graceDays, today);
      const entry = Postings.workpayCollected(
        a,
        {
          paymentId: payment.id,
          instalmentsMinor: split.instalmentsMinor,
          penaltiesMinor: split.penaltiesMinor,
          date: payment.paidOn,
        },
        await deps.posting.accounts(),
      );
      if (entry !== null) await deps.posting.post(entry, actor.userId);
      const after = await this.settle(agreement, today);
      await recordUserAction(deps, actor.userId, {
        action: "workpay.payment_recorded",
        entityType: "workpay_agreement",
        entityId: a.id,
        after: { status: agreement.snapshot().status, outstandingMinor: after.outstandingMinor },
        metadata: { paymentId: payment.id, amountMinor: payment.amountBase.amountMinor },
      });
      const m = this.money(base);
      return {
        payment,
        allocations: split.lines.map((l) => ({
          kind: l.kind,
          instalmentNumber: this.numberOf(l, instalments, penalties),
          amount: m(l.amountMinor),
        })),
        balance: await this.balanceOf(agreement, today),
      };
    });
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
      const agreement = await deps.agreements.findById(id);
      if (agreement === null || agreement.snapshot().driverId !== driverId)
        throw new AgreementNotFoundError();
      return this.balanceOf(agreement, await deps.calendar.today());
    });
  }

  /** The payments made on an agreement with what each one paid, newest first. */
  async paymentsOf(actor: Principal, id: string): Promise<AgreementPaymentView[]> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const agreement = await this.reach(actor, id, "workpay.view");
      const a = agreement.snapshot();
      const m = this.money(await deps.posting.baseCurrency());
      const instalments = await deps.schedule.list(a.id);
      const penalties = await deps.schedule.penalties(a.id);
      const grouped = new Map<string, AllocationRecord[]>();
      for (const row of await deps.schedule.allocations(a.id))
        grouped.set(row.paymentId, [...(grouped.get(row.paymentId) ?? []), row]);
      return [...grouped.entries()].map(([paymentId, rows]) => ({
        paymentId,
        paidAt: rows.reduce((d, r) => (r.createdAt < d ? r.createdAt : d), rows[0]!.createdAt),
        reversed: rows.every((r) => r.releasedAt !== null),
        amount: m(rows.reduce((sum, r) => sum + r.amountMinor, 0)),
        allocations: rows.map((r) => ({
          kind: r.instalmentId === null ? ("penalty" as const) : ("instalment" as const),
          instalmentNumber: this.numberOf(
            r.instalmentId === null
              ? { kind: "penalty", id: r.penaltyId! }
              : { kind: "instalment", id: r.instalmentId },
            instalments,
            penalties,
          ),
          amount: m(r.amountMinor),
        })),
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
    const fees = rows.some((r) => r.penaltyId !== null);
    const parts = [
      ...(numbers.length === 0
        ? []
        : [
            numbers.length === 1
              ? `instalment ${numbers[0]}`
              : `instalments ${numbers[0]}–${numbers[numbers.length - 1]}`,
          ]),
      ...(fees ? ["late fees"] : []),
    ];
    return {
      description: `Work and pay agreement ${agreement.snapshot().number}${
        parts.length === 0 ? "" : `: ${parts.join(" and ")}`
      }`,
      settledMinor: rows.reduce((sum, r) => sum + r.amountMinor, 0),
    };
  }

  /** A reversed instalment payment: what it paid is owed again, the earned income reversed. */
  async paymentReversed(sourceId: string, paymentId: string): Promise<void> {
    const { deps } = this;
    const agreement = await deps.agreements.lockById(sourceId);
    if (agreement === null) return;
    const a = agreement.snapshot();
    const today = await deps.calendar.today();
    const instalments = await deps.schedule.list(a.id, true);
    const penalties = await deps.schedule.penalties(a.id, true);
    const now = deps.clock.now();
    const byId = new Map(instalments.map((i) => [i.id, i]));
    for (const row of await deps.schedule.openAllocations(paymentId)) {
      await deps.schedule.releaseAllocation(row.id, now);
      if (row.instalmentId !== null) {
        const i = byId.get(row.instalmentId)!;
        byId.set(i.id, { ...i, paidMinor: i.paidMinor - row.amountMinor });
      } else {
        const p = penalties.find((x) => x.id === row.penaltyId)!;
        await deps.schedule.savePenalty({ ...p, paidMinor: p.paidMinor - row.amountMinor });
      }
    }
    await this.saveStatuses(instalments, [...byId.values()], a.graceDays, today);
    await deps.posting.reverse(
      { type: this.sourceType, id: paymentId },
      today,
      `Instalment payment reversed, work and pay agreement ${a.number}`,
      null,
    );
    await this.refreshLocked(agreement, today);
  }

  // --- helpers ---

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
      await this.settle(agreement, today);
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

  /** Statuses, late fees and the agreement's status as of `today` (agreement locked). */
  private async refreshLocked(agreement: WorkPayAgreement, today: string): Promise<void> {
    const { deps } = this;
    const a = agreement.snapshot();
    if (a.status === "completed") return;
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

  private async saveStatuses(
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
        prev.waivedMinor !== next.waivedMinor
      )
        await this.deps.schedule.saveInstalment(next);
    }
  }

  private async positionOf(agreement: WorkPayAgreement, today: string) {
    const { deps } = this;
    const a = agreement.snapshot();
    const settings = await deps.settings.get();
    const instalments = await deps.schedule.list(a.id);
    const penalties = await deps.schedule.penalties(a.id);
    return {
      instalments,
      penalties,
      position: position(instalments, penalties, today, {
        graceDays: a.graceDays,
        defaultAfterOverdue: settings.defaultAfterOverdue,
        defaultAfterDays: settings.defaultAfterDays,
      }),
    };
  }

  private async settle(agreement: WorkPayAgreement, today: string): Promise<AgreementPosition> {
    const { deps } = this;
    const { position: p } = await this.positionOf(agreement, today);
    const before = agreement.snapshot().status;
    const changed = agreement.settle(p, deps.clock.now());
    await deps.agreements.save(agreement);
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

  private async balanceOf(agreement: WorkPayAgreement, today: string): Promise<BalanceView> {
    const a = agreement.snapshot();
    const { instalments, penalties, position: p } = await this.positionOf(agreement, today);
    const m = this.money(await this.deps.posting.baseCurrency());
    return {
      agreementId: a.id,
      number: a.number,
      status: a.status,
      outstanding: m(p.outstandingMinor),
      overdue: m(p.overdueMinor),
      overdueCount: p.overdueCount,
      penaltiesOutstanding: m(p.penaltiesOutstandingMinor),
      dueNow: m(p.overdueMinor + p.penaltiesOutstandingMinor),
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
      penalties: penalties.map((x) => ({
        id: x.id,
        instalmentNumber: instalments.find((i) => i.id === x.instalmentId)!.number,
        chargedOn: x.chargedOn,
        amount: m(x.amountMinor),
        paid: m(x.paidMinor),
        waived: m(x.waivedMinor),
      })),
    };
  }

  private numberOf(
    line: Readonly<{ kind: "instalment" | "penalty"; id: string }>,
    instalments: readonly InstalmentState[],
    penalties: readonly PenaltyState[],
  ): number {
    const instalmentId =
      line.kind === "instalment" ? line.id : penalties.find((p) => p.id === line.id)!.instalmentId;
    return instalments.find((i) => i.id === instalmentId)!.number;
  }

  private money(base: string) {
    return (minor: number) => Money.ofMinor(minor, base).toJSON();
  }

  private async reach(
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
}
