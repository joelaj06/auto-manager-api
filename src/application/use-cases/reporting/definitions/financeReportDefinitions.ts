import {
  MAX_FILE_ROWS,
  type ParamValues,
  type ReportTable,
} from "../../../../domain/reporting/Report.js";
import type { Principal } from "../../../authorization/Principal.js";
import type { LedgerViews } from "../../finance/LedgerViews.js";
import { PERIOD_PARAMS, type ReportDefinition } from "../ReportDefinition.js";
import type { ReportContext } from "../ReportContext.js";
import { between, share, total, totalsRow, words } from "./cells.js";

/** The trial balance at a date (docs/14 §3 Finance): every account with its debits and credits. */
export class TrialBalanceReport implements ReportDefinition {
  readonly id = "trial_balance";
  readonly title = "Trial balance";
  readonly description = "Every ledger account with its debits, credits and balance at a date";
  readonly category = "finance" as const;
  readonly permission = "finance.ledger.view" as const;
  readonly params = [{ key: "asOf", label: "As of", type: "date", required: false }] as const;

  constructor(private readonly ledger: LedgerViews) {}

  async run(_actor: Principal, params: ParamValues): Promise<ReportTable> {
    const tb = await this.ledger.trialBalance(params.asOf ?? null);
    return {
      title: this.title,
      subtitle: `As of ${tb.asOf}`,
      currency: tb.totalDebit.currency,
      columns: [
        { key: "code", header: "Code", type: "text", width: 0.6 },
        { key: "name", header: "Account", type: "text", width: 2.4 },
        { key: "type", header: "Type", type: "text" },
        { key: "debit", header: "Debit", type: "money", width: 1.2 },
        { key: "credit", header: "Credit", type: "money", width: 1.2 },
        { key: "balance", header: "Balance", type: "money", width: 1.2 },
      ],
      rows: tb.accounts
        .filter((a) => a.debit.amountMinor !== 0 || a.credit.amountMinor !== 0)
        .map((a) => ({
          code: a.code,
          name: a.name,
          type: a.type,
          debit: a.debit.amountMinor,
          credit: a.credit.amountMinor,
          balance: a.balance.amountMinor,
        })),
      totals: {
        code: "Total",
        name: null,
        type: null,
        debit: tb.totalDebit.amountMinor,
        credit: tb.totalCredit.amountMinor,
        balance: null,
      },
      summary: [{ label: "Balanced", value: tb.balanced ? "Yes" : "No" }],
    };
  }
}

/** Every journal line of the period in date order (docs/14 §3). */
export class DayBookReport implements ReportDefinition {
  readonly id = "day_book";
  readonly title = "Day book";
  readonly description =
    "Every journal entry posted in the period with its lines: date, entry, description, account, branch, debit and credit";
  readonly category = "finance" as const;
  readonly permission = "finance.ledger.view" as const;
  readonly params = PERIOD_PARAMS;
  readonly landscape = true;

  constructor(private readonly context: ReportContext) {}

  run(actor: Principal, params: ParamValues): Promise<ReportTable> {
    return this.context.within(actor, this.permission, params, async (c) => {
      // One line more than a file holds, so an oversized day book is refused, not cut short.
      const lines = await c.queries.dayBook(
        c.filter,
        c.range.from,
        c.range.to,
        MAX_FILE_ROWS.csv + 1,
      );
      const debit = total(lines, (l) => l.debitMinor);
      const credit = total(lines, (l) => l.creditMinor);
      return {
        title: this.title,
        subtitle: between(c.range),
        currency: c.base,
        columns: [
          { key: "date", header: "Date", type: "date", width: 0.8 },
          { key: "entry", header: "Entry", type: "text" },
          { key: "description", header: "Description", type: "text", width: 2 },
          { key: "source", header: "Source", type: "text", width: 0.8 },
          { key: "account", header: "Account", type: "text", width: 1.6 },
          { key: "branch", header: "Branch", type: "text" },
          { key: "debit", header: "Debit", type: "money" },
          { key: "credit", header: "Credit", type: "money" },
        ],
        rows: lines.map((l) => ({
          date: l.date,
          entry: l.entryNumber,
          description: l.description,
          source: words(l.sourceType),
          account: `${l.accountCode} ${l.accountName}`,
          branch: l.branchName,
          debit: l.debitMinor === 0 ? null : l.debitMinor,
          credit: l.creditMinor === 0 ? null : l.creditMinor,
        })),
        totals: totalsRow(
          ["date", "entry", "description", "source", "account", "branch", "debit", "credit"],
          "Total",
          { debit, credit },
        ),
        summary: [
          { label: "Entries", value: String(new Set(lines.map((l) => l.entryNumber)).size) },
          { label: "Balanced", value: debit === credit ? "Yes" : "No" },
        ],
      };
    });
  }
}

const DIRECTIONS = ["in", "out"] as const;

/** Payments received (or made) in the period, one per line (docs/14 §3). */
export class PaymentsRegisterReport implements ReportDefinition {
  readonly id = "payments_register";
  readonly title = "Receipts and payments register";
  readonly description =
    "Each payment received or made in the period: date, number, party, method, reference, branch, amount and who recorded it; reversed ones shown and left out of the totals";
  readonly category = "finance" as const;
  readonly permission = "finance.payments.view" as const;
  readonly params = [
    ...PERIOD_PARAMS,
    { key: "direction", label: "Direction", type: "enum", required: false, options: DIRECTIONS },
  ] as const;
  readonly landscape = true;

  constructor(private readonly context: ReportContext) {}

  run(actor: Principal, params: ParamValues): Promise<ReportTable> {
    const { direction, ...period } = params;
    return this.context.within(actor, this.permission, period, async (c) => {
      const payments = await c.queries.payments(c.filter, {
        from: c.range.from,
        to: c.range.to,
        direction: (direction ?? "in") as "in" | "out",
      });
      const recorded = payments.filter((p) => p.status === "recorded");
      return {
        title: (direction ?? "in") === "in" ? "Receipts register" : "Payments register",
        subtitle: between(c.range),
        currency: c.base,
        columns: [
          { key: "date", header: "Date", type: "date", width: 0.8 },
          { key: "number", header: "Number", type: "text" },
          { key: "party", header: "Party", type: "text", width: 1.6 },
          { key: "method", header: "Method", type: "text", width: 0.8 },
          { key: "reference", header: "Reference", type: "text" },
          { key: "branch", header: "Branch", type: "text" },
          { key: "currency", header: "Currency", type: "text", width: 0.5 },
          { key: "amountBase", header: "Amount", type: "money" },
          { key: "status", header: "Status", type: "text", width: 0.7 },
          { key: "recordedBy", header: "Recorded by", type: "text" },
        ],
        rows: payments.map((p) => ({
          date: p.paidOn,
          number: p.number,
          party: p.partyName,
          method: words(p.method),
          reference: p.reference,
          branch: p.branchName,
          currency: p.currency,
          amountBase: p.amountBaseMinor,
          status: p.status,
          recordedBy: p.recordedBy,
        })),
        totals: totalsRow(
          [
            "date",
            "number",
            "party",
            "method",
            "reference",
            "branch",
            "currency",
            "amountBase",
            "status",
            "recordedBy",
          ],
          "Total",
          {
            number: `${recorded.length} payments`,
            amountBase: total(recorded, (p) => p.amountBaseMinor),
          },
        ),
        summary: [
          { label: "Recorded", value: c.formatted(total(recorded, (p) => p.amountBaseMinor)) },
          { label: "Reversed", value: String(payments.length - recorded.length) },
        ],
      };
    });
  }
}

/** Money in and out by payment method (docs/14 §3). */
export class PaymentsByMethodReport implements ReportDefinition {
  readonly id = "payments_by_method";
  readonly title = "Payments by method";
  readonly description =
    "Money received and paid in the period by method (cash, mobile money, bank, cheque, card), with counts and net";
  readonly category = "finance" as const;
  readonly permission = "finance.payments.view" as const;
  readonly params = PERIOD_PARAMS;

  constructor(private readonly context: ReportContext) {}

  run(actor: Principal, params: ParamValues): Promise<ReportTable> {
    return this.context.within(actor, this.permission, params, async (c) => {
      const days = await c.queries.cashDays(c.filter, c.range.from, c.range.to);
      const methods = new Map<
        string,
        { inCount: number; in: number; outCount: number; out: number }
      >();
      for (const d of days) {
        const m = methods.get(d.method) ?? { inCount: 0, in: 0, outCount: 0, out: 0 };
        if (d.direction === "in") {
          m.inCount += d.payments;
          m.in += d.amountMinor;
        } else {
          m.outCount += d.payments;
          m.out += d.amountMinor;
        }
        methods.set(d.method, m);
      }
      const rows = [...methods.entries()].map(([method, m]) => ({
        method: words(method),
        inCount: m.inCount,
        in: m.in,
        outCount: m.outCount,
        out: m.out,
        net: m.in - m.out,
      }));
      const cashIn = total(rows, (r) => r.in);
      const cashOut = total(rows, (r) => r.out);
      return {
        title: this.title,
        subtitle: between(c.range),
        currency: c.base,
        columns: [
          { key: "method", header: "Method", type: "text", width: 1.2 },
          { key: "inCount", header: "Received", type: "number", width: 0.6 },
          { key: "in", header: "In", type: "money" },
          { key: "outCount", header: "Paid", type: "number", width: 0.6 },
          { key: "out", header: "Out", type: "money" },
          { key: "net", header: "Net", type: "money" },
        ],
        rows,
        totals: {
          method: "Total",
          inCount: total(rows, (r) => r.inCount),
          in: cashIn,
          outCount: total(rows, (r) => r.outCount),
          out: cashOut,
          net: cashIn - cashOut,
        },
        summary: rows.map((r) => ({
          label: `${r.method} share of money in`,
          value: `${share(r.in, cashIn) ?? 0}%`,
        })),
      };
    });
  }
}

/** Closed cash sessions with what was expected in the drawer, counted and the variance (docs/14 §3). */
export class CashSessionVarianceReport implements ReportDefinition {
  readonly id = "cash_session_variance";
  readonly title = "Cash session variance";
  readonly description =
    "Cash sessions closed in the period: cashier, branch, opening float, cash in and out, expected, counted and the variance";
  readonly category = "finance" as const;
  readonly permission = "finance.cash_sessions.view" as const;
  readonly params = PERIOD_PARAMS;
  readonly landscape = true;

  constructor(private readonly context: ReportContext) {}

  run(actor: Principal, params: ParamValues): Promise<ReportTable> {
    return this.context.within(actor, this.permission, params, async (c) => {
      const sessions = await c.queries.cashSessions(c.filter, c.fromAt, c.untilAt);
      const sum = (pick: (s: (typeof sessions)[number]) => number) => total(sessions, pick);
      const expected = (s: (typeof sessions)[number]) =>
        s.openingMinor + s.cashInMinor - s.cashOutMinor;
      return {
        title: this.title,
        subtitle: between(c.range),
        currency: c.base,
        columns: [
          { key: "closedAt", header: "Closed", type: "text", width: 1.1 },
          { key: "cashier", header: "Cashier", type: "text", width: 1.3 },
          { key: "branch", header: "Branch", type: "text" },
          { key: "opening", header: "Opening float", type: "money" },
          { key: "in", header: "Cash in", type: "money" },
          { key: "out", header: "Cash out", type: "money" },
          { key: "expected", header: "Expected", type: "money" },
          { key: "counted", header: "Counted", type: "money" },
          { key: "variance", header: "Variance", type: "money" },
          { key: "notes", header: "Notes", type: "text", width: 1.4 },
        ],
        rows: sessions.map((s) => ({
          closedAt: c.timeOf(s.closedAt),
          cashier: s.cashierName,
          branch: s.branchName,
          opening: s.openingMinor,
          in: s.cashInMinor,
          out: s.cashOutMinor,
          expected: expected(s),
          counted: s.countedMinor,
          variance: s.varianceMinor,
          notes: s.notes,
        })),
        totals: {
          closedAt: "Total",
          cashier: `${sessions.length} sessions`,
          branch: null,
          opening: sum((s) => s.openingMinor),
          in: sum((s) => s.cashInMinor),
          out: sum((s) => s.cashOutMinor),
          expected: sum(expected),
          counted: sum((s) => s.countedMinor),
          variance: sum((s) => s.varianceMinor),
          notes: null,
        },
        summary: [
          {
            label: "Sessions short",
            value: String(sessions.filter((s) => s.varianceMinor < 0).length),
          },
          {
            label: "Sessions over",
            value: String(sessions.filter((s) => s.varianceMinor > 0).length),
          },
          { label: "Net variance", value: c.formatted(sum((s) => s.varianceMinor)) },
        ],
      };
    });
  }
}

/** Output tax charged, input tax recovered and withholding tax kept back, from the ledger (docs/14 §3). */
export class TaxReport implements ReportDefinition {
  readonly id = "tax_report";
  readonly title = "Tax report";
  readonly description =
    "Per tax account for the period: VAT, NHIL, GETFund and other taxes charged on sales, input tax recovered on purchases and withholding tax kept back, with what is payable";
  readonly category = "finance" as const;
  readonly permission = "finance.ledger.view" as const;
  readonly params = PERIOD_PARAMS;

  constructor(private readonly context: ReportContext) {}

  run(actor: Principal, params: ParamValues): Promise<ReportTable> {
    return this.context.within(actor, this.permission, params, async (c) => {
      const accounts = await c.queries.taxAccounts(c.filter, c.range.from, c.range.to);
      const payable = accounts.filter((a) => a.systemKey !== "input_tax");
      const input = accounts.find((a) => a.systemKey === "input_tax");
      // Liabilities grow by credits; input tax recoverable (an asset) by debits.
      const net = (a: (typeof accounts)[number]) =>
        a.systemKey === "input_tax" ? a.debitMinor - a.creditMinor : a.creditMinor - a.debitMinor;
      const output = total(
        payable.filter((a) => a.systemKey.startsWith("tax_payable:")),
        net,
      );
      const recovered = input === undefined ? 0 : net(input);
      return {
        title: this.title,
        subtitle: between(c.range),
        currency: c.base,
        columns: [
          { key: "code", header: "Code", type: "text", width: 0.6 },
          { key: "account", header: "Account", type: "text", width: 2 },
          { key: "kind", header: "Kind", type: "text" },
          { key: "debit", header: "Debit", type: "money" },
          { key: "credit", header: "Credit", type: "money" },
          { key: "net", header: "Net for the period", type: "money" },
        ],
        rows: accounts.map((a) => ({
          code: a.code,
          account: a.name,
          kind:
            a.systemKey === "input_tax"
              ? "input tax recoverable"
              : a.systemKey === "withholding_tax"
                ? "withholding kept back"
                : "output tax",
          debit: a.debitMinor,
          credit: a.creditMinor,
          net: net(a),
        })),
        totals: null,
        summary: [
          { label: "Output tax", value: c.formatted(output) },
          { label: "Input tax recovered", value: c.formatted(recovered) },
          { label: "Net tax for the period", value: c.formatted(output - recovered) },
          {
            label: "Withholding tax kept back",
            value: c.formatted(
              total(
                payable.filter((a) => a.systemKey === "withholding_tax"),
                net,
              ),
            ),
          },
        ],
      };
    });
  }
}
