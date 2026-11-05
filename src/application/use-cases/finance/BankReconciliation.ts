import { pageOf, pageWindow, type Page, type PageRequest } from "../../dto/Page.js";
import { createHash } from "node:crypto";
import {
  parseStatement,
  statementLineKey,
  type ColumnNames,
  type StatementLine,
} from "../../../domain/finance/BankStatement.js";
import { credit, debit, FinanceRuleError, journal } from "../../../domain/finance/Journal.js";
import { DomainError } from "../../../domain/errors/DomainError.js";
import {
  autoMatch,
  REFERENCE_DAYS,
  suggestions,
} from "../../../domain/finance/StatementMatcher.js";
import { Money, type MoneyJson } from "../../../domain/money/Money.js";
import type { Principal } from "../../authorization/Principal.js";
import type {
  IReconciliation,
  LedgerCandidate,
  StatementImport,
  StatementLineRecord,
  StatementLineStatus,
} from "../../ports/IAccountingRecords.js";
import type { IAuditTrail } from "../../ports/IAuditTrail.js";
import type { IClock } from "../../ports/IClock.js";
import type { ILedger, LedgerAccount } from "../../ports/IFinanceRecords.js";
import type { IIdGenerator } from "../../ports/IIdGenerator.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import type { TenantCalendar } from "../../services/TenantCalendar.js";
import { recordUserAction } from "../reference/userAudit.js";
import type { LedgerPosting } from "./LedgerPosting.js";

const DAY_MS = 86_400_000;
const SAMPLE_LINES = 10;
/** The system accounts a statement can belong to; accounts the business added count too. */
const STATEMENT_KEYS: ReadonlySet<string> = new Set(["bank", "momo", "undeposited"]);
const STATEMENT_LINE_SOURCE = "statement_line";

export class StatementNotFoundError extends DomainError {
  readonly code = "STATEMENT_NOT_FOUND";
  constructor(what: string) {
    super(`This ${what} does not exist`);
  }
}

export type StatementImportRequest = Readonly<{
  accountId: string;
  fileName: string;
  rows: readonly (readonly string[])[];
  columns?: ColumnNames;
  dayFirst: boolean;
  commit: boolean;
}>;

export type StatementImportResult = Readonly<{
  committed: boolean;
  import: StatementImport | null;
  columns: ColumnNames;
  lines: number;
  duplicates: number;
  skipped: number;
  from: string | null;
  to: string | null;
  moneyIn: MoneyJson;
  moneyOut: MoneyJson;
  errors: readonly Readonly<{ row: number; message: string }>[];
  sample: readonly StatementLine[];
}>;

export type StatementLineView = Omit<StatementLineRecord, "amountMinor" | "balanceMinor"> &
  Readonly<{
    amount: MoneyJson;
    balance: MoneyJson | null;
    /** Likely ledger lines, for lines still unmatched. */
    suggestions: readonly LedgerLineView[];
  }>;

export type LedgerLineView = Omit<LedgerCandidate, "amountMinor" | "references"> &
  Readonly<{ amount: MoneyJson }>;

export type ReconciliationSummary = Readonly<{
  account: Readonly<{ id: string; code: string; name: string }>;
  asOf: string;
  ledgerBalance: MoneyJson;
  statementBalance: MoneyJson | null;
  firstStatementDate: string | null;
  /** On the statement, not in the books. */
  unmatchedStatement: Readonly<{ lines: number; in: MoneyJson; out: MoneyJson }>;
  /** Marked as needing no entry, which still moved the statement's balance. */
  ignored: Readonly<{ lines: number; amount: MoneyJson }>;
  /** In the books from the first statement on, not on a statement yet. */
  unmatchedLedger: Readonly<{ lines: number; in: MoneyJson; out: MoneyJson }>;
  matchedThenReversed: number;
  /** Books and unmatched statement lines against statement and unmatched ledger lines. */
  difference: MoneyJson | null;
  reconciled: boolean;
}>;

/**
 * Bank and mobile money reconciliation (docs/13 §4, decisions 512–514): statements imported as
 * CSV with lines seen before left out, matched to the unmatched ledger lines of their account
 * automatically and by hand. What the books lack (bank charges, cash or cheques banked) is posted
 * from the line, and the difference between statement and books is shown.
 */
export class BankReconciliation {
  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      reconciliation: IReconciliation;
      ledger: ILedger;
      posting: LedgerPosting;
      calendar: TenantCalendar;
      auditTrail: IAuditTrail;
      requestContext: IRequestContext;
      ids: IIdGenerator;
      clock: IClock;
    }>,
  ) {}

  private async statementAccount(id: string): Promise<LedgerAccount> {
    const account = (await this.deps.ledger.accounts()).find((a) => a.id === id);
    if (account === undefined) throw new StatementNotFoundError("account");
    if (
      !account.active ||
      account.type !== "asset" ||
      (account.systemKey !== null && !STATEMENT_KEYS.has(account.systemKey))
    )
      throw new FinanceRuleError(`${account.name} is not a bank or mobile money account`);
    return account;
  }

  private money(minor: number, currency: string): MoneyJson {
    return Money.ofMinor(minor, currency).toJSON();
  }

  /** Without commit, shows what the file holds; with it, all lines go in and are matched. */
  importStatement(actor: Principal, input: StatementImportRequest): Promise<StatementImportResult> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const account = await this.statementAccount(input.accountId);
      const currency = await deps.posting.baseCurrency();
      const parsed = parseStatement(input.rows, {
        currency,
        dayFirst: input.dayFirst,
        ...(input.columns === undefined ? {} : { columns: input.columns }),
      });
      await deps.reconciliation.lockAccount(account.id);
      const seen = new Map<string, number>();
      const fingerprinted = parsed.lines.map((line) => {
        const base = statementLineKey(line, 0);
        const occurrence = seen.get(base) ?? 0;
        seen.set(base, occurrence + 1);
        const key = statementLineKey(line, occurrence);
        return { line, fingerprint: createHash("sha256").update(key).digest("hex") };
      });
      const known = await deps.reconciliation.knownFingerprints(
        account.id,
        fingerprinted.map((f) => f.fingerprint),
      );
      const fresh = fingerprinted.filter((f) => !known.has(f.fingerprint));
      const amounts = fresh.map((f) => f.line.amountMinor);
      const dates = parsed.lines.map((l) => l.date).sort();
      const from = dates[0] ?? null;
      const to = dates.at(-1) ?? null;
      const preview = {
        columns: parsed.columns,
        lines: fresh.length,
        duplicates: known.size,
        skipped: parsed.skipped,
        from,
        to,
        moneyIn: this.money(
          amounts.filter((a) => a > 0).reduce((sum, a) => sum + a, 0),
          currency,
        ),
        moneyOut: this.money(
          -amounts.filter((a) => a < 0).reduce((sum, a) => sum + a, 0),
          currency,
        ),
        errors: parsed.errors,
        sample: fresh.slice(0, SAMPLE_LINES).map((f) => f.line),
      };
      if (!input.commit) return { committed: false, import: null, ...preview };
      if (parsed.errors.length > 0)
        throw new FinanceRuleError(`${parsed.errors.length} rows could not be read`);
      if (fresh.length === 0 || from === null || to === null)
        throw new FinanceRuleError("This statement has no new lines");
      const importId = deps.ids.next();
      const now = deps.clock.now();
      const entry = {
        id: importId,
        accountId: account.id,
        fileName: input.fileName,
        from,
        to,
        lines: fresh.length,
        duplicates: known.size,
        autoMatched: 0,
        importedBy: actor.userId,
        importedAt: now,
      };
      await deps.reconciliation.addImport(entry);
      await deps.reconciliation.addLines(
        fresh.map(({ line, fingerprint }, index) => ({
          id: deps.ids.next(),
          importId,
          accountId: account.id,
          lineNo: index + 1,
          date: line.date,
          description: line.description,
          reference: line.reference,
          amountMinor: line.amountMinor,
          balanceMinor: line.balanceMinor,
          fingerprint,
        })),
      );
      const autoMatched = await this.matchAutomatically(account.id);
      await deps.reconciliation.setAutoMatched(importId, autoMatched);
      await recordUserAction(deps, actor.userId, {
        action: "statement.imported",
        entityType: "statement_import",
        entityId: importId,
        after: { accountId: account.id, lines: fresh.length, autoMatched },
      });
      return {
        committed: true,
        import: { ...entry, autoMatched, status: "active" as const },
        ...preview,
      };
    });
  }

  private async matchAutomatically(accountId: string): Promise<number> {
    const { reconciliation } = this.deps;
    const lines = await reconciliation.unmatched(accountId);
    const first = lines[0];
    const last = lines.at(-1);
    if (first === undefined || last === undefined) return 0;
    const candidates = await reconciliation.candidates(
      accountId,
      shiftDay(first.date, -REFERENCE_DAYS),
      shiftDay(last.date, REFERENCE_DAYS),
    );
    const matches = autoMatch(lines, candidates);
    const now = this.deps.clock.now();
    for (const match of matches)
      await reconciliation.match(
        match.statementLineId,
        [match.ledgerLineId],
        "auto",
        null,
        null,
        now,
      );
    return matches.length;
  }

  /** Matches again, for payments recorded after the statement came in. */
  rerunAutoMatch(actor: Principal, accountId: string): Promise<Readonly<{ matched: number }>> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const account = await this.statementAccount(accountId);
      await deps.reconciliation.lockAccount(account.id);
      const matched = await this.matchAutomatically(account.id);
      await recordUserAction(deps, actor.userId, {
        action: "statement.auto_matched",
        entityType: "ledger_account",
        entityId: account.id,
        after: { matched },
      });
      return { matched };
    });
  }

  imports(accountId: string | null, request: PageRequest): Promise<Page<StatementImport>> {
    return this.deps.unitOfWork.run(async () =>
      pageOf(request, await this.deps.reconciliation.imports(accountId, pageWindow(request))),
    );
  }

  /** Takes a file back with its matches, unless an entry was posted from one of its lines. */
  voidImport(actor: Principal, id: string): Promise<void> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const found = await deps.reconciliation.importById(id);
      if (found === null) throw new StatementNotFoundError("statement");
      await deps.reconciliation.lockAccount(found.accountId);
      if (found.status === "voided") throw new FinanceRuleError("This statement is already voided");
      if ((await deps.reconciliation.countPostedLines(id)) > 0)
        throw new FinanceRuleError("Undo the entries posted from this statement first");
      await deps.reconciliation.voidImport(id, actor.userId, deps.clock.now());
      await recordUserAction(deps, actor.userId, {
        action: "statement.voided",
        entityType: "statement_import",
        entityId: id,
        after: { accountId: found.accountId, lines: found.lines },
      });
    });
  }

  lines(
    query: Readonly<{
      accountId: string;
      status: StatementLineStatus;
      from?: string;
      to?: string;
      page: number;
      pageSize: number;
    }>,
  ): Promise<Page<StatementLineView>> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const currency = await deps.posting.baseCurrency();
      const found = await deps.reconciliation.lines({
        accountId: query.accountId,
        status: query.status,
        ...(query.from === undefined ? {} : { from: query.from }),
        ...(query.to === undefined ? {} : { to: query.to }),
        ...pageWindow(query),
      });
      const page = pageOf(query, found);
      const dates = page.items.map((l) => l.date).sort();
      const candidates =
        query.status === "unmatched" && dates.length > 0
          ? await deps.reconciliation.candidates(
              query.accountId,
              shiftDay(dates[0]!, -REFERENCE_DAYS),
              shiftDay(dates.at(-1)!, REFERENCE_DAYS),
            )
          : [];
      return {
        ...page,
        items: page.items.map(({ amountMinor, balanceMinor, ...line }) => ({
          ...line,
          amount: this.money(amountMinor, currency),
          balance: balanceMinor === null ? null : this.money(balanceMinor, currency),
          suggestions: (suggestions({ ...line, amountMinor }, candidates) as LedgerCandidate[]).map(
            (c) => this.ledgerView(c, currency),
          ),
        })),
      };
    });
  }

  private ledgerView(
    { amountMinor, references: _references, ...candidate }: LedgerCandidate,
    currency: string,
  ): LedgerLineView {
    return { ...candidate, amount: this.money(amountMinor, currency) };
  }

  /** The account's ledger lines not on a statement; reversed pairs only when asked. */
  ledgerLines(
    query: Readonly<{ accountId: string; from: string; to: string; includeCancelled: boolean }>,
  ): Promise<LedgerLineView[]> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const currency = await deps.posting.baseCurrency();
      const lines = await deps.reconciliation.candidates(query.accountId, query.from, query.to);
      return lines
        .filter((l) => query.includeCancelled || !l.cancelled)
        .map((l) => this.ledgerView(l, currency));
    });
  }

  private async lineToWork(id: string): Promise<StatementLineRecord> {
    const { reconciliation } = this.deps;
    const seen = await reconciliation.line(id);
    if (seen === null) throw new StatementNotFoundError("statement line");
    await reconciliation.lockAccount(seen.accountId);
    return (await reconciliation.line(id, true)) ?? seen;
  }

  private async openLine(id: string): Promise<StatementLineRecord> {
    const line = await this.lineToWork(id);
    if (line.status !== "unmatched")
      throw new FinanceRuleError(`This statement line is already ${line.status}`);
    return line;
  }

  /** A statement line for one ledger line or several (a banked batch) of the same total. */
  match(
    actor: Principal,
    statementLineId: string,
    ledgerLineIds: readonly string[],
  ): Promise<StatementLineRecord> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const line = await this.openLine(statementLineId);
      const ids = [...new Set(ledgerLineIds)];
      const found = await deps.reconciliation.candidatesByIds(line.accountId, ids);
      if (found.length !== ids.length)
        throw new FinanceRuleError(
          "A ledger line is not on this account or is matched to another statement line",
        );
      const total = found.reduce((sum, c) => sum + c.amountMinor, 0);
      if (total !== line.amountMinor)
        throw new FinanceRuleError("The ledger lines do not add up to the statement line");
      await deps.reconciliation.match(line.id, ids, "manual", null, actor.userId, deps.clock.now());
      await this.audit(actor, "statement_line.matched", line.id, { ledgerLineIds: ids });
      return (await deps.reconciliation.line(line.id))!;
    });
  }

  /** Marks a line as needing no entry, such as a bank's own error put right on the statement. */
  ignore(actor: Principal, id: string, note: string): Promise<StatementLineRecord> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const line = await this.openLine(id);
      await deps.reconciliation.ignore(line.id, note, actor.userId, deps.clock.now());
      await this.audit(actor, "statement_line.ignored", line.id, { note });
      return (await deps.reconciliation.line(line.id))!;
    });
  }

  /**
   * Posts what the books lack, on the line's date: bank charges and interest against an income or
   * expense account, cash or cheques banked against the account they left.
   */
  post(
    actor: Principal,
    id: string,
    input: Readonly<{ counterAccountId: string; description?: string }>,
  ): Promise<StatementLineRecord> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const line = await this.openLine(id);
      const counter = (await deps.ledger.accounts()).find((a) => a.id === input.counterAccountId);
      if (counter === undefined || !counter.active || counter.id === line.accountId)
        throw new FinanceRuleError("Choose another active account for the other side");
      const amount = Math.abs(line.amountMinor);
      const description = input.description?.trim() || line.description || "Statement line";
      const [into, out] =
        line.amountMinor > 0 ? [line.accountId, counter.id] : [counter.id, line.accountId];
      const memo = line.reference;
      const entryId = await deps.posting.post(
        journal({
          date: line.date,
          description: description.slice(0, 200),
          source: { type: STATEMENT_LINE_SOURCE, id: line.id },
          reversesId: null,
          lines: [
            debit(amount, { accountId: into, memo }),
            credit(amount, { accountId: out, memo }),
          ],
        }),
        actor.userId,
      );
      const ledgerLineId = await deps.reconciliation.ledgerLineOf(entryId, line.accountId);
      await deps.reconciliation.match(
        line.id,
        [ledgerLineId],
        "posted",
        entryId,
        actor.userId,
        deps.clock.now(),
      );
      await this.audit(actor, "statement_line.posted", line.id, {
        journalEntryId: entryId,
        counterAccountId: counter.id,
      });
      return (await deps.reconciliation.line(line.id))!;
    });
  }

  /** Back to unmatched; an entry posted from the line is reversed, in its period if still open. */
  unmatch(actor: Principal, id: string): Promise<StatementLineRecord> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const line = await this.lineToWork(id);
      if (line.status === "unmatched")
        throw new FinanceRuleError("This statement line is not matched");
      await deps.reconciliation.release(line.id);
      if (line.matchKind === "posted") {
        const locked = await deps.ledger.booksLockedUntil();
        const date =
          locked === null || line.date > locked ? line.date : await deps.calendar.today();
        await deps.posting.reverse(
          { type: STATEMENT_LINE_SOURCE, id: line.id },
          date,
          `Statement line entry undone`,
          actor.userId,
        );
      }
      await this.audit(actor, "statement_line.unmatched", line.id, { was: line.status });
      return (await deps.reconciliation.line(line.id))!;
    });
  }

  private audit(actor: Principal, action: string, id: string, after: Record<string, unknown>) {
    return recordUserAction(this.deps, actor.userId, {
      action,
      entityType: "statement_line",
      entityId: id,
      after,
    });
  }

  summary(accountId: string, asOf: string | null): Promise<ReconciliationSummary> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const account = await this.statementAccount(accountId);
      const currency = await deps.posting.baseCurrency();
      const date = asOf ?? (await deps.calendar.today());
      const balances = await deps.ledger.balances(date);
      const ledgerMinor = balances.find((b) => b.id === account.id)?.balanceMinor ?? 0;
      const f = await deps.reconciliation.figures(account.id, date);
      const m = (minor: number) => this.money(minor, currency);
      const statementSide =
        ledgerMinor + f.unmatchedStatementInMinor - f.unmatchedStatementOutMinor;
      const difference =
        f.statementBalanceMinor === null
          ? null
          : statementSide +
            f.ignoredMinor -
            (f.statementBalanceMinor + f.unmatchedLedgerInMinor - f.unmatchedLedgerOutMinor);
      return {
        account: { id: account.id, code: account.code, name: account.name },
        asOf: date,
        ledgerBalance: m(ledgerMinor),
        statementBalance: f.statementBalanceMinor === null ? null : m(f.statementBalanceMinor),
        firstStatementDate: f.firstStatementDate,
        unmatchedStatement: {
          lines: f.unmatchedStatementLines,
          in: m(f.unmatchedStatementInMinor),
          out: m(f.unmatchedStatementOutMinor),
        },
        ignored: { lines: f.ignoredLines, amount: m(f.ignoredMinor) },
        unmatchedLedger: {
          lines: f.unmatchedLedgerLines,
          in: m(f.unmatchedLedgerInMinor),
          out: m(f.unmatchedLedgerOutMinor),
        },
        matchedThenReversed: f.matchedThenReversed,
        difference: difference === null ? null : m(difference),
        reconciled:
          difference === 0 && f.unmatchedStatementLines === 0 && f.matchedThenReversed === 0,
      };
    });
  }
}

function shiftDay(day: string, by: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + by * DAY_MS).toISOString().slice(0, 10);
}
