import type { ParamValues, ReportTable } from "../../../../domain/reporting/Report.js";
import type { Principal } from "../../../authorization/Principal.js";
import type { LedgerViews } from "../../finance/LedgerViews.js";
import type { ReportDefinition } from "../ReportDefinition.js";

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
