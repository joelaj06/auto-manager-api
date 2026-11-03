import type {
  AccountingExportRecord,
  AccountMapping,
  IAccountingExports,
} from "../../application/ports/IAccountingRecords.js";
import type {
  ExportDetail,
  ExportFormat,
  ExportLine,
  ExportTarget,
} from "../../domain/finance/AccountingExport.js";
import type { PostgresTransactionContext } from "../database/postgres/PostgresTransactionContext.js";

type LineRow = {
  number: string;
  entry_date: string;
  description: string;
  source_type: string;
  account_id: string;
  code: string;
  name: string;
  debit_minor: string;
  credit_minor: string;
  branch: string | null;
  vehicle: string | null;
  party_type: string | null;
  party_name: string | null;
  memo: string | null;
};

type HistoryRow = {
  id: string;
  format: ExportFormat;
  detail: ExportDetail;
  from_date: string;
  to_date: string;
  entries: number;
  lines: number;
  total_debit_minor: string;
  exported_by: string | null;
  exported_at: Date;
  posted_since: number;
};

/** Journals and their exports in the tenant database (tenant unit of work). */
export class PostgresAccountingExports implements IAccountingExports {
  constructor(private readonly tx: PostgresTransactionContext) {}

  async lines(from: string, to: string, limit: number): Promise<ExportLine[]> {
    const { rows } = await this.tx.current().query<LineRow>(
      `select e.number, e.entry_date::text as entry_date, e.description, e.source_type,
              l.account_id, a.code, a.name, l.debit_minor, l.credit_minor, b.name as branch,
              v.code as vehicle, l.party_type, l.memo,
              coalesce(c.name, s.name, d.first_name || ' ' || d.last_name) as party_name
         from journal_entries e
         join ledger_lines l on l.entry_id = e.id
         join ledger_accounts a on a.id = l.account_id
         left join branches b on b.id = l.branch_id
         left join vehicles v on v.id = l.vehicle_id
         left join customers c on l.party_type = 'customer' and c.id = l.party_id
         left join suppliers s on l.party_type = 'supplier' and s.id = l.party_id
         left join drivers d on l.party_type = 'driver' and d.id = l.party_id
        where e.entry_date between $1 and $2
        order by e.entry_date, e.number, l.id
        limit $3`,
      [from, to, limit],
    );
    return rows.map((r) => ({
      journalNumber: r.number,
      date: r.entry_date,
      description: r.description,
      sourceType: r.source_type,
      accountId: r.account_id,
      accountCode: r.code,
      accountName: r.name,
      debitMinor: Number(r.debit_minor),
      creditMinor: Number(r.credit_minor),
      branch: r.branch,
      vehicle: r.vehicle,
      partyType: r.party_type,
      partyName: r.party_name,
      memo: r.memo,
    }));
  }

  async mappings(target: ExportTarget): Promise<AccountMapping[]> {
    const { rows } = await this.tx.current().query<{
      id: string;
      code: string;
      name: string;
      external: string | null;
    }>(
      `select a.id, a.code, a.name, m.external
         from ledger_accounts a
         left join accounting_account_mappings m on m.account_id = a.id and m.target = $1
        order by a.code`,
      [target],
    );
    return rows.map((r) => ({
      accountId: r.id,
      code: r.code,
      name: r.name,
      external: r.external,
    }));
  }

  async saveMappings(
    target: ExportTarget,
    mappings: readonly Readonly<{ accountId: string; external: string | null }>[],
    by: string,
    at: Date,
  ): Promise<void> {
    const client = this.tx.current();
    for (const { accountId, external } of mappings)
      if (external === null)
        await client.query(
          "delete from accounting_account_mappings where account_id = $1 and target = $2",
          [accountId, target],
        );
      else
        await client.query(
          `insert into accounting_account_mappings (account_id, target, external, updated_by,
             updated_at)
           values ($1, $2, $3, $4, $5)
           on conflict (account_id, target) do update
             set external = excluded.external, updated_by = excluded.updated_by,
                 updated_at = excluded.updated_at`,
          [accountId, target, external, by, at],
        );
  }

  async overlaps(format: ExportFormat, from: string, to: string): Promise<number> {
    const { rows } = await this.tx.current().query<{ n: number }>(
      `select count(*)::int as n from accounting_exports
        where format = $1 and from_date <= $3 and to_date >= $2`,
      [format, from, to],
    );
    return rows[0]!.n;
  }

  async record(
    entry: Omit<AccountingExportRecord, "postedSince" | "exportedBy"> & { exportedBy: string },
  ): Promise<void> {
    await this.tx.current().query(
      `insert into accounting_exports (id, format, detail, from_date, to_date, entries, lines,
         total_debit_minor, exported_by, exported_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        entry.id,
        entry.format,
        entry.detail,
        entry.from,
        entry.to,
        entry.entries,
        entry.lines,
        entry.totalDebitMinor,
        entry.exportedBy,
        entry.exportedAt,
      ],
    );
  }

  async history(limit: number): Promise<AccountingExportRecord[]> {
    const { rows } = await this.tx.current().query<HistoryRow>(
      `select x.id, x.format, x.detail, x.from_date::text as from_date, x.to_date::text as to_date,
              x.entries, x.lines, x.total_debit_minor, x.exported_by, x.exported_at,
              (select count(*)::int from journal_entries e
                where e.entry_date between x.from_date and x.to_date
                  and e.created_at > x.exported_at) as posted_since
         from accounting_exports x
        order by x.exported_at desc limit $1`,
      [limit],
    );
    return rows.map((r) => ({
      id: r.id,
      format: r.format,
      detail: r.detail,
      from: r.from_date,
      to: r.to_date,
      entries: r.entries,
      lines: r.lines,
      totalDebitMinor: Number(r.total_debit_minor),
      exportedBy: r.exported_by,
      exportedAt: r.exported_at,
      postedSince: r.posted_since,
    }));
  }
}
