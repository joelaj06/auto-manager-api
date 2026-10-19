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
      const cost = recoverTax ? line.netMinor : line.amountMinor;
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
      if (recoverTax && line.taxMinor > 0)
        debits.push(
          debit(line.taxMinor, { accountId: accounts("input_tax"), branchId: p.branchId }),
        );
    }
    return journal({
      date,
      description: `Expense ${p.number ?? ""}: ${p.description}`.slice(0, 300),
      source: { type: "expense", id: p.id },
      reversesId: null,
      lines: [
        ...debits,
        credit(p.amountMinor, {
          accountId: accounts("payables"),
          branchId: p.branchId,
          party: p.payee === null ? null : { type: p.payee.type, id: p.payee.id },
          memo: p.payeeName,
        }),
      ],
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
};
