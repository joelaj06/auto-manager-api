import type {
  ICurrencyUsage,
  OpenCurrencyDocuments,
} from "../../application/ports/ICurrencyUsage.js";
import type { PostgresTransactionContext } from "../database/postgres/PostgresTransactionContext.js";

export class PostgresCurrencyUsage implements ICurrencyUsage {
  constructor(private readonly transactions: PostgresTransactionContext) {}

  async openDocuments(currency: string): Promise<OpenCurrencyDocuments> {
    const { rows } = await this.transactions.current().query<{
      invoices: number;
      expenses: number;
    }>(
      `select
         (select count(*)::int from invoices
           where currency = $1 and status in ('draft', 'issued', 'partially_paid')) as invoices,
         (select count(*)::int from expenses
           where currency = $1 and status in ('draft', 'submitted', 'approved')) as expenses`,
      [currency],
    );
    return { invoices: rows[0]!.invoices, expenses: rows[0]!.expenses };
  }
}
