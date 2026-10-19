import { CashSession, type CashSessionProps } from "../../../domain/finance/CashSession.js";
import { FinanceRuleError } from "../../../domain/finance/Journal.js";
import { Postings } from "../../../domain/finance/Postings.js";
import { Money, type MoneyJson } from "../../../domain/money/Money.js";
import type { ICashSessionRepository } from "../../../domain/repositories/IFinanceRepositories.js";
import type { Principal } from "../../authorization/Principal.js";
import { CashSessionNotFoundError } from "../../errors/FinanceErrors.js";
import type { IAuditTrail } from "../../ports/IAuditTrail.js";
import type { IClock } from "../../ports/IClock.js";
import type { CashSessionListFilter, IFinanceQueries } from "../../ports/IFinanceRecords.js";
import type { IIdGenerator } from "../../ports/IIdGenerator.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import type { BranchScope } from "../../services/BranchScope.js";
import type { TenantCalendar } from "../../services/TenantCalendar.js";
import { recordUserAction } from "../reference/userAudit.js";
import type { LedgerPosting } from "./LedgerPosting.js";

export type CashSessionView = Omit<
  CashSessionProps,
  "openingFloatMinor" | "cashInMinor" | "cashOutMinor" | "countedMinor" | "varianceMinor"
> &
  Readonly<{
    openingFloat: MoneyJson;
    cashIn: MoneyJson;
    cashOut: MoneyJson;
    expected: MoneyJson;
    counted: MoneyJson | null;
    variance: MoneyJson | null;
  }>;

/**
 * Cash sessions (docs/13 §4): a cashier opens a till with a float, cash payments they record go
 * through it, and at the end the cash is counted; the variance against what is expected is
 * posted to cash over and short. One open session per cashier. Supervisors (`…view`) see all
 * sessions of their branches and can close them.
 */
export class CashSessions {
  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      sessions: ICashSessionRepository;
      queries: IFinanceQueries;
      posting: LedgerPosting;
      scope: BranchScope;
      calendar: TenantCalendar;
      auditTrail: IAuditTrail;
      requestContext: IRequestContext;
      ids: IIdGenerator;
      clock: IClock;
    }>,
  ) {}

  async open(
    actor: Principal,
    input: Readonly<{ branchId?: string; float: string }>,
  ): Promise<CashSessionView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const branchId =
        input.branchId ??
        (await deps.scope.defaultBranch(actor, "finance.cash_sessions.manage", "cash session"));
      await deps.scope.branch(actor, "finance.cash_sessions.manage", branchId);
      if ((await deps.sessions.lockOpenFor(actor.userId)) !== null)
        throw new FinanceRuleError("Close your open cash session first");
      const base = await deps.posting.baseCurrency();
      const session = CashSession.open({
        id: deps.ids.next(),
        branchId,
        cashierId: actor.userId,
        floatMinor: Money.parse(input.float, base).amountMinor,
        now: deps.clock.now(),
      });
      await deps.sessions.save(session);
      await this.audit(actor, "cash_session.opened", session);
      return view(session.snapshot(), base);
    });
  }

  /** The caller's open session, if any. */
  async current(actor: Principal): Promise<CashSessionView | null> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const session = await deps.sessions.lockOpenFor(actor.userId);
      return session === null ? null : view(session.snapshot(), await deps.posting.baseCurrency());
    });
  }

  async list(
    actor: Principal,
    filter: Omit<CashSessionListFilter, "branchIds">,
  ): Promise<CashSessionView[]> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const all = deps.scope.branchesFor(actor, "finance.cash_sessions.view");
      const own = all !== "all" && all.length === 0;
      const rows = await deps.queries.cashSessions({
        ...filter,
        branchIds: own ? "all" : all,
        // Without supervision rights: your own sessions only.
        ...(own ? { cashierId: actor.userId } : {}),
      });
      const base = await deps.posting.baseCurrency();
      return rows.map((s) => view(s, base));
    });
  }

  async get(actor: Principal, id: string): Promise<CashSessionView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const session = await this.reach(actor, id, false);
      return view(session.snapshot(), await deps.posting.baseCurrency());
    });
  }

  async close(
    actor: Principal,
    id: string,
    input: Readonly<{ counted: string; notes?: string | null }>,
  ): Promise<CashSessionView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const session = await this.reach(actor, id, true);
      const base = await deps.posting.baseCurrency();
      const variance = session.close(
        Money.parse(input.counted, base).amountMinor,
        actor.userId,
        input.notes ?? null,
        deps.clock.now(),
      );
      await deps.sessions.save(session);
      const entry = Postings.cashVariance(
        session,
        await deps.posting.accounts(),
        await deps.calendar.today(),
      );
      if (entry !== null) await deps.posting.post(entry, actor.userId);
      await this.audit(actor, "cash_session.closed", session, { varianceMinor: variance });
      return view(session.snapshot(), base);
    });
  }

  /** Your own session, or any session of a branch you supervise. */
  private async reach(actor: Principal, id: string, lock: boolean): Promise<CashSession> {
    const { deps } = this;
    const session = lock ? await deps.sessions.lockById(id) : await deps.sessions.findById(id);
    if (session === null) throw new CashSessionNotFoundError();
    const s = session.snapshot();
    if (s.cashierId === actor.userId) return session;
    await deps.scope.assertReaches(
      actor,
      "finance.cash_sessions.view",
      s.branchId,
      () => new CashSessionNotFoundError(),
    );
    return session;
  }

  private async audit(
    actor: Principal,
    action: string,
    session: CashSession,
    metadata?: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    const s = session.snapshot();
    await recordUserAction(this.deps, actor.userId, {
      action,
      entityType: "cash_session",
      entityId: s.id,
      after: {
        branchId: s.branchId,
        cashierId: s.cashierId,
        status: s.status,
        openingFloatMinor: s.openingFloatMinor,
        countedMinor: s.countedMinor,
      },
      ...(metadata === undefined ? {} : { metadata }),
    });
  }
}

function view(s: CashSessionProps, base: string): CashSessionView {
  const m = (minor: number) => Money.ofMinor(minor, base).toJSON();
  const { openingFloatMinor, cashInMinor, cashOutMinor, countedMinor, varianceMinor, ...rest } = s;
  return {
    ...rest,
    openingFloat: m(openingFloatMinor),
    cashIn: m(cashInMinor),
    cashOut: m(cashOutMinor),
    expected: m(openingFloatMinor + cashInMinor - cashOutMinor),
    counted: countedMinor === null ? null : m(countedMinor),
    variance: varianceMinor === null ? null : m(varianceMinor),
  };
}
