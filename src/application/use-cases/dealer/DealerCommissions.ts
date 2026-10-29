import {
  Commission,
  CommissionPlan,
  CommissionRuleError,
  type CommissionBasis,
  type CommissionPlanProps,
  type CommissionProps,
  type CommissionShare,
  type CommissionStatus,
} from "../../../domain/dealer/Commission.js";
import type { Deal } from "../../../domain/dealer/Deal.js";
import { credit, debit } from "../../../domain/finance/Journal.js";
import { Money, type MoneyJson } from "../../../domain/money/Money.js";
import type { Principal } from "../../authorization/Principal.js";
import { ApplicationError } from "../../errors/ApplicationError.js";
import type { IAuditTrail } from "../../ports/IAuditTrail.js";
import type { IClock } from "../../ports/IClock.js";
import {
  COMMISSION_SOURCE,
  PAYOUT_SOURCE,
  type CommissionLine,
  type ICommissions,
  type PayoutRecord,
} from "../../ports/IDealerCommissions.js";
import type { IDeals } from "../../ports/IDealerDeals.js";
import type { IIdGenerator } from "../../ports/IIdGenerator.js";
import type { IRecipientDirectory } from "../../ports/INotifications.js";
import type { IOrganisationSettings } from "../../ports/IOrganisationSettings.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import type { BranchScope } from "../../services/BranchScope.js";
import type { TenantCalendar } from "../../services/TenantCalendar.js";
import type { LedgerPosting } from "../finance/LedgerPosting.js";
import type { DocumentNumbering } from "../reference/DocumentNumbering.js";
import { recordUserAction } from "../reference/userAudit.js";
import type { DealProfit } from "./DealProfit.js";

export class CommissionPlanNotFoundError extends ApplicationError {
  readonly code = "COMMISSION_PLAN_NOT_FOUND";
  constructor() {
    super("Commission plan not found");
  }
}

export class CommissionNotFoundError extends ApplicationError {
  readonly code = "COMMISSION_NOT_FOUND";
  constructor() {
    super("Commission not found");
  }
}

const MANAGE = "dealer.commissions.manage";
const VIEW = "dealer.commissions.view";
const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;
const PAYOUT_ACCOUNT = { cash: "cash", momo: "momo", bank_transfer: "bank" } as const;

export type PlanInput = Readonly<{
  name: string;
  basis: CommissionBasis;
  /** `percent` ("2.5") for percentage plans, `amount` ("500.00") for flat ones. */
  tiers: readonly Readonly<{ fromUnits: number; percent?: string; amount?: string }>[];
}>;

export type PlanView = Omit<CommissionPlanProps, "tiers"> &
  Readonly<{
    tiers: readonly Readonly<{
      fromUnits: number;
      percent: string | null;
      amount: MoneyJson | null;
    }>[];
  }>;

export type CommissionView = Omit<CommissionProps, "baseMinor" | "amountMinor"> &
  Readonly<{
    base: MoneyJson;
    amount: MoneyJson;
    dealNumber: string;
    vehicle: string;
    deliveredOn: string | null;
    userName: string;
  }>;

export type PayoutView = Omit<PayoutRecord, "amountMinor"> & Readonly<{ amount: MoneyJson }>;

type StatementTotals = Readonly<{
  /** Earned in the month and not clawed back, less clawbacks of paid commissions. */
  earned: MoneyJson;
  accrued: MoneyJson;
  payable: MoneyJson;
  paid: MoneyJson;
  clawedBack: MoneyJson;
}>;

export type CommissionStatement = Readonly<{
  period: string;
  userId: string | null;
  totals: StatementTotals;
  /** Commissions per seller (docs/14): vehicles earned on and not clawed back, and the totals. */
  bySeller: readonly (StatementTotals &
    Readonly<{ userId: string; userName: string; units: number }>)[];
  commissions: readonly CommissionView[];
  payouts: readonly PayoutView[];
}>;

type Deps = Readonly<{
  unitOfWork: IUnitOfWork;
  commissions: ICommissions;
  deals: IDeals;
  profit: DealProfit;
  posting: LedgerPosting;
  recipients: IRecipientDirectory;
  organisation: IOrganisationSettings;
  scope: BranchScope;
  numbering: DocumentNumbering;
  calendar: TenantCalendar;
  auditTrail: IAuditTrail;
  requestContext: IRequestContext;
  ids: IIdGenerator;
  clock: IClock;
}>;

/**
 * Sales commissions (docs/10 §8, decisions 455–458): plans by seller or for everyone, a sale's
 * commission shared between sellers, accrued at delivery (Dr 5200 Sales commissions, Cr 2400
 * Commissions payable), payable once the sale is paid in full, paid out per seller and month, and
 * clawed back; the monthly statement per seller.
 */
export class DealerCommissions {
  constructor(private readonly deps: Deps) {}

  plans(actor: Principal): Promise<PlanView[]> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      this.requireManage(actor);
      const base = await this.base();
      return (await deps.commissions.plans(false)).map((p) => planView(p, base));
    });
  }

  createPlan(
    actor: Principal,
    input: PlanInput & Readonly<{ userId: string | null }>,
  ): Promise<PlanView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      this.requireManage(actor);
      const current =
        input.userId === null
          ? (await deps.commissions.plans(true)).find((p) => p.snapshot().userId === null)
          : await deps.commissions.planFor(input.userId);
      if (current !== undefined && current !== null && current.snapshot().userId === input.userId)
        throw new CommissionRuleError(
          input.userId === null
            ? "There is a plan for everyone already: retire it first"
            : "The seller has a plan already: retire it first",
        );
      if (input.userId !== null && (await deps.recipients.users([input.userId])).length === 0)
        throw new CommissionRuleError("The seller was not found");
      const base = await this.base();
      const plan = CommissionPlan.define({
        id: deps.ids.next(),
        name: input.name,
        userId: input.userId,
        basis: input.basis,
        tiers: tiers(input, base),
        createdBy: actor.userId,
        now: deps.clock.now(),
      });
      await deps.commissions.insertPlan(plan);
      await this.audit(actor.userId, "commission_plan.created", "dealer_commission_plan", plan.id, {
        name: plan.snapshot().name,
      });
      return planView(plan, base);
    });
  }

  revisePlan(actor: Principal, id: string, input: PlanInput): Promise<PlanView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      this.requireManage(actor);
      const plan = await deps.commissions.plan(id);
      if (plan === null) throw new CommissionPlanNotFoundError();
      const base = await this.base();
      plan.revise(
        { name: input.name, basis: input.basis, tiers: tiers(input, base) },
        deps.clock.now(),
      );
      await deps.commissions.updatePlan(plan);
      await this.audit(actor.userId, "commission_plan.revised", "dealer_commission_plan", id, {});
      return planView(plan, base);
    });
  }

  retirePlan(actor: Principal, id: string): Promise<PlanView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      this.requireManage(actor);
      const plan = await deps.commissions.plan(id);
      if (plan === null) throw new CommissionPlanNotFoundError();
      plan.retire(deps.clock.now());
      await deps.commissions.updatePlan(plan);
      await this.audit(actor.userId, "commission_plan.retired", "dealer_commission_plan", id, {});
      return planView(plan, await this.base());
    });
  }

  /** Validates a split before a deal takes it: sellers in the deal's branch. */
  async checkSplit(branchId: string, split: readonly CommissionShare[]): Promise<void> {
    const sellers = new Set(
      (await this.deps.recipients.staffWith("dealer.deals.create", branchId)).map((s) => s.userId),
    );
    for (const s of split)
      if (!sellers.has(s.userId))
        throw new CommissionRuleError("Everyone sharing the commission makes sales in the branch");
  }

  /**
   * The commission on a delivered vehicle, for each seller with a plan (inside the delivery's unit
   * of work): the tier of their vehicles this month, on the gross profit before commission or
   * the price, times their share; payable at once when the sale is already paid in full.
   */
  async accrue(
    actor: Principal,
    deal: Deal,
    deliveredOn: string,
    paidInFull: boolean,
  ): Promise<void> {
    const { deps } = this;
    const d = deal.snapshot();
    const profit = await deps.profit.of(d);
    if (profit === null) return;
    const accounts = await deps.posting.accounts();
    const period = deliveredOn.slice(0, 7);
    const now = deps.clock.now();
    for (const share of deal.commissionShares()) {
      const plan = await deps.commissions.planFor(share.userId);
      if (plan === null) continue;
      const units = (await deps.commissions.unitsIn(share.userId, period)) + 1;
      const earned = plan.earn(
        {
          grossProfitMinor: profit.beforeCommissionMinor,
          priceMinor: d.priceMinor - d.discountMinor,
        },
        units,
        share.percent,
      );
      if (earned.amountMinor === 0) continue;
      const commission = Commission.accrue({
        id: deps.ids.next(),
        dealId: d.id,
        userId: share.userId,
        branchId: d.branchId,
        planId: plan.id,
        basis: plan.snapshot().basis,
        rate: earned.rate,
        baseMinor: earned.baseMinor,
        sharePercent: share.percent,
        amountMinor: earned.amountMinor,
        accruedOn: deliveredOn,
        now,
      });
      if (paidInFull) commission.makePayable(deliveredOn, now);
      await deps.commissions.insert(commission);
      const tags = { branchId: d.branchId, vehicleId: d.vehicleId };
      await deps.posting.post(
        {
          date: deliveredOn,
          description: `Commission on sale ${d.number}`,
          source: { type: COMMISSION_SOURCE, id: commission.id },
          lines: [
            debit(earned.amountMinor, { accountId: accounts("sales_commissions"), ...tags }),
            credit(earned.amountMinor, { accountId: accounts("commissions_payable"), ...tags }),
          ],
          reversesId: null,
        },
        actor.userId,
      );
    }
  }

  /** Accrued commissions whose sale is now paid in full become payable (the daily job). */
  async refresh(today: string): Promise<number> {
    const { deps } = this;
    let made = 0;
    for (const id of await deps.commissions.paidUp()) {
      const commission = await deps.commissions.lock(id);
      if (commission?.makePayable(today, deps.clock.now()) !== true) continue;
      await deps.commissions.update(commission);
      made += 1;
    }
    return made;
  }

  /** A seller's month: their commissions with the sale, what is due and paid, and the payouts. */
  statement(
    actor: Principal,
    query: Readonly<{ period: string; userId?: string }>,
  ): Promise<CommissionStatement> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      if (!PERIOD.test(query.period)) throw new CommissionRuleError("A period is a month: YYYY-MM");
      const own = actor.grantFor(VIEW)?.scope === "own";
      const userId = own ? actor.userId : query.userId;
      const branchIds = own ? "all" : deps.scope.branchesFor(actor, VIEW);
      await this.refresh(await deps.calendar.today());
      const lines = await deps.commissions.list({
        branchIds,
        period: query.period,
        ...(userId === undefined ? {} : { userId }),
      });
      const payouts = await deps.commissions.payouts({
        branchIds,
        period: query.period,
        ...(userId === undefined ? {} : { userId }),
      });
      const base = await this.base();
      const m = (minor: number) => Money.ofMinor(minor, base).toJSON();
      const by = (status: CommissionStatus) => (c: CommissionProps) => c.status === status;
      const totals = (of: readonly CommissionLine[]): StatementTotals => {
        const sum = (pick: (c: CommissionProps) => boolean) =>
          of
            .map((l) => l.commission.snapshot())
            .filter(pick)
            .reduce((s, c) => s + c.amountMinor, 0);
        return {
          earned: m(sum((c) => c.status !== "clawed_back")),
          accrued: m(sum(by("accrued"))),
          payable: m(sum(by("payable"))),
          paid: m(sum(by("paid"))),
          clawedBack: m(sum((c) => c.kind === "earned" && c.clawbackReason !== null)),
        };
      };
      const sellers = new Map<string, CommissionLine[]>();
      for (const l of lines) {
        const id = l.commission.snapshot().userId;
        sellers.set(id, [...(sellers.get(id) ?? []), l]);
      }
      return {
        period: query.period,
        userId: userId ?? null,
        totals: totals(lines),
        bySeller: [...sellers.entries()]
          .map(([id, of]) => ({
            userId: id,
            userName: of[0]!.userName,
            units: new Set(
              of
                .map((l) => l.commission.snapshot())
                .filter((c) => c.kind === "earned" && c.status !== "clawed_back")
                .filter((c) => c.clawbackReason === null)
                .map((c) => c.dealId),
            ).size,
            ...totals(of),
          }))
          .sort((a, b) => b.earned.amountMinor - a.earned.amountMinor),
        commissions: lines.map((l) => commissionView(l, base)),
        payouts: payouts.map(({ amountMinor, ...p }) => ({ ...p, amount: m(amountMinor) })),
      };
    });
  }

  /** Pays a seller what is payable up to the month (less clawbacks), Dr 2400, Cr the till. */
  pay(
    actor: Principal,
    input: Readonly<{
      userId: string;
      period: string;
      method: "cash" | "momo" | "bank_transfer";
      paidOn?: string;
      reference?: string | null;
    }>,
  ): Promise<PayoutView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      this.requireManage(actor);
      if (!PERIOD.test(input.period)) throw new CommissionRuleError("A period is a month: YYYY-MM");
      const today = await deps.calendar.today();
      await this.refresh(today);
      const due = await deps.commissions.payable(input.userId, input.period);
      const amount = due.reduce((s, c) => s + c.snapshot().amountMinor, 0);
      if (amount <= 0) throw new CommissionRuleError("Nothing is payable to the seller");
      const paidOn = input.paidOn ?? today;
      if (paidOn > today) throw new CommissionRuleError("A payout is not dated in the future");
      const branchId = due.at(-1)!.snapshot().branchId;
      const accounts = await deps.posting.accounts();
      const id = deps.ids.next();
      const journalId = await deps.posting.post(
        {
          date: paidOn,
          description: `Commission payout ${input.period}`,
          source: { type: PAYOUT_SOURCE, id },
          lines: [
            debit(amount, { accountId: accounts("commissions_payable"), branchId }),
            credit(amount, {
              accountId: accounts(PAYOUT_ACCOUNT[input.method]),
              branchId,
              memo: input.reference?.trim() || null,
            }),
          ],
          reversesId: null,
        },
        actor.userId,
      );
      const now = deps.clock.now();
      const payout: PayoutRecord = {
        id,
        number: await deps.numbering.next("commission_payout", now),
        userId: input.userId,
        branchId,
        period: input.period,
        amountMinor: amount,
        method: input.method,
        paidOn,
        reference: input.reference?.trim() || null,
        journalId,
        paidBy: actor.userId,
        createdAt: now,
      };
      await deps.commissions.insertPayout(payout);
      for (const c of due) {
        c.pay(id, now);
        await deps.commissions.update(c);
      }
      await this.audit(actor.userId, "commission.paid_out", "dealer_commission_payout", id, {
        userId: input.userId,
        period: input.period,
        amountMinor: amount,
      });
      const { amountMinor, ...rest } = payout;
      return { ...rest, amount: Money.ofMinor(amountMinor, await this.base()).toJSON() };
    });
  }

  /**
   * Takes a commission back (a returned vehicle, a sale undone): an unpaid one is cancelled and
   * its accrual reversed; a paid one is recovered from the seller's next payout.
   */
  clawBack(actor: Principal, id: string, reason: string): Promise<CommissionView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      this.requireManage(actor);
      const commission = await deps.commissions.lock(id);
      if (commission === null) throw new CommissionNotFoundError();
      const today = await deps.calendar.today();
      const c = commission.snapshot();
      const recovery = commission.clawBack(reason, {
        id: deps.ids.next(),
        today,
        now: deps.clock.now(),
      });
      await deps.commissions.update(commission);
      if (recovery === null) {
        await deps.posting.reverse(
          { type: COMMISSION_SOURCE, id },
          today,
          `Commission clawed back: ${reason.trim()}`,
          actor.userId,
        );
      } else {
        await deps.commissions.insert(recovery);
        const accounts = await deps.posting.accounts();
        await deps.posting.post(
          {
            date: today,
            description: `Commission clawed back: ${reason.trim()}`,
            source: { type: COMMISSION_SOURCE, id: recovery.id },
            lines: [
              debit(c.amountMinor, {
                accountId: accounts("commissions_payable"),
                branchId: c.branchId,
              }),
              credit(c.amountMinor, {
                accountId: accounts("sales_commissions"),
                branchId: c.branchId,
              }),
            ],
            reversesId: null,
          },
          actor.userId,
        );
      }
      await this.audit(actor.userId, "commission.clawed_back", "dealer_commission", id, {
        reason: reason.trim(),
      });
      const [line] = await deps.commissions.list({
        branchIds: "all",
        dealId: c.dealId,
        userId: c.userId,
      });
      return commissionView(
        {
          ...(line ?? { dealNumber: "", vehicle: "", deliveredOn: null, userName: "" }),
          commission,
        },
        await this.base(),
      );
    });
  }

  private requireManage(actor: Principal): void {
    if (actor.grantFor(MANAGE) === undefined)
      throw new CommissionRuleError("You do not manage commissions");
  }

  private async base(): Promise<string> {
    return (await this.deps.organisation.currencySettings()).baseCurrency;
  }

  private audit(
    userId: string,
    action: string,
    entityType: string,
    entityId: string,
    metadata: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    return recordUserAction(this.deps, userId, { action, entityType, entityId, metadata });
  }
}

function tiers(input: PlanInput, base: string) {
  return input.tiers.map((t) => ({
    fromUnits: t.fromUnits,
    percent: input.basis === "flat" ? null : (t.percent ?? null),
    amountMinor:
      input.basis === "flat" && t.amount !== undefined
        ? Money.parse(t.amount, base).amountMinor
        : null,
  }));
}

function planView(plan: CommissionPlan, base: string): PlanView {
  const p = plan.snapshot();
  return {
    ...p,
    tiers: p.tiers.map((t) => ({
      fromUnits: t.fromUnits,
      percent: t.percent,
      amount: t.amountMinor === null ? null : Money.ofMinor(t.amountMinor, base).toJSON(),
    })),
  };
}

function commissionView(line: CommissionLine, base: string): CommissionView {
  const { baseMinor, amountMinor, ...rest } = line.commission.snapshot();
  return {
    ...rest,
    base: Money.ofMinor(baseMinor, base).toJSON(),
    amount: Money.ofMinor(amountMinor, base).toJSON(),
    dealNumber: line.dealNumber,
    vehicle: line.vehicle,
    deliveredOn: line.deliveredOn,
    userName: line.userName,
  };
}
