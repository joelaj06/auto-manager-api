import type { Paged, PageWindow } from "../../domain/value-objects/Paged.js";
import { pagedQuery } from "../database/postgres/PagedQuery.js";
import type {
  IReconciliation,
  LedgerCandidate,
  MatchKind,
  NewStatementLine,
  ReconciliationFigures,
  StatementImport,
  StatementLineFilter,
  StatementLineRecord,
  StatementLineStatus,
} from "../../application/ports/IAccountingRecords.js";
import type { PostgresTransactionContext } from "../database/postgres/PostgresTransactionContext.js";

type ImportRow = {
  id: string;
  account_id: string;
  file_name: string;
  from_date: string;
  to_date: string;
  lines: number;
  duplicates: number;
  auto_matched: number;
  status: StatementImport["status"];
  imported_by: string | null;
  imported_at: Date;
};
const toImport = (r: ImportRow): StatementImport => ({
  id: r.id,
  accountId: r.account_id,
  fileName: r.file_name,
  from: r.from_date,
  to: r.to_date,
  lines: r.lines,
  duplicates: r.duplicates,
  autoMatched: r.auto_matched,
  status: r.status,
  importedBy: r.imported_by,
  importedAt: r.imported_at,
});
const IMPORT_COLUMNS = `id, account_id, file_name, from_date::text as from_date,
  to_date::text as to_date, lines, duplicates, auto_matched, status, imported_by, imported_at`;

type LineRow = {
  id: string;
  import_id: string;
  account_id: string;
  line_no: number;
  value_date: string;
  description: string;
  reference: string | null;
  amount_minor: string;
  balance_minor: string | null;
  status: StatementLineStatus;
  match_kind: MatchKind | null;
  journal_entry_id: string | null;
  note: string | null;
  matched_by: string | null;
  matched_at: Date | null;
};
const toLine = (r: LineRow): StatementLineRecord => ({
  id: r.id,
  importId: r.import_id,
  accountId: r.account_id,
  lineNo: r.line_no,
  date: r.value_date,
  description: r.description,
  reference: r.reference,
  amountMinor: Number(r.amount_minor),
  balanceMinor: r.balance_minor === null ? null : Number(r.balance_minor),
  status: r.status,
  matchKind: r.match_kind,
  journalEntryId: r.journal_entry_id,
  note: r.note,
  matchedBy: r.matched_by,
  matchedAt: r.matched_at,
});
const LINE_COLUMNS = `id, import_id, account_id, line_no, value_date::text as value_date,
  description, reference, amount_minor, balance_minor, status, match_kind, journal_entry_id, note,
  matched_by, matched_at`;

type CandidateRow = {
  id: string;
  entry_id: string;
  number: string;
  entry_date: string;
  amount_minor: string;
  description: string;
  source_type: string;
  memo: string | null;
  payment_number: string | null;
  cancelled: boolean;
};
const toCandidate = (r: CandidateRow): LedgerCandidate => ({
  ledgerLineId: r.id,
  entryId: r.entry_id,
  entryNumber: r.number,
  date: r.entry_date,
  amountMinor: Number(r.amount_minor),
  description: r.description,
  sourceType: r.source_type,
  memo: r.memo,
  references: [r.number, r.payment_number, r.memo],
  cancelled: r.cancelled,
});
const CANDIDATES = `
  select l.id, l.entry_id, e.number, e.entry_date::text as entry_date,
         l.debit_minor - l.credit_minor as amount_minor, e.description, e.source_type, l.memo,
         p.number as payment_number,
         (e.reverses_id is not null or exists (
            select 1 from journal_entries r where r.reverses_id = e.id)) as cancelled
    from ledger_lines l
    join journal_entries e on e.id = l.entry_id
    left join payments p on e.source_type = 'payment' and p.id = e.source_id
   where l.account_id = $1
     and not exists (select 1 from statement_matches m where m.ledger_line_id = l.id)`;

/** Statements and their matches in the tenant database (tenant unit of work). */
export class PostgresReconciliation implements IReconciliation {
  constructor(private readonly tx: PostgresTransactionContext) {}

  async lockAccount(accountId: string): Promise<void> {
    await this.tx
      .current()
      .query("select pg_advisory_xact_lock(hashtextextended('reconcile:' || $1::text, 0))", [
        accountId,
      ]);
  }

  async knownFingerprints(
    accountId: string,
    fingerprints: readonly string[],
  ): Promise<Set<string>> {
    const { rows } = await this.tx.current().query<{ fingerprint: string }>(
      `select fingerprint from statement_lines
        where account_id = $1 and fingerprint = any($2::text[])`,
      [accountId, fingerprints],
    );
    return new Set(rows.map((r) => r.fingerprint));
  }

  async addImport(
    entry: Omit<StatementImport, "status" | "importedBy"> & { importedBy: string },
  ): Promise<void> {
    await this.tx.current().query(
      `insert into statement_imports (id, account_id, file_name, from_date, to_date, lines,
         duplicates, auto_matched, imported_by, imported_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        entry.id,
        entry.accountId,
        entry.fileName,
        entry.from,
        entry.to,
        entry.lines,
        entry.duplicates,
        entry.autoMatched,
        entry.importedBy,
        entry.importedAt,
      ],
    );
  }

  async addLines(lines: readonly NewStatementLine[]): Promise<void> {
    await this.tx.current().query(
      `insert into statement_lines (id, import_id, account_id, line_no, value_date, description,
         reference, amount_minor, balance_minor, fingerprint)
       select id, import_id, account_id, line_no, date, description, reference, amount_minor,
              balance_minor, fingerprint
         from jsonb_to_recordset($1::jsonb) as t(id uuid, import_id uuid, account_id uuid,
           line_no integer, date date, description text, reference text, amount_minor bigint,
           balance_minor bigint, fingerprint text)`,
      [
        JSON.stringify(
          lines.map((l) => ({
            id: l.id,
            import_id: l.importId,
            account_id: l.accountId,
            line_no: l.lineNo,
            date: l.date,
            description: l.description,
            reference: l.reference,
            amount_minor: l.amountMinor,
            balance_minor: l.balanceMinor,
            fingerprint: l.fingerprint,
          })),
        ),
      ],
    );
  }

  async setAutoMatched(importId: string, count: number): Promise<void> {
    await this.tx
      .current()
      .query("update statement_imports set auto_matched = $2 where id = $1", [importId, count]);
  }

  async imports(accountId: string | null, window: PageWindow): Promise<Paged<StatementImport>> {
    const { rows, total } = await pagedQuery<ImportRow>(
      this.tx.current(),
      {
        sql: `select ${IMPORT_COLUMNS} from statement_imports
        where ($1::uuid is null or account_id = $1)`,
        orderBy: "imported_at desc, id desc",
        params: [accountId],
      },
      window,
    );
    return { rows: rows.map(toImport), total };
  }

  async importById(id: string): Promise<StatementImport | null> {
    const { rows } = await this.tx
      .current()
      .query<ImportRow>(`select ${IMPORT_COLUMNS} from statement_imports where id = $1`, [id]);
    return rows[0] === undefined ? null : toImport(rows[0]);
  }

  async countPostedLines(importId: string): Promise<number> {
    const { rows } = await this.tx.current().query<{ n: number }>(
      `select count(*)::int as n from statement_lines
        where import_id = $1 and match_kind = 'posted'`,
      [importId],
    );
    return rows[0]!.n;
  }

  async voidImport(id: string, by: string, at: Date): Promise<void> {
    const client = this.tx.current();
    await client.query(
      `delete from statement_matches m using statement_lines l
        where l.id = m.statement_line_id and l.import_id = $1`,
      [id],
    );
    await client.query("delete from statement_lines where import_id = $1", [id]);
    await client.query(
      `update statement_imports set status = 'voided', voided_by = $2, voided_at = $3
        where id = $1`,
      [id, by, at],
    );
  }

  async line(id: string, lock = false): Promise<StatementLineRecord | null> {
    const { rows } = await this.tx
      .current()
      .query<LineRow>(
        `select ${LINE_COLUMNS} from statement_lines where id = $1 ${lock ? "for update" : ""}`,
        [id],
      );
    return rows[0] === undefined ? null : toLine(rows[0]);
  }

  async lines(filter: StatementLineFilter): Promise<Paged<StatementLineRecord>> {
    const params: unknown[] = [filter.accountId, filter.status];
    const where = ["account_id = $1", "status = $2"];
    const add = (sql: (n: number) => string, value: unknown) => {
      params.push(value);
      where.push(sql(params.length));
    };
    if (filter.from !== undefined) add((n) => `value_date >= $${n}`, filter.from);
    if (filter.to !== undefined) add((n) => `value_date <= $${n}`, filter.to);
    const { rows, total } = await pagedQuery<LineRow>(
      this.tx.current(),
      {
        sql: `select ${LINE_COLUMNS} from statement_lines where ${where.join(" and ")}`,
        orderBy: "value_date, id",
        params,
      },
      filter,
    );
    return { rows: rows.map(toLine), total };
  }

  async unmatched(accountId: string): Promise<StatementLineRecord[]> {
    const { rows } = await this.tx.current().query<LineRow>(
      `select ${LINE_COLUMNS} from statement_lines
        where account_id = $1 and status = 'unmatched' order by value_date, line_no, id`,
      [accountId],
    );
    return rows.map(toLine);
  }

  async candidates(accountId: string, from: string, to: string): Promise<LedgerCandidate[]> {
    const { rows } = await this.tx
      .current()
      .query<CandidateRow>(
        `${CANDIDATES} and e.entry_date between $2 and $3 order by e.entry_date, l.id`,
        [accountId, from, to],
      );
    return rows.map(toCandidate);
  }

  async candidatesByIds(accountId: string, ids: readonly string[]): Promise<LedgerCandidate[]> {
    const { rows } = await this.tx
      .current()
      .query<CandidateRow>(`${CANDIDATES} and l.id = any($2::uuid[])`, [accountId, ids]);
    return rows.map(toCandidate);
  }

  async ledgerLineOf(entryId: string, accountId: string): Promise<string> {
    const { rows } = await this.tx
      .current()
      .query<{ id: string }>(
        "select id from ledger_lines where entry_id = $1 and account_id = $2",
        [entryId, accountId],
      );
    return rows[0]!.id;
  }

  async match(
    lineId: string,
    ledgerLineIds: readonly string[],
    kind: MatchKind,
    journalEntryId: string | null,
    by: string | null,
    at: Date,
  ): Promise<void> {
    const client = this.tx.current();
    await client.query(
      `insert into statement_matches (statement_line_id, ledger_line_id)
       select $1, unnest($2::uuid[])`,
      [lineId, ledgerLineIds],
    );
    await client.query(
      `update statement_lines
          set status = 'matched', match_kind = $2, journal_entry_id = $3, matched_by = $4,
              matched_at = $5
        where id = $1`,
      [lineId, kind, journalEntryId, by, at],
    );
  }

  async release(lineId: string): Promise<void> {
    const client = this.tx.current();
    await client.query("delete from statement_matches where statement_line_id = $1", [lineId]);
    await client.query(
      `update statement_lines
          set status = 'unmatched', match_kind = null, journal_entry_id = null, note = null,
              matched_by = null, matched_at = null
        where id = $1`,
      [lineId],
    );
  }

  async ignore(lineId: string, note: string, by: string, at: Date): Promise<void> {
    await this.tx.current().query(
      `update statement_lines
          set status = 'ignored', note = $2, matched_by = $3, matched_at = $4
        where id = $1`,
      [lineId, note, by, at],
    );
  }

  async figures(accountId: string, asOf: string): Promise<ReconciliationFigures> {
    const client = this.tx.current();
    const { rows: statement } = await client.query<{
      first_date: string | null;
      in_minor: string;
      out_minor: string;
      unmatched: number;
      ignored_minor: string;
      ignored: number;
      reversed: number;
    }>(
      `select min(l.value_date)::text as first_date,
              coalesce(sum(l.amount_minor) filter (
                where l.status = 'unmatched' and l.amount_minor > 0), 0) as in_minor,
              coalesce(-sum(l.amount_minor) filter (
                where l.status = 'unmatched' and l.amount_minor < 0), 0) as out_minor,
              (count(*) filter (where l.status = 'unmatched'))::int as unmatched,
              coalesce(sum(l.amount_minor) filter (where l.status = 'ignored'), 0) as ignored_minor,
              (count(*) filter (where l.status = 'ignored'))::int as ignored,
              (select count(*)::int from statement_lines s
                where s.account_id = $1 and s.value_date <= $2 and s.match_kind <> 'posted'
                  and exists (
                    select 1 from statement_matches m
                      join ledger_lines ll on ll.id = m.ledger_line_id
                      join journal_entries r on r.reverses_id = ll.entry_id
                     where m.statement_line_id = s.id)) as reversed
         from statement_lines l
        where l.account_id = $1 and l.value_date <= $2`,
      [accountId, asOf],
    );
    const s = statement[0]!;
    const { rows: printed } = await client.query<{ balance_minor: string }>(
      `select l.balance_minor from statement_lines l
         join statement_imports i on i.id = l.import_id
        where l.account_id = $1 and l.value_date <= $2 and l.balance_minor is not null
        order by l.value_date desc, i.imported_at desc, l.line_no desc limit 1`,
      [accountId, asOf],
    );
    const { rows: ledger } = await client.query<{
      in_minor: string;
      out_minor: string;
      lines: number;
    }>(
      `select coalesce(sum(l.debit_minor), 0) as in_minor,
              coalesce(sum(l.credit_minor), 0) as out_minor, count(*)::int as lines
         from ledger_lines l
         join journal_entries e on e.id = l.entry_id
        where l.account_id = $1 and e.entry_date between $3 and $2
          and not exists (select 1 from statement_matches m where m.ledger_line_id = l.id)`,
      [accountId, asOf, s.first_date ?? asOf],
    );
    const l = ledger[0]!;
    return {
      statementBalanceMinor: printed[0] === undefined ? null : Number(printed[0].balance_minor),
      firstStatementDate: s.first_date,
      unmatchedStatementInMinor: Number(s.in_minor),
      unmatchedStatementOutMinor: Number(s.out_minor),
      unmatchedStatementLines: s.unmatched,
      ignoredMinor: Number(s.ignored_minor),
      ignoredLines: s.ignored,
      unmatchedLedgerInMinor: Number(l.in_minor),
      unmatchedLedgerOutMinor: Number(l.out_minor),
      unmatchedLedgerLines: l.lines,
      matchedThenReversed: s.reversed,
    };
  }
}
