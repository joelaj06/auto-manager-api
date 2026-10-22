import { Postings } from "../../../domain/finance/Postings.js";
import { Money, type MoneyJson } from "../../../domain/money/Money.js";
import type { ChecklistAnswers } from "../../../domain/assignments/VehicleAssignment.js";
import type {
  ScheduleBasis,
  TerminationReason,
  WorkPayAgreement,
} from "../../../domain/workpay/WorkPayAgreement.js";
import { outstanding } from "../../../domain/workpay/WorkPayCollections.js";
import {
  holidayPeriodsFor,
  holidayPlan,
  restructurePlan,
  settlementFigures,
  suggestedRefund,
  type ReschedulePlan,
} from "../../../domain/workpay/WorkPayLifecycle.js";
import { WorkPayRuleError, type WorkPayFrequency } from "../../../domain/workpay/WorkPayTerms.js";
import type { Principal } from "../../authorization/Principal.js";
import type { IClock } from "../../ports/IClock.js";
import type { IAuditTrail } from "../../ports/IAuditTrail.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import type { IVehicleRepository } from "../../../domain/repositories/IVehicleRepository.js";
import type {
  DowntimeRecord,
  IWorkPayAgreementRepository,
  IWorkPayLifecycleRecords,
  IWorkPaySchedule,
  IWorkPaySettingsStore,
  RescheduleRecord,
  SettlementQuoteRecord,
} from "../../ports/IWorkPayRecords.js";
import { TenantCalendar } from "../../services/TenantCalendar.js";
import type { VehicleAssignments } from "../assignments/VehicleAssignments.js";
import type { LedgerPosting } from "../finance/LedgerPosting.js";
import { recordUserAction } from "../reference/userAudit.js";
import type { VehicleRegistry } from "../vehicles/VehicleRegistry.js";
import type {
  BalanceView,
  CollectionView,
  Ledger,
  PaymentMoney,
  WorkPayCollections,
} from "./WorkPayCollections.js";

export type Handback = Readonly<{ odometer: number; checklist: ChecklistAnswers }>;

export type ClosingFigures = Readonly<{
  instalmentsOutstanding: MoneyJson;
  penaltiesOutstanding: MoneyJson;
  chargesOutstanding: MoneyJson;
  /** Instalments paid so far (the deposit not included). */
  instalmentsPaid: MoneyJson;
  deposit: MoneyJson;
  /** Early settlement today with the business's standard discount. */
  settlement: Readonly<{ discountPercent: string; discount: MoneyJson; payoff: MoneyJson }>;
  /** What the repossession refund policy suggests giving back. */
  suggestedRepossessionRefund: MoneyJson;
}>;

export type QuoteView = Omit<
  SettlementQuoteRecord,
  | "instalmentsMinor"
  | "penaltiesMinor"
  | "chargesMinor"
  | "discountMinor"
  | "payoffMinor"
  | "createdBy"
> &
  Readonly<{
    instalments: MoneyJson;
    penalties: MoneyJson;
    charges: MoneyJson;
    discount: MoneyJson;
    payoff: MoneyJson;
    status: "open" | "used" | "expired";
  }>;

export type RescheduleView = Omit<RescheduleRecord, "movedMinor"> & Readonly<{ moved: MoneyJson }>;

export type DowntimeView = DowntimeRecord &
  Readonly<{
    /** When it ended and the owner was responsible: the holiday it would justify. */
    suggestedHoliday: Readonly<{ from: string; periods: number }> | null;
  }>;

export type SettlementRequest = Readonly<{
  /** Text in the base currency; default 0 (owed) / the policy's suggestion is not applied. */
  owedByDriver?: string;
  refundToDriver?: string;
}>;

/**
 * The Work & Pay lifecycle (docs/08 §5): payment holidays and restructures of a running
 * agreement, early settlement (quote, then pay it off with the discount), termination (mutual,
 * death, write-off) and repossession with settlement figures, and vehicle downtime — the vehicle
 * off the road and back, suggesting a holiday when the owner is responsible.
 */
export class WorkPayLifecycle {
  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      agreements: IWorkPayAgreementRepository;
      schedule: IWorkPaySchedule;
      records: IWorkPayLifecycleRecords;
      settings: IWorkPaySettingsStore;
      collections: WorkPayCollections;
      assignments: VehicleAssignments;
      vehicles: IVehicleRepository;
      registry: VehicleRegistry;
      posting: LedgerPosting;
      calendar: TenantCalendar;
      auditTrail: IAuditTrail;
      requestContext: IRequestContext;
      clock: IClock;
    }>,
  ) {}

  // --- holidays and restructures ---

  /** Instalments due from `from` move `periods` periods later (the term gets longer). */
  async holiday(
    actor: Principal,
    id: string,
    request: Readonly<{ from: string; periods: number; reason: string }>,
  ): Promise<BalanceView> {
    return this.reschedule(actor, id, "holiday", request.reason, request, (agreement, ledger) => {
      const basis = agreement.scheduleBasis;
      return {
        plan: holidayPlan(ledger.instalments, { ...request, ...basis }),
        basis: null,
      };
    });
  }

  /** What is left of the instalments (arrears included) spread over a new schedule. */
  async restructure(
    actor: Principal,
    id: string,
    request: Readonly<{
      frequency?: WorkPayFrequency;
      periods: number;
      firstDueOn: string;
      daysOff?: readonly number[];
      reason: string;
    }>,
  ): Promise<BalanceView> {
    const today = await this.deps.unitOfWork.run(() => this.deps.calendar.today());
    return this.reschedule(
      actor,
      id,
      "restructure",
      request.reason,
      request,
      (agreement, ledger) => {
        const current = agreement.scheduleBasis;
        const basis: ScheduleBasis = {
          frequency: request.frequency ?? current.frequency,
          daysOff: request.daysOff ?? current.daysOff,
        };
        const plan = restructurePlan(ledger.instalments, {
          ...basis,
          periods: request.periods,
          firstDueOn: request.firstDueOn,
          roundToMinor: agreement.snapshot().terms.roundToMinor,
          today,
        });
        const changed =
          basis.frequency !== current.frequency || basis.daysOff.join() !== current.daysOff.join();
        return { plan, basis: changed ? basis : null };
      },
    );
  }

  async reschedules(actor: Principal, id: string): Promise<RescheduleView[]> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const agreement = await deps.collections.reach(actor, id, "workpay.view");
      const m = await this.money();
      return (await deps.records.reschedules(agreement.id)).map(({ movedMinor, ...r }) => ({
        ...r,
        moved: m(movedMinor),
      }));
    });
  }

  // --- early settlement ---

  async closingFigures(actor: Principal, id: string): Promise<ClosingFigures> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const agreement = await deps.collections.reach(actor, id, "workpay.view");
      const a = agreement.snapshot();
      const settings = await deps.settings.get();
      const ledger = await deps.collections.ledger(a.id);
      const figures = settlementFigures(
        ledger.instalments,
        ledger.penalties,
        ledger.charges,
        a.terms,
        settings.settlementDiscountPercent,
      );
      const paid = ledger.instalments.reduce((sum, i) => sum + i.paidMinor, 0);
      const m = await this.money();
      return {
        instalmentsOutstanding: m(figures.instalmentsMinor),
        penaltiesOutstanding: m(figures.penaltiesMinor),
        chargesOutstanding: m(figures.chargesMinor),
        instalmentsPaid: m(paid),
        deposit: m(a.depositPaidMinor),
        settlement: {
          discountPercent: settings.settlementDiscountPercent,
          discount: m(figures.discountMinor),
          payoff: m(figures.payoffMinor),
        },
        suggestedRepossessionRefund: m(suggestedRefund(paid, settings.repossessionRefundPercent)),
      };
    });
  }

  /**
   * A settlement quote: the payoff today, valid for the business's days. A discount other than
   * the standard one needs the restructure permission.
   */
  async quote(
    actor: Principal,
    id: string,
    request: Readonly<{ discountPercent?: string }>,
  ): Promise<QuoteView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const agreement = await deps.collections.reach(actor, id, "workpay.payment.record", true);
      agreement.assertReschedulable();
      const settings = await deps.settings.get();
      const discountPercent = request.discountPercent ?? settings.settlementDiscountPercent;
      if (discountPercent !== settings.settlementDiscountPercent)
        await deps.collections.reach(actor, id, "workpay.restructure");
      const today = await deps.calendar.today();
      await deps.collections.refreshLocked(agreement, today);
      const a = agreement.snapshot();
      const ledger = await deps.collections.ledger(a.id);
      const f = settlementFigures(
        ledger.instalments,
        ledger.penalties,
        ledger.charges,
        a.terms,
        discountPercent,
      );
      const quoteId = await deps.records.addQuote({
        agreementId: a.id,
        quotedOn: today,
        validUntil: TenantCalendar.addDays(today, settings.quoteValidDays),
        instalmentsMinor: f.instalmentsMinor,
        penaltiesMinor: f.penaltiesMinor,
        chargesMinor: f.chargesMinor,
        discountPercent,
        discountMinor: f.discountMinor,
        payoffMinor: f.payoffMinor,
        createdBy: actor.userId,
      });
      await this.audit(actor, "workpay.settlement_quoted", agreement, {
        quoteId,
        payoffMinor: f.payoffMinor,
        discountMinor: f.discountMinor,
      });
      return this.quoteView((await deps.records.quote(quoteId))!, today);
    });
  }

  /**
   * Pays the agreement off with a valid quote: the payment clears late fees, charges and
   * instalments, the quote's discount is waived on what is left, and the agreement completes.
   */
  async settleEarly(
    actor: Principal,
    id: string,
    quoteId: string,
    money: Omit<PaymentMoney, "amount"> & Readonly<{ amount: string }>,
  ): Promise<CollectionView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const agreement = await deps.collections.reach(actor, id, "workpay.payment.record", true);
      agreement.assertCollecting();
      const quote = await deps.records.quote(quoteId, true);
      if (quote === null || quote.agreementId !== agreement.id)
        throw new WorkPayRuleError("That quote is not for this agreement");
      const today = await deps.calendar.today();
      const status = this.quoteStatus(quote, today);
      if (status !== "open")
        throw new WorkPayRuleError(
          status === "used"
            ? "That quote was used already"
            : "That quote has expired: ask for a new one",
        );
      await deps.collections.refreshLocked(agreement, today);
      const base = await deps.posting.baseCurrency();
      const ledger = await deps.collections.ledger(agreement.id, true);
      const due = deps.collections.owed(ledger) - quote.discountMinor;
      const paid = Money.parse(money.amount, base).amountMinor;
      if (paid !== due)
        throw new WorkPayRuleError(
          `Settling today takes ${Money.ofMinor(due, base).toJSON().formatted} (the quote's discount applied)`,
        );
      const collected = await deps.collections.collect(actor, agreement, money, "Early settlement");
      await deps.records.markQuoteUsed(quote.id, collected.payment.id, deps.clock.now());
      await this.waiveDiscount(actor, agreement, quote, today);
      await this.audit(actor, "workpay.settled_early", agreement, {
        quoteId,
        paymentId: collected.payment.id,
        discountMinor: quote.discountMinor,
      });
      return { ...collected, balance: await deps.collections.balanceOf(agreement, today) };
    });
  }

  // --- closing early ---

  /** Ends a running agreement (mutual, death, accident write-off, other) with its settlement. */
  async terminate(
    actor: Principal,
    id: string,
    request: SettlementRequest &
      Readonly<{
        reason: TerminationReason;
        notes?: string | null;
        /** The vehicle came back: odometer and checklist, and where it goes now. */
        handback?: (Handback & Readonly<{ vehicleStatus?: "available" | "in_maintenance" }>) | null;
      }>,
  ): Promise<BalanceView> {
    return this.close(actor, id, "terminated", {
      reason: request.reason,
      notes: request.notes ?? null,
      settlement: request,
      handback: request.handback ?? null,
      vehicleStatus: request.handback?.vehicleStatus ?? "available",
    });
  }

  /** Takes the vehicle back from an agreement in arrears or defaulted. */
  async repossess(
    actor: Principal,
    id: string,
    request: SettlementRequest & Handback & Readonly<{ condition?: string | null }>,
  ): Promise<BalanceView> {
    return this.close(actor, id, "repossessed", {
      reason: "repossession",
      notes: request.condition ?? null,
      settlement: request,
      handback: { odometer: request.odometer, checklist: request.checklist },
      vehicleStatus: "repossessed",
    });
  }

  // --- vehicle downtime ---

  /**
   * The vehicle is off the road (workshop, accident …): it leaves work and pay while it is
   * away. `ownerFault` (default: the owner is responsible for maintenance) makes a payment
   * holiday suggested when it is back.
   */
  async startDowntime(
    actor: Principal,
    id: string,
    request: Readonly<{ reason: string; ownerFault?: boolean }>,
  ): Promise<DowntimeView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const agreement = await deps.collections.reach(actor, id, "workpay.restructure", true);
      agreement.assertReschedulable();
      const a = agreement.snapshot();
      if ((await deps.records.openDowntime(a.id)) !== null)
        throw new WorkPayRuleError("The vehicle is already off the road");
      const reason = request.reason.trim();
      if (reason.length < 3) throw new WorkPayRuleError("Say why the vehicle is off the road");
      const vehicle = (await deps.vehicles.lockById(a.vehicleId))!;
      if (vehicle.status === "on_workpay")
        await deps.registry.moveByModule(vehicle, "in_maintenance", {
          ref: { type: "workpay_agreement", id: a.id },
          reason,
          userId: actor.userId,
        });
      const downtimeId = await deps.records.addDowntime({
        agreementId: a.id,
        reason,
        ownerFault: request.ownerFault ?? a.maintenance !== "driver",
        startedOn: await deps.calendar.today(),
        startedBy: actor.userId,
      });
      await this.audit(actor, "workpay.downtime_started", agreement, { downtimeId, reason });
      return this.downtimeView(agreement, (await deps.records.openDowntime(a.id))!);
    });
  }

  /** The vehicle is back on the road and on work and pay. */
  async endDowntime(actor: Principal, id: string): Promise<DowntimeView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const agreement = await deps.collections.reach(actor, id, "workpay.restructure", true);
      const a = agreement.snapshot();
      const open = await deps.records.openDowntime(a.id);
      if (open === null) throw new WorkPayRuleError("The vehicle is not off the road");
      const vehicle = (await deps.vehicles.lockById(a.vehicleId))!;
      if (vehicle.status !== "on_workpay")
        await deps.registry.moveByModule(vehicle, "on_workpay", {
          ref: { type: "workpay_agreement", id: a.id },
          reason: "Back on the road",
          userId: actor.userId,
        });
      const today = await deps.calendar.today();
      await deps.records.endDowntime(open.id, today, actor.userId);
      await this.audit(actor, "workpay.downtime_ended", agreement, { downtimeId: open.id });
      return this.downtimeView(agreement, { ...open, endedOn: today, endedBy: actor.userId });
    });
  }

  async downtimes(actor: Principal, id: string): Promise<DowntimeView[]> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const agreement = await deps.collections.reach(actor, id, "workpay.view");
      return (await deps.records.downtimes(agreement.id)).map((d) =>
        this.downtimeView(agreement, d),
      );
    });
  }

  // --- helpers ---

  private async reschedule(
    actor: Principal,
    id: string,
    kind: "holiday" | "restructure",
    reason: string,
    params: Readonly<Record<string, unknown>>,
    plan: (
      agreement: WorkPayAgreement,
      ledger: Ledger,
    ) => Readonly<{ plan: ReschedulePlan; basis: ScheduleBasis | null }>,
  ): Promise<BalanceView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const agreement = await deps.collections.reach(actor, id, "workpay.restructure", true);
      agreement.assertReschedulable();
      const why = reason.trim();
      if (why.length < 3) throw new WorkPayRuleError("Say why the schedule changes");
      const a = agreement.snapshot();
      const today = await deps.calendar.today();
      const ledger = await deps.collections.ledger(a.id, true);
      const { plan: p, basis } = plan(agreement, ledger);
      const moved = new Map(p.moves.map((x) => [x.id, x.rescheduledMinor]));
      await deps.collections.saveStatuses(
        ledger.instalments,
        ledger.instalments.map((i) =>
          moved.has(i.id) ? { ...i, rescheduledMinor: i.rescheduledMinor + moved.get(i.id)! } : i,
        ),
        a.graceDays,
        today,
      );
      await deps.schedule.create(a.id, p.creates);
      agreement.rescheduled(basis, deps.clock.now());
      await deps.agreements.save(agreement);
      const movedMinor = p.moves.reduce((sum, x) => sum + x.rescheduledMinor, 0);
      const rescheduleId = await deps.records.addReschedule({
        agreementId: a.id,
        kind,
        reason: why,
        params: Object.fromEntries(Object.entries(params).filter(([k]) => k !== "reason")),
        movedMinor,
        movedNumbers: ledger.instalments.filter((i) => moved.has(i.id)).map((i) => i.number),
        createdNumbers: p.creates.map((c) => c.number),
        createdBy: actor.userId,
      });
      await deps.collections.refreshLocked(agreement, today);
      await this.audit(
        actor,
        `workpay.${kind === "holiday" ? "payment_holiday" : "restructured"}`,
        agreement,
        {
          rescheduleId,
          movedMinor,
          instalments: p.creates.length,
        },
      );
      return deps.collections.balanceOf(agreement, today);
    });
  }

  private async close(
    actor: Principal,
    id: string,
    kind: "terminated" | "repossessed",
    params: Readonly<{
      reason: TerminationReason | "repossession";
      notes: string | null;
      settlement: SettlementRequest;
      handback: Handback | null;
      vehicleStatus: "available" | "in_maintenance" | "repossessed";
    }>,
  ): Promise<BalanceView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const agreement = await deps.collections.reach(actor, id, "workpay.terminate", true);
      const today = await deps.calendar.today();
      await deps.collections.refreshLocked(agreement, today);
      const a = agreement.snapshot();
      const base = await deps.posting.baseCurrency();
      const minor = (amount: string | undefined) =>
        amount === undefined ? 0 : Money.parse(amount, base).amountMinor;
      const ledger = await deps.collections.ledger(a.id, true);
      const sum = (rows: readonly Parameters<typeof outstanding>[0][]) =>
        rows.reduce((total, x) => total + outstanding(x), 0);
      const figures = {
        instalmentsMinor: sum(ledger.instalments),
        penaltiesMinor: sum(ledger.penalties),
        chargesMinor: sum(ledger.charges),
      };
      agreement.close(
        kind,
        {
          reason: params.reason,
          on: today,
          notes: params.notes,
          outstandingMinor:
            figures.instalmentsMinor + figures.penaltiesMinor + figures.chargesMinor,
          owedMinor: minor(params.settlement.owedByDriver),
          refundMinor: minor(params.settlement.refundToDriver),
          by: actor.userId,
        },
        deps.clock.now(),
      );
      const vehicle = (await deps.vehicles.findById(a.vehicleId))!;
      if (params.handback === null && ["on_workpay", "in_maintenance"].includes(vehicle.status))
        throw new WorkPayRuleError(
          "Hand the vehicle back (odometer and checklist), or first report what happened to it (stolen, accident …)",
        );
      // Charges go back to the driver's ledger; late fees and instalments are written off.
      for (const c of ledger.charges)
        if (outstanding(c) > 0)
          await deps.schedule.saveCharge({ ...c, waivedMinor: c.waivedMinor + outstanding(c) });
      const closure = agreement.snapshot().closure!;
      const entry = Postings.workpayClosed(
        a,
        {
          kind,
          ...figures,
          owedMinor: closure.owedMinor,
          refundMinor: closure.refundMinor,
          date: today,
        },
        await deps.posting.accounts(),
      );
      if (entry !== null) await deps.posting.post(entry, actor.userId);
      const open = await deps.records.openDowntime(a.id);
      if (open !== null) await deps.records.endDowntime(open.id, today, actor.userId);
      await deps.agreements.save(agreement);
      await deps.assignments.endForWorkPay(actor, a.id, a.vehicleId, {
        reason:
          kind === "repossessed"
            ? `Work and pay agreement ${a.number}: vehicle repossessed`
            : `Work and pay agreement ${a.number} terminated (${params.reason.replaceAll("_", " ")})`,
        handback: params.handback,
        vehicleStatus: params.vehicleStatus,
      });
      await this.audit(actor, `workpay.agreement_${kind}`, agreement, {
        reason: params.reason,
        ...figures,
        owedMinor: closure.owedMinor,
        refundMinor: closure.refundMinor,
      });
      return deps.collections.balanceOf(agreement, today);
    });
  }

  /** Waives the quote's discount on what the settlement payment left of the instalments. */
  private async waiveDiscount(
    actor: Principal,
    agreement: WorkPayAgreement,
    quote: SettlementQuoteRecord,
    today: string,
  ): Promise<void> {
    const { deps } = this;
    const a = agreement.snapshot();
    const instalments = await deps.schedule.list(a.id, true);
    const left = instalments.filter((i) => outstanding(i) > 0);
    if (left.reduce((sum, i) => sum + outstanding(i), 0) !== quote.discountMinor)
      throw new WorkPayRuleError("The settlement does not match the quote: ask for a new one");
    for (const i of left)
      await deps.schedule.addWaiver({
        agreementId: a.id,
        instalmentId: i.id,
        penaltyId: null,
        amountMinor: outstanding(i),
        reason: "Early settlement discount",
        waivedBy: actor.userId,
        quoteId: quote.id,
      });
    await deps.collections.saveStatuses(
      instalments,
      instalments.map((i) => ({ ...i, waivedMinor: i.waivedMinor + outstanding(i) })),
      a.graceDays,
      today,
    );
    const entry = Postings.workpaySettlementDiscount(
      a,
      { quoteId: quote.id, amountMinor: quote.discountMinor, date: today },
      await deps.posting.accounts(),
    );
    if (entry !== null) await deps.posting.post(entry, actor.userId);
    await deps.collections.settle(agreement, today, actor.userId);
  }

  private quoteStatus(q: SettlementQuoteRecord, today: string): QuoteView["status"] {
    return q.paymentId !== null ? "used" : today > q.validUntil ? "expired" : "open";
  }

  private async quoteView(q: SettlementQuoteRecord, today: string): Promise<QuoteView> {
    const m = await this.money();
    const {
      instalmentsMinor,
      penaltiesMinor,
      chargesMinor,
      discountMinor,
      payoffMinor,
      createdBy: _createdBy,
      ...rest
    } = q;
    return {
      ...rest,
      instalments: m(instalmentsMinor),
      penalties: m(penaltiesMinor),
      charges: m(chargesMinor),
      discount: m(discountMinor),
      payoff: m(payoffMinor),
      status: this.quoteStatus(q, today),
    };
  }

  private downtimeView(agreement: WorkPayAgreement, d: DowntimeRecord): DowntimeView {
    const basis = agreement.scheduleBasis;
    const periods =
      d.endedOn === null || !d.ownerFault
        ? 0
        : holidayPeriodsFor(d.startedOn, d.endedOn, basis.frequency, basis.daysOff);
    return { ...d, suggestedHoliday: periods > 0 ? { from: d.startedOn, periods } : null };
  }

  private async money(): Promise<(minor: number) => MoneyJson> {
    const base = await this.deps.posting.baseCurrency();
    return (minor) => Money.ofMinor(minor, base).toJSON();
  }

  private async audit(
    actor: Principal,
    action: string,
    agreement: WorkPayAgreement,
    metadata: Readonly<Record<string, unknown>>,
  ) {
    const a = agreement.snapshot();
    await recordUserAction(this.deps, actor.userId, {
      action,
      entityType: "workpay_agreement",
      entityId: a.id,
      after: { number: a.number, status: a.status },
      metadata,
    });
  }
}
