import type { IIntegrityChecks, IntegrityCheck } from "../../application/ports/IIntegrityChecks.js";
import type { Queryable } from "../database/postgres/Queryable.js";

type Check = Readonly<{
  name: string;
  description: string;
  /** Rows that break the invariant, with a short description each. */
  sql: string;
}>;

/** Agreements whose figures are still in the books (not written off by a closure). */
const IN_BOOKS = `('active', 'in_arrears', 'defaulted', 'completed')`;

const CHECKS: readonly Check[] = [
  {
    name: "journal entries balanced",
    description: "Every journal entry has equal debits and credits and at least two lines",
    sql: `select e.number as offender
            from journal_entries e join ledger_lines l on l.entry_id = e.id
           group by e.id, e.number
          having sum(l.debit_minor) <> sum(l.credit_minor) or count(*) < 2`,
  },
  {
    name: "trial balance",
    description: "All debits equal all credits",
    sql: `select 'debits ' || sum(debit_minor) || ', credits ' || sum(credit_minor) as offender
            from ledger_lines
          having coalesce(sum(debit_minor), 0) <> coalesce(sum(credit_minor), 0)`,
  },
  {
    name: "payment allocations",
    description: "A payment's allocated amount is what its open invoice allocations add up to",
    sql: `select p.number || ': ' || p.allocated_minor || ' vs ' || coalesce(sum(a.amount_minor), 0)
                   as offender
            from payments p
            left join payment_allocations a on a.payment_id = p.id and a.released_at is null
           group by p.id, p.number, p.allocated_minor
          having p.allocated_minor <> coalesce(sum(a.amount_minor), 0)`,
  },
  {
    name: "invoice payments",
    description: "An invoice's paid amount is what its open allocations add up to",
    sql: `select coalesce(i.number, i.id::text) || ': ' || i.paid_minor || ' vs '
                   || coalesce(sum(a.amount_minor), 0) as offender
            from invoices i
            left join payment_allocations a on a.invoice_id = i.id and a.released_at is null
           group by i.id, i.number, i.paid_minor
          having i.paid_minor <> coalesce(sum(a.amount_minor), 0)`,
  },
  {
    name: "work and pay allocations",
    description:
      "A work and pay payment applies at most its amount, and a reversed one applies nothing",
    sql: `select p.number || ': ' || sum(a.amount_minor) || ' applied of ' || p.amount_base_minor
                   || ' (' || p.status || ')' as offender
            from workpay_allocations a join payments p on p.id = a.payment_id
           where a.released_at is null
           group by p.id, p.number, p.amount_base_minor, p.status
          having sum(a.amount_minor) > p.amount_base_minor or p.status = 'reversed'`,
  },
  {
    name: "work and pay rows",
    description:
      "Instalments, late fees and charges were not paid, waived or moved beyond their amount",
    sql: `select 'instalment ' || id as offender from workpay_instalments
           where paid_minor + waived_minor + rescheduled_minor > amount_minor
          union all
          select 'late fee ' || id from workpay_penalties where paid_minor + waived_minor > amount_minor
          union all
          select 'charge ' || id from workpay_charges where paid_minor + waived_minor > amount_minor`,
  },
  {
    name: "work and pay receivables",
    description:
      "The receivables account equals what agreements still owe (instalments, late fees, charges)",
    sql: `with ledger as (
            select coalesce(sum(l.debit_minor - l.credit_minor), 0) as amount
              from ledger_lines l join ledger_accounts a on a.id = l.account_id
             where a.system_key = 'workpay_receivables'),
          owed as (
            select coalesce((select sum(i.amount_minor - i.paid_minor - i.waived_minor
                                        - i.rescheduled_minor)
                               from workpay_instalments i join workpay_agreements w
                                 on w.id = i.agreement_id where w.status in ${IN_BOOKS}), 0)
                 + coalesce((select sum(p.amount_minor - p.paid_minor - p.waived_minor)
                               from workpay_penalties p join workpay_agreements w
                                 on w.id = p.agreement_id where w.status in ${IN_BOOKS}), 0)
                 + coalesce((select sum(c.amount_minor - c.paid_minor - c.waived_minor)
                               from workpay_charges c join workpay_agreements w
                                 on w.id = c.agreement_id where w.status in ${IN_BOOKS}), 0)
                   as amount)
          select 'ledger ' || ledger.amount || ', agreements ' || owed.amount as offender
            from ledger, owed where ledger.amount <> owed.amount`,
  },
  {
    name: "work and pay unearned income",
    description: "Unearned income equals the instalments agreements still owe",
    sql: `with ledger as (
            select coalesce(sum(l.credit_minor - l.debit_minor), 0) as amount
              from ledger_lines l join ledger_accounts a on a.id = l.account_id
             where a.system_key = 'workpay_unearned'),
          owed as (
            select coalesce(sum(i.amount_minor - i.paid_minor - i.waived_minor
                                - i.rescheduled_minor), 0) as amount
              from workpay_instalments i join workpay_agreements w on w.id = i.agreement_id
             where w.status in ${IN_BOOKS})
          select 'ledger ' || ledger.amount || ', instalments ' || owed.amount as offender
            from ledger, owed where ledger.amount <> owed.amount`,
  },
];

const SHOWN = 5;

/** The tenant integrity checks in SQL, for a transaction or a restored database's connection. */
export class PostgresIntegrityChecks implements IIntegrityChecks {
  constructor(private readonly db: () => Queryable) {}

  async run(): Promise<IntegrityCheck[]> {
    const results: IntegrityCheck[] = [];
    for (const check of CHECKS) {
      const { rows } = await this.db().query<{ offender: string }>(check.sql);
      results.push({
        name: check.name,
        description: check.description,
        passed: rows.length === 0,
        problems: rows.length,
        detail:
          rows.length === 0
            ? null
            : rows
                .slice(0, SHOWN)
                .map((r) => r.offender)
                .join("; ") + (rows.length > SHOWN ? ` … and ${rows.length - SHOWN} more` : ""),
      });
    }
    return results;
  }
}
