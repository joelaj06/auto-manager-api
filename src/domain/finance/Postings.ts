import { Money } from "../money/Money.js";
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
            debit(p.amountBaseMinor, {
              accountId: p.counterAccountId!,
              ...tags,
              party: p.counterAccountId === accounts("party_credit") ? party : null,
            }),
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
