import { FinanceRuleError } from "../../../domain/finance/Journal.js";
import { Postings } from "../../../domain/finance/Postings.js";
import { Money, type MoneyJson } from "../../../domain/money/Money.js";
import {
  ageShortfalls,
  Remittance,
  type ShortfallAgeing,
} from "../../../domain/remittances/Remittance.js";
import type { Principal } from "../../authorization/Principal.js";
import type { IAuditTrail } from "../../ports/IAuditTrail.js";
import type { IClock } from "../../ports/IClock.js";
import type { ILedger, LedgerLineView } from "../../ports/IFinanceRecords.js";
import type { IIdGenerator } from "../../ports/IIdGenerator.js";
import type { IRemittanceRecords } from "../../ports/IRemittanceRecords.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import type { TenantCalendar } from "../../services/TenantCalendar.js";
import type { LedgerPosting } from "../finance/LedgerPosting.js";
import type { DriverAdministration } from "../parties/DriverAdministration.js";
import { recordUserAction } from "../reference/userAudit.js";

export type StatementLine = Readonly<{
  date: string;
  number: string;
  description: string;
  sourceType: string;
  sourceId: string;
  /** Increases what the driver owes. */
  charge: MoneyJson | null;
  /** Reduces it (payments, bonuses, waivers). */
  credit: MoneyJson | null;
  balance: MoneyJson;
}>;

export type DriverStatement = Readonly<{
  driver: Readonly<{ id: string; code: string; name: string }>;
  from: string;
  to: string;
  opening: MoneyJson;
  lines: readonly StatementLine[];
  /** Positive: the driver owes the business; negative: the business owes the driver. */
  closing: MoneyJson;
  shortfalls: Readonly<{
    periods: number;
    total: MoneyJson;
    ageing: Readonly<Record<keyof ShortfallAgeing, MoneyJson>>;
  }>;
}>;

const MAX_LINES = 2_000;

/**
 * The driver ledger (docs/09 §3): one running account per driver over what they owe
 * (remittance targets, invoices, deductions, advances) and what they paid or are owed (payments,
 * bonuses, expenses they paid out of pocket). Statements with opening and closing balance,
 * shortfall ageing, and adjustments.
 */
export class DriverLedger {
  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      ledger: ILedger;
      records: IRemittanceRecords;
      drivers: DriverAdministration;
      posting: LedgerPosting;
      calendar: TenantCalendar;
      auditTrail: IAuditTrail;
      requestContext: IRequestContext;
      ids: IIdGenerator;
      clock: IClock;
    }>,
  ) {}

  async statement(
    actor: Principal,
    driverId: string,
    period: Readonly<{ from?: string; to?: string }>,
  ): Promise<DriverStatement> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const driver = (await deps.drivers.reach(actor, driverId, "drivers.ledger.view")).snapshot();
      const today = await deps.calendar.today();
      const to = period.to ?? today;
      const from = period.from ?? `${to.slice(0, 7)}-01`;
      const base = await deps.posting.baseCurrency();
      const m = (minor: number) => Money.ofMinor(minor, base).toJSON();
      const accountIds = await this.accountIds();
      const party = { type: "driver" as const, id: driverId };
      const opening = await deps.ledger.partyNet(accountIds, party, from);
      const rows: LedgerLineView[] = await deps.ledger.lines({
        accountIds,
        party,
        from,
        to,
        limit: MAX_LINES,
      });
      let balance = opening;
      const lines = [...rows].reverse().map((l): StatementLine => {
        balance += l.debitMinor - l.creditMinor;
        return {
          date: l.date,
          number: l.number,
          description: l.description,
          sourceType: l.sourceType,
          sourceId: l.sourceId,
          charge: l.debitMinor > 0 ? m(l.debitMinor) : null,
          credit: l.creditMinor > 0 ? m(l.creditMinor) : null,
          balance: m(balance),
        };
      });
      const outstanding = (await deps.records.outstanding(driverId)).map((r) => ({
        periodEnd: r.periodEnd,
        outstandingMinor: Remittance.restore(r).outstandingMinor,
      }));
      const ageing = ageShortfalls(outstanding, today);
      return {
        driver: {
          id: driver.id,
          code: driver.code,
          name: `${driver.firstName} ${driver.lastName}`,
        },
        from,
        to,
        opening: m(opening),
        lines,
        closing: m(balance),
        shortfalls: {
          periods: outstanding.length,
          total: m(outstanding.reduce((sum, r) => sum + r.outstandingMinor, 0)),
          ageing: {
            days0to7: m(ageing.days0to7),
            days8to30: m(ageing.days8to30),
            over30: m(ageing.over30),
          },
        },
      };
    });
  }

  /** Charges the driver (deduction) or credits them (bonus), against an income or expense account. */
  async adjust(
    actor: Principal,
    driverId: string,
    input: Readonly<{
      kind: "deduction" | "bonus";
      amount: string;
      reason: string;
      accountId?: string;
      vehicleId?: string | null;
      date?: string;
    }>,
  ): Promise<DriverStatement> {
    const { deps } = this;
    await deps.unitOfWork.run(async () => {
      const driver = (
        await deps.drivers.reach(actor, driverId, "drivers.ledger.adjust")
      ).snapshot();
      const reason = input.reason.trim();
      if (reason.length < 3) throw new FinanceRuleError("Give a reason");
      const base = await deps.posting.baseCurrency();
      const amountMinor = Money.parse(input.amount, base).amountMinor;
      if (amountMinor <= 0) throw new FinanceRuleError("An adjustment is above zero");
      const accounts = await deps.posting.accounts();
      const accountId =
        input.accountId ?? accounts(input.kind === "deduction" ? "other_income" : "other_expenses");
      const account = (await deps.ledger.accounts()).find((a) => a.id === accountId);
      const expected = input.kind === "deduction" ? "income" : "expense";
      if (account?.type !== expected || !account.active)
        throw new FinanceRuleError(`A ${input.kind} goes to an active ${expected} account`);
      const id = deps.ids.next();
      await deps.posting.post(
        Postings.driverAdjustment(
          {
            id,
            driverId,
            kind: input.kind,
            amountMinor,
            accountId,
            branchId: driver.branchId,
            vehicleId: input.vehicleId ?? null,
            date: input.date ?? (await deps.calendar.today()),
            memo: reason,
          },
          accounts,
        ),
        actor.userId,
      );
      await recordUserAction(deps, actor.userId, {
        action: `driver.ledger_${input.kind}`,
        entityType: "driver",
        entityId: driverId,
        after: { adjustmentId: id, amountMinor, accountId },
        metadata: { reason },
      });
    });
    return this.statement(actor, driverId, {});
  }

  private async accountIds(): Promise<string[]> {
    const accounts = await this.deps.posting.accounts();
    return [
      accounts("driver_receivables"),
      accounts("receivables"),
      accounts("party_credit"),
      accounts("payables"),
    ];
  }
}
