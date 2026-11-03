import {
  summarise,
  type ExportDetail,
  type ExportFormat,
  type ExportTarget,
} from "../../../domain/finance/AccountingExport.js";
import { FinanceRuleError } from "../../../domain/finance/Journal.js";
import type { Principal } from "../../authorization/Principal.js";
import type {
  AccountingExportRecord,
  AccountMapping,
  IAccountingExports,
} from "../../ports/IAccountingRecords.js";
import type { IAuditTrail } from "../../ports/IAuditTrail.js";
import type { IClock } from "../../ports/IClock.js";
import type { ILedger } from "../../ports/IFinanceRecords.js";
import type { IIdGenerator } from "../../ports/IIdGenerator.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import { accountingFile } from "../../services/AccountingFiles.js";
import { recordUserAction } from "../reference/userAudit.js";
import type { LedgerPosting } from "./LedgerPosting.js";

const DAY_MS = 86_400_000;
const MAX_DAYS = 366;
const MAX_LINES = 200_000;
const DEFAULT_XERO_TAX_RATE = "Tax Exempt";

export type ExportRequest = Readonly<{
  format: ExportFormat;
  detail: ExportDetail;
  from: string;
  to: string;
  xeroTaxRate?: string;
}>;

export type ExportFile = Readonly<{
  name: string;
  text: string;
  lines: number;
  /** Earlier exports in this format overlapping the period: importing again would double them. */
  overlaps: number;
}>;

/**
 * The books for an accounting package (docs/13 §2.4, decisions 510–511): journals as QuickBooks
 * Online or Xero import them, or plain CSV, line by line or summed per day or month, with
 * accounts under the package's own names. Every export is kept, to tell one taken twice and a
 * period that has changed since.
 */
export class AccountingExports {
  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      exports: IAccountingExports;
      ledger: ILedger;
      posting: LedgerPosting;
      auditTrail: IAuditTrail;
      requestContext: IRequestContext;
      ids: IIdGenerator;
      clock: IClock;
    }>,
  ) {}

  export(actor: Principal, request: ExportRequest): Promise<ExportFile> {
    const { deps } = this;
    const { format, detail, from, to } = request;
    const days = (Date.parse(to) - Date.parse(from)) / DAY_MS + 1;
    if (days < 1) throw new FinanceRuleError("The end is before the start");
    if (days > MAX_DAYS) throw new FinanceRuleError(`An export covers at most ${MAX_DAYS} days`);
    return deps.unitOfWork.run(async () => {
      const posted = await deps.exports.lines(from, to, MAX_LINES + 1);
      if (posted.length === 0) throw new FinanceRuleError("Nothing was posted in this period");
      if (posted.length > MAX_LINES)
        throw new FinanceRuleError(`Over ${MAX_LINES} lines: export a shorter period`);
      const lines = summarise(posted, detail);
      const totalDebitMinor = lines.reduce((sum, l) => sum + l.debitMinor, 0);
      const totalCreditMinor = lines.reduce((sum, l) => sum + l.creditMinor, 0);
      if (totalDebitMinor !== totalCreditMinor)
        throw new Error(`Export of ${from} to ${to} does not balance`);
      const mapped =
        format === "csv" ? [] : await deps.exports.mappings(format satisfies ExportTarget);
      const external = new Map(mapped.map((m) => [m.accountId, m.external]));
      const text = accountingFile(format, lines, {
        currency: await deps.posting.baseCurrency(),
        external: (accountId) => external.get(accountId) ?? null,
        xeroTaxRate: request.xeroTaxRate ?? DEFAULT_XERO_TAX_RATE,
      });
      const overlaps = await deps.exports.overlaps(format, from, to);
      const id = deps.ids.next();
      const entries = new Set(posted.map((l) => l.journalNumber)).size;
      await deps.exports.record({
        id,
        format,
        detail,
        from,
        to,
        entries,
        lines: lines.length,
        totalDebitMinor,
        exportedBy: actor.userId,
        exportedAt: deps.clock.now(),
      });
      await recordUserAction(deps, actor.userId, {
        action: "accounting.exported",
        entityType: "accounting_export",
        entityId: id,
        after: { format, detail, from, to, entries, lines: lines.length, overlaps },
      });
      return { name: `journals-${format}-${from}-${to}.csv`, text, lines: lines.length, overlaps };
    });
  }

  history(limit: number): Promise<AccountingExportRecord[]> {
    return this.deps.unitOfWork.run(() => this.deps.exports.history(limit));
  }

  mappings(target: ExportTarget): Promise<AccountMapping[]> {
    return this.deps.unitOfWork.run(() => this.deps.exports.mappings(target));
  }

  saveMappings(
    actor: Principal,
    target: ExportTarget,
    mappings: readonly Readonly<{ accountId: string; external: string | null }>[],
  ): Promise<AccountMapping[]> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const known = new Set((await deps.ledger.accounts()).map((a) => a.id));
      const unknown = mappings.find((m) => !known.has(m.accountId));
      if (unknown !== undefined)
        throw new FinanceRuleError(`Account ${unknown.accountId} does not exist`);
      await deps.exports.saveMappings(target, mappings, actor.userId, deps.clock.now());
      await recordUserAction(deps, actor.userId, {
        action: "accounting.mappings_changed",
        entityType: "accounting_mapping",
        entityId: actor.userId,
        after: { target, mappings },
      });
      return deps.exports.mappings(target);
    });
  }
}
