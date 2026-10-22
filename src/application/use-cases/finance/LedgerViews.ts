import type { IIntegrityChecks, IntegrityCheck } from "../../ports/IIntegrityChecks.js";
import {
  FinanceRuleError,
  type AccountType,
  type LedgerPartyType,
} from "../../../domain/finance/Journal.js";
import { Money, type MoneyJson } from "../../../domain/money/Money.js";
import type { Principal } from "../../authorization/Principal.js";
import type { Page } from "../../dto/Page.js";
import type { IAuditTrail } from "../../ports/IAuditTrail.js";
import type {
  ILedger,
  LedgerAccount,
  LedgerLineFilter,
  LedgerLineView,
} from "../../ports/IFinanceRecords.js";
import type { IIdGenerator } from "../../ports/IIdGenerator.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import { PageCursor } from "../../services/PageCursor.js";
import type { TenantCalendar } from "../../services/TenantCalendar.js";
import { recordUserAction } from "../reference/userAudit.js";
import type { FinanceContext } from "./FinanceContext.js";
import type { LedgerPosting } from "./LedgerPosting.js";

export type AccountBalanceView = LedgerAccount &
  Readonly<{ debit: MoneyJson; credit: MoneyJson; balance: MoneyJson }>;

export type TrialBalance = Readonly<{
  asOf: string;
  accounts: readonly AccountBalanceView[];
  totalDebit: MoneyJson;
  totalCredit: MoneyJson;
  balanced: boolean;
}>;

export type PartyAccount = Readonly<{
  party: Readonly<{ type: LedgerPartyType; id: string; name: string }>;
  /** Unallocated money the party paid (usable on later invoices or refunded). */
  credit: MoneyJson;
  /** What the party owes on issued invoices. */
  receivable: MoneyJson;
  /** Receivable minus credit: positive, they owe; negative, the business owes them. */
  net: MoneyJson;
}>;

export type LedgerLineQuery = Omit<LedgerLineFilter, "after" | "limit"> &
  Readonly<{ limit: number; cursor?: string }>;

/**
 * The accounting view (docs/13 §2.4, §7): chart of accounts with balances, trial balance,
 * ledger lines by account, vehicle, branch or party, a party's account (credit and what they
 * owe), and the period lock.
 */
export class LedgerViews {
  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      ledger: ILedger;
      posting: LedgerPosting;
      context: FinanceContext;
      calendar: TenantCalendar;
      auditTrail: IAuditTrail;
      requestContext: IRequestContext;
      ids: IIdGenerator;
      integrity: IIntegrityChecks;
    }>,
  ) {}

  /** The invariants of the books (docs/26 §7): run any time, and after every restore. */
  async integrity(): Promise<
    Readonly<{ checkedAt: Date; passed: boolean; checks: readonly IntegrityCheck[] }>
  > {
    return this.deps.unitOfWork.run(async () => {
      const checks = await this.deps.integrity.run();
      return { checkedAt: new Date(), passed: checks.every((c) => c.passed), checks };
    });
  }

  async accounts(): Promise<readonly AccountBalanceView[]> {
    return (await this.trialBalance(null)).accounts;
  }

  async createAccount(
    actor: Principal,
    input: Readonly<{ code: string; name: string; type: AccountType }>,
  ): Promise<LedgerAccount> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      if (!/^[0-9]{3,6}$/.test(input.code))
        throw new FinanceRuleError("Account codes are 3 to 6 digits");
      if (await deps.ledger.accountCodeTaken(input.code))
        throw new FinanceRuleError(`Account ${input.code} already exists`);
      const account = {
        id: deps.ids.next(),
        code: input.code,
        name: input.name.trim(),
        type: input.type,
      };
      await deps.ledger.createAccount(account);
      await recordUserAction(deps, actor.userId, {
        action: "ledger_account.created",
        entityType: "ledger_account",
        entityId: account.id,
        after: account,
      });
      return { ...account, systemKey: null, active: true };
    });
  }

  async trialBalance(asOf: string | null): Promise<TrialBalance> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const base = await deps.posting.baseCurrency();
      const m = (minor: number) => Money.ofMinor(minor, base).toJSON();
      const balances = await deps.ledger.balances(asOf);
      const totalDebit = balances.reduce((sum, b) => sum + b.debitMinor, 0);
      const totalCredit = balances.reduce((sum, b) => sum + b.creditMinor, 0);
      return {
        asOf: asOf ?? (await deps.calendar.today()),
        accounts: balances.map(({ debitMinor, creditMinor, balanceMinor, ...account }) => ({
          ...account,
          debit: m(debitMinor),
          credit: m(creditMinor),
          balance: m(balanceMinor),
        })),
        totalDebit: m(totalDebit),
        totalCredit: m(totalCredit),
        balanced: totalDebit === totalCredit,
      };
    });
  }

  async lines(query: LedgerLineQuery): Promise<Page<LedgerLineView>> {
    const { deps } = this;
    const after = query.cursor === undefined ? undefined : PageCursor.parse(query.cursor, 3).values;
    return deps.unitOfWork.run(async () => {
      const rows = await deps.ledger.lines({
        ...query,
        limit: query.limit + 1,
        ...(after === undefined
          ? {}
          : {
              after: { date: String(after[0]), createdAt: String(after[1]), id: String(after[2]) },
            }),
      });
      return PageCursor.paginate(rows, query.limit, (l) => [
        l.date,
        l.createdAt.toISOString(),
        l.id,
      ]);
    });
  }

  async partyAccount(type: LedgerPartyType, id: string): Promise<PartyAccount> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const party = await deps.context.party(type, id);
      const accounts = await deps.posting.accounts();
      const base = await deps.posting.baseCurrency();
      const credit = -(await deps.ledger.partyBalance(accounts("party_credit"), { type, id }));
      const receivable = await deps.ledger.partyBalance(accounts("receivables"), { type, id });
      const m = (minor: number) => Money.ofMinor(minor, base).toJSON();
      return {
        party: { type, id, name: party.name },
        credit: m(credit),
        receivable: m(receivable),
        net: m(receivable - credit),
      };
    });
  }

  async periodLock(): Promise<Readonly<{ lockedUntil: string | null }>> {
    return {
      lockedUntil: await this.deps.unitOfWork.run(() => this.deps.ledger.booksLockedUntil()),
    };
  }

  /** Locks (or with null unlocks) the books up to a date, never into the future. */
  async setPeriodLock(
    actor: Principal,
    lockedUntil: string | null,
    reason: string,
  ): Promise<Readonly<{ lockedUntil: string | null }>> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      if (reason.trim().length < 3) throw new FinanceRuleError("Give a reason");
      if (lockedUntil !== null && lockedUntil >= (await deps.calendar.today()))
        throw new FinanceRuleError("Lock a period that has ended (up to yesterday)");
      const before = await deps.ledger.booksLockedUntil();
      await deps.ledger.setBooksLockedUntil(lockedUntil);
      await recordUserAction(deps, actor.userId, {
        action: "finance.period_lock_changed",
        entityType: "organisation",
        before: { lockedUntil: before },
        after: { lockedUntil },
        metadata: { reason },
      });
      return { lockedUntil };
    });
  }
}
