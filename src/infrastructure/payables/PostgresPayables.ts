import type { IPayables, OpenBill } from "../../application/ports/IPayables.js";
import type { PostgresTransactionContext } from "../database/postgres/PostgresTransactionContext.js";

type BillRow = {
  id: string;
  number: string | null;
  branch_id: string;
  expense_date: string;
  payee_type: "supplier" | "driver" | null;
  payee_id: string | null;
  payee_name: string;
  payment_terms_days: number | null;
  description: string;
  reference: string | null;
  currency: string;
  amount_minor: string;
  amount_base_minor: string;
};

export class PostgresPayables implements IPayables {
  constructor(private readonly transactions: PostgresTransactionContext) {}

  async openBills(filter: Readonly<{ supplierId?: string; asOf: string }>): Promise<OpenBill[]> {
    const { rows } = await this.transactions.current().query<BillRow>(
      `select e.id, e.number, e.branch_id, e.expense_date::text as expense_date, e.payee_type,
              e.payee_id,
              coalesce(s.name, d.first_name || ' ' || d.last_name, e.payee_name, '') as payee_name,
              s.payment_terms_days, e.description, e.reference, e.currency, e.amount_minor,
              e.amount_base_minor
         from expenses e
         left join suppliers s on e.payee_type = 'supplier' and s.id = e.payee_id
         left join drivers d on e.payee_type = 'driver' and d.id = e.payee_id
        where e.status = 'approved' and e.expense_date <= $1
          and ($2::uuid is null or (e.payee_type = 'supplier' and e.payee_id = $2))
        order by e.expense_date, e.number`,
      [filter.asOf, filter.supplierId ?? null],
    );
    return rows.map((r) => ({
      expenseId: r.id,
      number: r.number,
      branchId: r.branch_id,
      billDate: r.expense_date,
      payee:
        r.payee_type === null || r.payee_id === null
          ? null
          : { type: r.payee_type, id: r.payee_id },
      payeeName: r.payee_name,
      termsDays: r.payment_terms_days,
      description: r.description,
      reference: r.reference,
      currency: r.currency,
      amountMinor: Number(r.amount_minor),
      amountBaseMinor: Number(r.amount_base_minor),
    }));
  }
}
