import type {
  AccountBalance,
  ILedger,
  LedgerAccount,
  LedgerLineFilter,
  LedgerLineView,
  PostedEntry,
} from "../../application/ports/IFinanceRecords.js";
import type {
  JournalDraft,
  LedgerPartyType,
  SystemAccountKey,
} from "../../domain/finance/Journal.js";
import type { PostgresTransactionContext } from "../database/postgres/PostgresTransactionContext.js";

type AccountRow = {
  id: string;
  code: string;
  name: string;
  type: LedgerAccount["type"];
  system_key: SystemAccountKey | null;
  active: boolean;
};
const toAccount = (r: AccountRow): LedgerAccount => ({
  id: r.id,
  code: r.code,
  name: r.name,
  type: r.type,
  systemKey: r.system_key,
  active: r.active,
});

type LineRow = {
  id: string;
  entry_id: string;
  number: string;
  entry_date: string;
  description: string;
  source_type: string;
  source_id: string;
  account_id: string;
  debit_minor: string;
  credit_minor: string;
  branch_id: string | null;
  vehicle_id: string | null;
  party_type: LedgerPartyType | null;
  party_id: string | null;
  memo: string | null;
  created_at: Date;
};

/** The ledger in the tenant database (tenant unit of work). */
export class PostgresLedger implements ILedger {
  constructor(private readonly transactions: PostgresTransactionContext) {}

  private get tx() {
    return this.transactions.current();
  }

  async accounts(): Promise<LedgerAccount[]> {
    const { rows } = await this.tx.query<AccountRow>(
      "select id, code, name, type, system_key, active from ledger_accounts order by code",
    );
    return rows.map(toAccount);
  }

  async createAccount(account: Omit<LedgerAccount, "systemKey" | "active">): Promise<void> {
    await this.tx.query(
      "insert into ledger_accounts (id, code, name, type) values ($1, $2, $3, $4)",
      [account.id, account.code, account.name, account.type],
    );
  }

  async accountCodeTaken(code: string): Promise<boolean> {
    const { rows } = await this.tx.query("select 1 from ledger_accounts where code = $1", [code]);
    return rows.length > 0;
  }

  async post(entry: JournalDraft, number: string, createdBy: string | null): Promise<string> {
    const { rows } = await this.tx.query<{ id: string }>(
      `insert into journal_entries (number, entry_date, description, source_type, source_id,
         reverses_id, created_by)
       values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [
        number,
        entry.date,
        entry.description.slice(0, 300),
        entry.source.type,
        entry.source.id,
        entry.reversesId,
        createdBy,
      ],
    );
    const id = rows[0]!.id;
    for (const line of entry.lines)
      await this.tx.query(
        `insert into ledger_lines (entry_id, account_id, debit_minor, credit_minor, branch_id,
           vehicle_id, party_type, party_id, memo)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          id,
          line.accountId,
          line.debitMinor,
          line.creditMinor,
          line.branchId,
          line.vehicleId,
          line.party?.type ?? null,
          line.party?.id ?? null,
          line.memo,
        ],
      );
    return id;
  }

  async openEntries(sourceType: string, sourceId: string): Promise<PostedEntry[]> {
    const { rows } = await this.tx.query<{
      id: string;
      number: string;
      entry_date: string;
      description: string;
      reverses_id: string | null;
      created_by: string | null;
      created_at: Date;
    }>(
      `select e.id, e.number, e.entry_date::text as entry_date, e.description, e.reverses_id,
              e.created_by, e.created_at
         from journal_entries e
        where e.source_type = $1 and e.source_id = $2 and e.reverses_id is null
          and not exists (select 1 from journal_entries r where r.reverses_id = e.id)
        order by e.created_at desc`,
      [sourceType, sourceId],
    );
    const entries: PostedEntry[] = [];
    for (const r of rows) {
      const lines = await this.tx.query<LineRow>(
        "select * from ledger_lines where entry_id = $1 order by id",
        [r.id],
      );
      entries.push({
        id: r.id,
        number: r.number,
        date: r.entry_date,
        description: r.description,
        source: { type: sourceType, id: sourceId },
        reversesId: r.reverses_id,
        createdBy: r.created_by,
        createdAt: r.created_at,
        lines: lines.rows.map((l) => ({
          accountId: l.account_id,
          debitMinor: Number(l.debit_minor),
          creditMinor: Number(l.credit_minor),
          branchId: l.branch_id,
          vehicleId: l.vehicle_id,
          party:
            l.party_type === null || l.party_id === null
              ? null
              : { type: l.party_type, id: l.party_id },
          memo: l.memo,
        })),
      });
    }
    return entries;
  }

  async balances(asOf: string | null): Promise<AccountBalance[]> {
    const { rows } = await this.tx.query<AccountRow & { debit: string; credit: string }>(
      `select a.id, a.code, a.name, a.type, a.system_key, a.active,
              coalesce(sum(l.debit_minor), 0) as debit, coalesce(sum(l.credit_minor), 0) as credit
         from ledger_accounts a
         left join ledger_lines l on l.account_id = a.id
              and ($1::date is null or exists (select 1 from journal_entries e
                                              where e.id = l.entry_id and e.entry_date <= $1))
        group by a.id
        order by a.code`,
      [asOf],
    );
    return rows.map((r) => {
      const debitMinor = Number(r.debit);
      const creditMinor = Number(r.credit);
      // Assets and expenses carry debit balances; the rest credit balances.
      const debitNature = r.type === "asset" || r.type === "expense";
      return {
        ...toAccount(r),
        debitMinor,
        creditMinor,
        balanceMinor: debitNature ? debitMinor - creditMinor : creditMinor - debitMinor,
      };
    });
  }

  async lines(filter: LedgerLineFilter): Promise<LedgerLineView[]> {
    const params: unknown[] = [];
    const param = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    const where = ["true"];
    if (filter.accountId !== undefined) where.push(`l.account_id = ${param(filter.accountId)}`);
    if (filter.accountIds !== undefined)
      where.push(`l.account_id = any(${param(filter.accountIds)}::uuid[])`);
    if (filter.party !== undefined)
      where.push(
        `l.party_type = ${param(filter.party.type)} and l.party_id = ${param(filter.party.id)}`,
      );
    if (filter.vehicleId !== undefined) where.push(`l.vehicle_id = ${param(filter.vehicleId)}`);
    if (filter.branchId !== undefined) where.push(`l.branch_id = ${param(filter.branchId)}`);
    if (filter.from !== undefined) where.push(`e.entry_date >= ${param(filter.from)}`);
    if (filter.to !== undefined) where.push(`e.entry_date <= ${param(filter.to)}`);
    if (filter.after !== undefined)
      where.push(
        `(e.entry_date, e.created_at, l.id) < (${param(filter.after.date)}::date, ${param(filter.after.createdAt)}::timestamptz, ${param(filter.after.id)}::uuid)`,
      );
    const { rows } = await this.tx.query<LineRow>(
      `select l.id, l.entry_id, e.number, e.entry_date::text as entry_date, e.description,
              e.source_type, e.source_id, l.account_id, l.debit_minor, l.credit_minor, l.branch_id,
              l.vehicle_id, l.party_type, l.party_id, l.memo, e.created_at
         from ledger_lines l join journal_entries e on e.id = l.entry_id
        where ${where.join(" and ")}
        order by e.entry_date desc, e.created_at desc, l.id desc
        limit ${param(filter.limit)}`,
      params,
    );
    return rows.map((r) => ({
      id: r.id,
      entryId: r.entry_id,
      number: r.number,
      date: r.entry_date,
      description: r.description,
      sourceType: r.source_type,
      sourceId: r.source_id,
      accountId: r.account_id,
      debitMinor: Number(r.debit_minor),
      creditMinor: Number(r.credit_minor),
      branchId: r.branch_id,
      vehicleId: r.vehicle_id,
      partyType: r.party_type,
      partyId: r.party_id,
      memo: r.memo,
      createdAt: r.created_at,
    }));
  }

  async partyBalance(
    accountId: string,
    party: Readonly<{ type: LedgerPartyType; id: string }>,
  ): Promise<number> {
    const { rows } = await this.tx.query<{ balance: string }>(
      `select coalesce(sum(debit_minor - credit_minor), 0) as balance from ledger_lines
        where account_id = $1 and party_type = $2 and party_id = $3`,
      [accountId, party.type, party.id],
    );
    return Number(rows[0]?.balance ?? 0);
  }

  async partyNet(
    accountIds: readonly string[],
    party: Readonly<{ type: LedgerPartyType; id: string }>,
    before: string | null,
  ): Promise<number> {
    const { rows } = await this.tx.query<{ net: string }>(
      `select coalesce(sum(l.debit_minor - l.credit_minor), 0) as net
         from ledger_lines l join journal_entries e on e.id = l.entry_id
        where l.account_id = any($1::uuid[]) and l.party_type = $2 and l.party_id = $3
          and ($4::date is null or e.entry_date < $4)`,
      [accountIds, party.type, party.id, before],
    );
    return Number(rows[0]?.net ?? 0);
  }

  async booksLockedUntil(): Promise<string | null> {
    const { rows } = await this.tx.query<{ locked: string | null }>(
      "select books_locked_until::text as locked from organisation",
    );
    return rows[0]?.locked ?? null;
  }

  async setBooksLockedUntil(date: string | null): Promise<void> {
    await this.tx.query("update organisation set books_locked_until = $1, updated_at = now()", [
      date,
    ]);
  }

  async lockBaseCurrency(now: Date): Promise<void> {
    await this.tx.query(
      "update organisation set base_currency_locked_at = $1 where base_currency_locked_at is null",
      [now],
    );
  }
}
