import type pg from "pg";

/** The currency we bill in: the standard plan's, as for commissions, else GHS. */
const BILLING_CURRENCY = "coalesce((select currency from plans where code = 'standard'), 'GHS')";

/** An amount counted in a list's totals only when it is in the billing currency. */
export const inBillingCurrency = (amount: string) =>
  `case when currency = ${BILLING_CURRENCY} then ${amount} else 0 end`;

export async function billingCurrency(
  db: Readonly<{ query<R extends pg.QueryResultRow>(sql: string): Promise<{ rows: R[] }> }>,
): Promise<string> {
  const { rows } = await db.query<{ currency: string }>(`select ${BILLING_CURRENCY} as currency`);
  return rows[0]?.currency.trim() ?? "GHS";
}
