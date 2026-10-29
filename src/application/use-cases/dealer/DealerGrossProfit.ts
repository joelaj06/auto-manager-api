import type { GrossProfit } from "../../../domain/dealer/Commission.js";
import { marginOf } from "../../../domain/dealer/StockUnit.js";
import type { Principal } from "../../authorization/Principal.js";
import type { LeadSource } from "../../../domain/dealer/Lead.js";
import { Money, type MoneyJson } from "../../../domain/money/Money.js";
import type { IDeals } from "../../ports/IDealerDeals.js";
import type { ILeads } from "../../ports/IDealerSales.js";
import type { IDealerStock } from "../../ports/IDealerStock.js";
import type { IOrganisationSettings } from "../../ports/IOrganisationSettings.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import type { BranchScope } from "../../services/BranchScope.js";
import { DealRuleError } from "../../../domain/dealer/Deal.js";
import { profitView, type DealProfit, type ProfitView } from "./DealProfit.js";

const PERMISSION = "dealer.stock.cost.view";
/** Units in one report. */
const MAX_UNITS = 1_000;

export type UnitProfit = Readonly<{
  dealId: string;
  dealNumber: string;
  vehicleId: string;
  vehicle: string;
  make: string;
  branchId: string;
  salesExecutiveId: string;
  /** Where the buyer's lead came from; null for a sale without a lead. */
  source: LeadSource | null;
  soldOn: string;
  figures: ProfitView;
  /** Gross profit over revenue, to one decimal. */
  marginPercent: string | null;
}>;

/** Units in a group with their figures summed, the margin and the gross profit per unit. */
export type GroupProfit = ProfitView &
  Readonly<{ count: number; marginPercent: string | null; perUnit: MoneyJson | null }>;

export type GrossProfitReport = Readonly<{
  from: string;
  to: string;
  units: readonly UnitProfit[];
  totals: GroupProfit;
  byMake: readonly (GroupProfit & Readonly<{ make: string }>)[];
  bySalesExecutive: readonly (GroupProfit & Readonly<{ salesExecutiveId: string }>)[];
  bySource: readonly (GroupProfit & Readonly<{ source: LeadSource | null }>)[];
  byBranch: readonly (GroupProfit & Readonly<{ branchId: string }>)[];
}>;

/**
 * Gross profit per unit sold in a period (docs/10 §1 and §10, decisions 454 and 460), with the
 * cost figures, for those who see stock cost: each unit, and the units grouped by make, sales
 * executive, the source of the buyer's lead and branch.
 */
export class DealerGrossProfit {
  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      deals: IDeals;
      leads: ILeads;
      stock: IDealerStock;
      profit: DealProfit;
      organisation: IOrganisationSettings;
      scope: BranchScope;
    }>,
  ) {}

  report(
    actor: Principal,
    query: Readonly<{ from: string; to: string; branchId?: string; salesExecutiveId?: string }>,
  ): Promise<GrossProfitReport> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      if (query.from > query.to) throw new DealRuleError("The period ends after it starts");
      const reach = deps.scope.branchesFor(actor, PERMISSION);
      if (query.branchId !== undefined && !deps.scope.can(actor, PERMISSION, query.branchId))
        throw new DealRuleError("You do not see that branch's cost");
      const deals = await deps.deals.list({
        branchIds: query.branchId === undefined ? reach : [query.branchId],
        statuses: ["sold", "delivered"],
        soldFrom: query.from,
        soldTo: query.to,
        ...(query.salesExecutiveId === undefined
          ? {}
          : { salesExecutiveId: query.salesExecutiveId }),
        limit: MAX_UNITS,
      });
      const base = (await deps.organisation.currencySettings()).baseCurrency;
      const units: (UnitProfit & Readonly<{ profit: GrossProfit }>)[] = [];
      const sources = new Map<string, LeadSource>();
      for (const deal of deals) {
        const d = deal.snapshot();
        const profit = await deps.profit.of(d);
        if (profit === null) continue;
        const v = (await deps.stock.record(d.vehicleId))?.vehicle;
        if (d.leadId !== null && !sources.has(d.leadId)) {
          const lead = await deps.leads.get(d.leadId);
          if (lead !== null) sources.set(d.leadId, lead.snapshot().source);
        }
        units.push({
          dealId: d.id,
          dealNumber: d.number,
          vehicleId: d.vehicleId,
          vehicle:
            v === undefined
              ? ""
              : `${v.make} ${v.model}${v.year === null ? "" : ` ${v.year}`}${v.plateNumber === null ? "" : `, ${v.plateNumber}`}`,
          make: v?.make ?? "",
          branchId: d.branchId,
          salesExecutiveId: d.salesExecutiveId,
          source: d.leadId === null ? null : (sources.get(d.leadId) ?? null),
          soldOn: d.soldOn!,
          figures: profitView(profit, base),
          marginPercent: percentOf(profit.grossProfitMinor, profit.revenueMinor),
          profit,
        });
      }
      units.sort((a, b) =>
        a.soldOn === b.soldOn
          ? a.dealNumber.localeCompare(b.dealNumber)
          : a.soldOn < b.soldOn
            ? -1
            : 1,
      );
      const group = <K extends string | null>(key: (u: (typeof units)[number]) => K) => {
        const groups = new Map<K, (typeof units)[number][]>();
        for (const u of units) groups.set(key(u), [...(groups.get(key(u)) ?? []), u]);
        // Most gross profit first.
        return [...groups.entries()]
          .map(([k, members]) => ({
            key: k,
            ...summed(
              members.map((u) => u.profit),
              base,
            ),
          }))
          .sort((a, b) => b.grossProfit.amountMinor - a.grossProfit.amountMinor);
      };
      return {
        from: query.from,
        to: query.to,
        units: units.map(({ profit: _p, ...u }) => u),
        totals: summed(
          units.map((u) => u.profit),
          base,
        ),
        byMake: group((u) => u.make).map(({ key, ...g }) => ({ make: key, ...g })),
        bySalesExecutive: group((u) => u.salesExecutiveId).map(({ key, ...g }) => ({
          salesExecutiveId: key,
          ...g,
        })),
        bySource: group((u) => u.source).map(({ key, ...g }) => ({ source: key, ...g })),
        byBranch: group((u) => u.branchId).map(({ key, ...g }) => ({ branchId: key, ...g })),
      };
    });
  }
}

function summed(profits: readonly GrossProfit[], base: string): GroupProfit {
  const sums: Record<keyof GrossProfit, number> = {
    revenueMinor: 0,
    costMinor: 0,
    reconditioningMinor: 0,
    holdingMinor: 0,
    commissionMinor: 0,
    beforeCommissionMinor: 0,
    grossProfitMinor: 0,
  };
  for (const p of profits)
    for (const k of Object.keys(sums) as (keyof GrossProfit)[]) sums[k] += p[k];
  return {
    ...profitView(sums, base),
    count: profits.length,
    marginPercent: percentOf(sums.grossProfitMinor, sums.revenueMinor),
    perUnit:
      profits.length === 0
        ? null
        : Money.ofMinor(Math.round(sums.grossProfitMinor / profits.length), base).toJSON(),
  };
}

function percentOf(profitMinor: number, revenueMinor: number): string | null {
  return marginOf(revenueMinor, revenueMinor - profitMinor).percent;
}
