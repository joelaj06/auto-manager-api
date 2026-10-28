import { Money } from "../money/Money.js";
import type { Expense } from "../expenses/Expense.js";
import type { Remittance } from "../remittances/Remittance.js";
import type { CashSession } from "./CashSession.js";
import type { Invoice } from "./Invoice.js";
import {
  credit,
  debit,
  journal,
  taxPayableKey,
  type JournalDraft,
  type JournalLine,
  type SystemAccountKey,
} from "./Journal.js";
import { METHOD_ACCOUNT, type Payment } from "./Payment.js";

/** What the Work & Pay postings need to know about an agreement. */
export type WorkPayRef = Readonly<{
  id: string;
  number: string;
  driverId: string;
  vehicleId: string;
  branchId: string;
}>;

/** Account ids by role, resolved by the caller. */
export type AccountResolver = (key: SystemAccountKey) => string;

/** Minor units of `currency` in the base currency at `fxRate` (base units per 1 unit). */
export function toBase(
  amountMinor: number,
  currency: string,
  fxRate: string,
  base: string,
): number {
  return currency === base
    ? amountMinor
    : Money.ofMinor(amountMinor, currency).convert(fxRate, base).amountMinor;
}

/**
 * The posting rules (docs/13 §2.4): what each financial event does to the ledger, in the base
 * currency. Pure functions, unit-tested; the result is checked to balance.
 */
export const Postings = {
  /**
   * Issuing an invoice: income and each tax component are credited, the receivable is debited
   * with their sum (so rounding of foreign amounts never unbalances the entry).
   */
  invoiceIssued(invoice: Invoice, accounts: AccountResolver, base: string): JournalDraft {
    const p = invoice.snapshot();
    const convert = (minor: number) => toBase(minor, p.currency, p.fxRate, base);
    const party = { type: p.partyType, id: p.partyId } as const;
    const credits: JournalLine[] = [];
    for (const line of p.lines) {
      credits.push(
        credit(convert(line.netMinor), {
          accountId: line.accountId,
          branchId: p.branchId,
          vehicleId: line.vehicleId ?? p.vehicleId,
        }),
      );
      for (const component of line.taxComponents)
        credits.push(
          credit(convert(component.amountMinor), {
            accountId: accounts(taxPayableKey(component.key)),
            branchId: p.branchId,
          }),
        );
    }
    const total = credits.reduce((sum, l) => sum + l.creditMinor, 0);
    return journal({
      date: p.issueDate,
      description: `Invoice ${p.number ?? ""} to ${p.partyName}`.trim(),
      source: { type: "invoice", id: p.id },
      reversesId: null,
      lines: [
        debit(total, { accountId: accounts("receivables"), branchId: p.branchId, party }),
        ...credits,
      ],
    });
  },

  /**
   * Money in lands in the party's credit (debit the money account); money out is debited to its
   * counter account (the party's credit for a refund, an expense …).
   */
  paymentRecorded(payment: Payment, accounts: AccountResolver): JournalDraft {
    const p = payment.snapshot();
    const money = accounts(METHOD_ACCOUNT[p.method]);
    const tags = { branchId: p.branchId, vehicleId: p.vehicleId, memo: p.reference };
    const party = p.party === null ? null : { type: p.party.type, id: p.party.id };
    const lines =
      p.direction === "in"
        ? [
            debit(p.amountBaseMinor, { accountId: money, ...tags }),
            credit(p.amountBaseMinor, { accountId: accounts("party_credit"), ...tags, party }),
          ]
        : [
            debit(p.amountBaseMinor, { accountId: p.counterAccountId!, ...tags, party }),
            credit(p.amountBaseMinor, { accountId: money, ...tags }),
          ];
    return journal({
      date: p.paidOn,
      description: `${p.direction === "in" ? "Receipt" : "Payment"} ${p.number} ${p.direction === "in" ? "from" : "to"} ${p.partyName}`,
      source: { type: "payment", id: p.id },
      reversesId: null,
      lines,
    });
  },

  /**
   * Allocating part of a payment to an invoice: the party's credit pays the receivable. Each
   * side at its own document's rate; the difference is an exchange gain or loss.
   */
  allocation(
    params: Readonly<{
      allocationId: string;
      payment: Payment;
      invoice: Invoice;
      amountMinor: number;
      date: string;
    }>,
    accounts: AccountResolver,
    base: string,
  ): JournalDraft {
    const pay = params.payment.snapshot();
    const inv = params.invoice.snapshot();
    const party = { type: inv.partyType, id: inv.partyId } as const;
    const fromCredit = toBase(params.amountMinor, pay.currency, pay.fxRate, base);
    const toReceivable = toBase(params.amountMinor, inv.currency, inv.fxRate, base);
    const difference = fromCredit - toReceivable;
    const fx = accounts("fx_difference");
    return journal({
      date: params.date,
      description: `Receipt ${pay.number} applied to invoice ${inv.number ?? ""}`.trim(),
      source: { type: "allocation", id: params.allocationId },
      reversesId: null,
      lines: [
        debit(fromCredit, { accountId: accounts("party_credit"), branchId: pay.branchId, party }),
        credit(toReceivable, { accountId: accounts("receivables"), branchId: inv.branchId, party }),
        difference > 0
          ? credit(difference, { accountId: fx, branchId: inv.branchId })
          : debit(-difference, { accountId: fx, branchId: inv.branchId }),
      ],
    });
  },

  /**
   * Approving an expense: each share is debited to the expense account (or to the driver who
   * bears the cost), recoverable input tax to its account, and the payee is owed the total.
   */
  expenseApproved(
    expense: Expense,
    expenseAccountId: string,
    recoverTax: boolean,
    accounts: AccountResolver,
    date: string,
  ): JournalDraft {
    const p = expense.snapshot();
    const driver =
      p.chargeToDriver && p.driverId !== null ? { type: "driver" as const, id: p.driverId } : null;
    const debits: JournalLine[] = [];
    for (const line of p.lines) {
      const cost = recoverTax ? line.netBaseMinor : line.amountBaseMinor;
      debits.push(
        driver === null
          ? debit(cost, {
              accountId: expenseAccountId,
              branchId: p.branchId,
              vehicleId: line.vehicleId,
            })
          : debit(cost, {
              accountId: accounts("driver_receivables"),
              branchId: p.branchId,
              vehicleId: line.vehicleId,
              party: driver,
            }),
      );
      if (recoverTax && line.taxBaseMinor > 0)
        debits.push(
          debit(line.taxBaseMinor, { accountId: accounts("input_tax"), branchId: p.branchId }),
        );
    }
    return journal({
      date,
      description: `Expense ${p.number ?? ""}: ${p.description}`.slice(0, 300),
      source: { type: "expense", id: p.id },
      reversesId: null,
      lines: [
        ...debits,
        credit(p.amountBaseMinor, {
          accountId: accounts("payables"),
          branchId: p.branchId,
          party: p.payee === null ? null : { type: p.payee.type, id: p.payee.id },
          memo: p.payeeName,
        }),
      ],
    });
  },

  /**
   * A foreign-currency bill paid at another rate than it was booked at (decision 411): what is
   * owed was cleared at the payment's base amount, so the rest of it (`difference` > 0, a gain)
   * or the excess (< 0, a loss) goes to exchange differences.
   */
  payableExchangeDifference(
    params: Readonly<{
      paymentId: string;
      difference: number;
      branchId: string;
      party: Readonly<{ type: "supplier" | "driver"; id: string }> | null;
      date: string;
      description: string;
    }>,
    accounts: AccountResolver,
  ): JournalDraft {
    const amount = Math.abs(params.difference);
    const owed = {
      accountId: accounts("payables"),
      branchId: params.branchId,
      party: params.party,
    };
    const fx = { accountId: accounts("fx_difference"), branchId: params.branchId };
    return journal({
      date: params.date,
      description: params.description.slice(0, 300),
      source: { type: "payable_fx", id: params.paymentId },
      reversesId: null,
      lines:
        params.difference > 0
          ? [debit(amount, owed), credit(amount, fx)]
          : [debit(amount, fx), credit(amount, owed)],
    });
  },

  /** A period's target falls due: the driver owes it, the business earned it. */
  remittanceAccrued(
    remittance: Remittance,
    amountMinor: number,
    accounts: AccountResolver,
    date: string,
  ): JournalDraft {
    const r = remittance.snapshot();
    const tags = { branchId: r.branchId, vehicleId: r.vehicleId };
    return journal({
      date,
      description: `Remittance due ${r.periodStart}${r.periodEnd === r.periodStart ? "" : ` – ${r.periodEnd}`}`,
      source: { type: "remittance", id: r.id },
      reversesId: null,
      lines: [
        debit(amountMinor, {
          accountId: accounts("driver_receivables"),
          ...tags,
          party: { type: "driver", id: r.driverId },
        }),
        credit(amountMinor, { accountId: accounts("remittance_income"), ...tags }),
      ],
    });
  },

  /**
   * Confirmed remittance money (already in the driver's credit through the payment): it settles
   * what the driver owes; for a variable period it is also the period's income.
   */
  remittanceSettled(
    remittance: Remittance,
    params: Readonly<{ paymentId: string; settled: number; income: number; date: string }>,
    accounts: AccountResolver,
  ): JournalDraft | null {
    const r = remittance.snapshot();
    if (params.settled === 0 && params.income === 0) return null;
    const driver = { type: "driver" as const, id: r.driverId };
    const tags = { branchId: r.branchId, vehicleId: r.vehicleId };
    return journal({
      date: params.date,
      description: `Remittance ${r.number ?? ""} received`.replace("  ", " "),
      source: { type: "remittance_payment", id: params.paymentId },
      reversesId: null,
      lines: [
        debit(params.income, { accountId: accounts("driver_receivables"), ...tags, party: driver }),
        credit(params.income, { accountId: accounts("remittance_income"), ...tags }),
        debit(params.settled, { accountId: accounts("party_credit"), ...tags, party: driver }),
        credit(params.settled, {
          accountId: accounts("driver_receivables"),
          ...tags,
          party: driver,
        }),
      ],
    });
  },

  /** Forgiving a shortfall: the income goes and the driver no longer owes it. */
  remittanceWaived(
    remittance: Remittance,
    amountMinor: number,
    accounts: AccountResolver,
    date: string,
  ): JournalDraft {
    const r = remittance.snapshot();
    const tags = { branchId: r.branchId, vehicleId: r.vehicleId };
    return journal({
      date,
      description: `Remittance shortfall waived (${r.periodStart})`,
      source: { type: "remittance_waiver", id: r.id },
      reversesId: null,
      lines: [
        debit(amountMinor, { accountId: accounts("remittance_income"), ...tags }),
        credit(amountMinor, {
          accountId: accounts("driver_receivables"),
          ...tags,
          party: { type: "driver", id: r.driverId },
        }),
      ],
    });
  },

  /** A charge to a driver (deduction: fine, damage …) or a credit (bonus). */
  driverAdjustment(
    params: Readonly<{
      id: string;
      driverId: string;
      kind: "deduction" | "bonus";
      amountMinor: number;
      accountId: string;
      branchId: string;
      vehicleId: string | null;
      date: string;
      memo: string;
    }>,
    accounts: AccountResolver,
  ): JournalDraft {
    const driver = {
      accountId: accounts("driver_receivables"),
      branchId: params.branchId,
      vehicleId: params.vehicleId,
      party: { type: "driver" as const, id: params.driverId },
      memo: params.memo,
    };
    const other = {
      accountId: params.accountId,
      branchId: params.branchId,
      vehicleId: params.vehicleId,
      memo: params.memo,
    };
    return journal({
      date: params.date,
      description: `Driver ${params.kind}: ${params.memo}`.slice(0, 300),
      source: { type: "driver_adjustment", id: params.id },
      reversesId: null,
      lines:
        params.kind === "deduction"
          ? [debit(params.amountMinor, driver), credit(params.amountMinor, other)]
          : [debit(params.amountMinor, other), credit(params.amountMinor, driver)],
    });
  },

  /** A till that does not match its count: the variance against cash over and short. */
  cashVariance(session: CashSession, accounts: AccountResolver, date: string): JournalDraft | null {
    const s = session.snapshot();
    const variance = s.varianceMinor ?? 0;
    if (variance === 0) return null;
    const cash = { accountId: accounts("cash"), branchId: s.branchId };
    const overShort = { accountId: accounts("cash_over_short"), branchId: s.branchId };
    return journal({
      date,
      description: `Cash ${variance > 0 ? "over" : "short"} at close of till`,
      source: { type: "cash_session", id: s.id },
      reversesId: null,
      lines:
        variance > 0
          ? [debit(variance, cash), credit(variance, overShort)]
          : [debit(-variance, overShort), credit(-variance, cash)],
    });
  },

  /**
   * A Work & Pay agreement starts (docs/08, docs/13): the price is owed as a receivable and is
   * unearned until paid; the deposit (held as the driver's credit) is applied and earned.
   */
  workpayStarted(
    a: WorkPayRef,
    amounts: Readonly<{ priceMinor: number; depositMinor: number; date: string }>,
    accounts: AccountResolver,
  ): JournalDraft {
    const driver = { type: "driver" as const, id: a.driverId };
    const tags = { branchId: a.branchId, vehicleId: a.vehicleId };
    return journal({
      date: amounts.date,
      description: `Work and pay agreement ${a.number} started`,
      source: { type: "workpay_agreement", id: a.id },
      reversesId: null,
      lines: [
        debit(amounts.priceMinor, {
          accountId: accounts("workpay_receivables"),
          ...tags,
          party: driver,
        }),
        credit(amounts.priceMinor, { accountId: accounts("workpay_unearned"), ...tags }),
        debit(amounts.depositMinor, {
          accountId: accounts("party_credit"),
          ...tags,
          party: driver,
        }),
        credit(amounts.depositMinor, {
          accountId: accounts("workpay_receivables"),
          ...tags,
          party: driver,
        }),
        debit(amounts.depositMinor, { accountId: accounts("workpay_unearned"), ...tags }),
        credit(amounts.depositMinor, { accountId: accounts("workpay_income"), ...tags }),
      ],
    });
  },

  /**
   * A payment applied to an agreement: the driver's credit settles the receivable; the part
   * that paid instalments is earned (penalties were earned when charged, charges are costs the
   * driver bears).
   */
  workpayCollected(
    a: WorkPayRef,
    params: Readonly<{
      paymentId: string;
      instalmentsMinor: number;
      penaltiesMinor: number;
      chargesMinor?: number;
      date: string;
    }>,
    accounts: AccountResolver,
  ): JournalDraft | null {
    const total = params.instalmentsMinor + params.penaltiesMinor + (params.chargesMinor ?? 0);
    if (total === 0) return null;
    const driver = { type: "driver" as const, id: a.driverId };
    const tags = { branchId: a.branchId, vehicleId: a.vehicleId };
    return journal({
      date: params.date,
      description: `Work and pay ${a.number}: payment applied`,
      source: { type: "workpay_payment", id: params.paymentId },
      reversesId: null,
      lines: [
        debit(total, { accountId: accounts("party_credit"), ...tags, party: driver }),
        credit(total, { accountId: accounts("workpay_receivables"), ...tags, party: driver }),
        debit(params.instalmentsMinor, { accountId: accounts("workpay_unearned"), ...tags }),
        credit(params.instalmentsMinor, { accountId: accounts("workpay_income"), ...tags }),
      ],
    });
  },

  /** A late-payment fee charged to the driver. */
  workpayPenaltyCharged(
    a: WorkPayRef,
    params: Readonly<{ penaltyId: string; amountMinor: number; date: string }>,
    accounts: AccountResolver,
  ): JournalDraft {
    const driver = { type: "driver" as const, id: a.driverId };
    const tags = { branchId: a.branchId, vehicleId: a.vehicleId };
    return journal({
      date: params.date,
      description: `Work and pay ${a.number}: late-payment fee`,
      source: { type: "workpay_penalty", id: params.penaltyId },
      reversesId: null,
      lines: [
        debit(params.amountMinor, {
          accountId: accounts("workpay_receivables"),
          ...tags,
          party: driver,
        }),
        credit(params.amountMinor, { accountId: accounts("workpay_penalties"), ...tags }),
      ],
    });
  },

  /** A forgiven instalment (never earned) or late-payment fee (taken back). */
  workpayWaived(
    a: WorkPayRef,
    params: Readonly<{
      waiverId: string;
      kind: "instalment" | "penalty";
      amountMinor: number;
      date: string;
    }>,
    accounts: AccountResolver,
  ): JournalDraft {
    const driver = { type: "driver" as const, id: a.driverId };
    const tags = { branchId: a.branchId, vehicleId: a.vehicleId };
    return journal({
      date: params.date,
      description: `Work and pay ${a.number}: ${params.kind === "penalty" ? "late-payment fee" : "instalment"} waived`,
      source: { type: "workpay_waiver", id: params.waiverId },
      reversesId: null,
      lines: [
        debit(params.amountMinor, {
          accountId: accounts(params.kind === "penalty" ? "workpay_penalties" : "workpay_unearned"),
          ...tags,
        }),
        credit(params.amountMinor, {
          accountId: accounts("workpay_receivables"),
          ...tags,
          party: driver,
        }),
      ],
    });
  },

  /**
   * A cost the driver bears (an approved expense charged to them) moves from their ledger into
   * the agreement, to be paid with the instalments — or back out when it is cancelled.
   */
  workpayCharge(
    a: WorkPayRef,
    params: Readonly<{
      chargeId: string;
      direction: "added" | "cancelled";
      amountMinor: number;
      description: string;
      date: string;
    }>,
    accounts: AccountResolver,
  ): JournalDraft {
    const driver = { type: "driver" as const, id: a.driverId };
    const tags = { branchId: a.branchId, vehicleId: a.vehicleId };
    const into = params.direction === "added";
    return journal({
      date: params.date,
      description: `Work and pay ${a.number}: ${params.description} ${into ? "charged" : "cancelled"}`,
      source: {
        type: into ? "workpay_charge" : "workpay_charge_cancel",
        id: params.chargeId,
      },
      reversesId: null,
      lines: [
        debit(params.amountMinor, {
          accountId: accounts(into ? "workpay_receivables" : "driver_receivables"),
          ...tags,
          party: driver,
        }),
        credit(params.amountMinor, {
          accountId: accounts(into ? "driver_receivables" : "workpay_receivables"),
          ...tags,
          party: driver,
        }),
      ],
    });
  },

  /** The discount of an early settlement: instalments never earned. */
  workpaySettlementDiscount(
    a: WorkPayRef,
    params: Readonly<{ quoteId: string; amountMinor: number; date: string }>,
    accounts: AccountResolver,
  ): JournalDraft | null {
    if (params.amountMinor === 0) return null;
    const driver = { type: "driver" as const, id: a.driverId };
    const tags = { branchId: a.branchId, vehicleId: a.vehicleId };
    return journal({
      date: params.date,
      description: `Work and pay ${a.number}: early settlement discount`,
      source: { type: "workpay_settlement", id: params.quoteId },
      reversesId: null,
      lines: [
        debit(params.amountMinor, { accountId: accounts("workpay_unearned"), ...tags }),
        credit(params.amountMinor, {
          accountId: accounts("workpay_receivables"),
          ...tags,
          party: driver,
        }),
      ],
    });
  },

  /**
   * An agreement closed early (terminated or repossessed): instalments never earned and late
   * fees taken back come off the receivable, charges go back to the driver's ledger; an agreed
   * amount the driver still owes is earned and on their ledger, a refund is owed to them.
   */
  workpayClosed(
    a: WorkPayRef,
    params: Readonly<{
      kind: "terminated" | "repossessed";
      instalmentsMinor: number;
      penaltiesMinor: number;
      chargesMinor: number;
      owedMinor: number;
      refundMinor: number;
      date: string;
    }>,
    accounts: AccountResolver,
  ): JournalDraft | null {
    const driver = { type: "driver" as const, id: a.driverId };
    const tags = { branchId: a.branchId, vehicleId: a.vehicleId };
    const receivable = { accountId: accounts("workpay_receivables"), ...tags, party: driver };
    const driverLedger = { accountId: accounts("driver_receivables"), ...tags, party: driver };
    const lines = [
      debit(params.instalmentsMinor, { accountId: accounts("workpay_unearned"), ...tags }),
      credit(params.instalmentsMinor, receivable),
      debit(params.penaltiesMinor, { accountId: accounts("workpay_penalties"), ...tags }),
      credit(params.penaltiesMinor, receivable),
      debit(params.chargesMinor, driverLedger),
      credit(params.chargesMinor, receivable),
      debit(params.owedMinor, driverLedger),
      credit(params.owedMinor, { accountId: accounts("workpay_income"), ...tags }),
      debit(params.refundMinor, { accountId: accounts("workpay_income"), ...tags }),
      credit(params.refundMinor, { accountId: accounts("party_credit"), ...tags, party: driver }),
    ];
    if (lines.every((l) => l.debitMinor + l.creditMinor === 0)) return null;
    return journal({
      date: params.date,
      description: `Work and pay ${a.number} ${params.kind}`,
      source: { type: "workpay_closure", id: a.id },
      reversesId: null,
      lines,
    });
  },
};
