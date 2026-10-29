import type { GrossProfit } from "../../../domain/dealer/Commission.js";
import { marginOf } from "../../../domain/dealer/StockUnit.js";
import type { Principal } from "../../authorization/Principal.js";
import type { IDeals } from "../../ports/IDealerDeals.js";
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
  branchId: string;
  salesExecutiveId: string;
  soldOn: string;
  figures: ProfitView;
  /** Gross profit over revenue, to one decimal. */
  marginPercent: string | null;
}>;

export type GrossProfitReport = Readonly<{
  from: string;
  to: string;
  units: readonly UnitProfit[];
  totals: ProfitView & Readonly<{ count: number; marginPercent: string | null }>;
}>;

/**
 * Gross profit per unit sold in a period (docs/10 §1, decision 454), with the cost figures, for
 * those who see stock cost; P7-8 groups it by make, seller and source.
 */
export class DealerGrossProfit {
  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      deals: IDeals;
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
      const sums: Record<keyof GrossProfit, number> = {
        revenueMinor: 0,
        costMinor: 0,
        reconditioningMinor: 0,
        holdingMinor: 0,
        commissionMinor: 0,
        beforeCommissionMinor: 0,
        grossProfitMinor: 0,
      };
      const units: UnitProfit[] = [];
      for (const deal of deals) {
        const d = deal.snapshot();
        const profit = await deps.profit.of(d);
        if (profit === null) continue;
        const v = (await deps.stock.record(d.vehicleId))?.vehicle;
        for (const k of Object.keys(sums) as (keyof GrossProfit)[]) sums[k] += profit[k];
        units.push({
          dealId: d.id,
          dealNumber: d.number,
          vehicleId: d.vehicleId,
          vehicle:
            v === undefined
              ? ""
              : `${v.make} ${v.model}${v.year === null ? "" : ` ${v.year}`}${v.plateNumber === null ? "" : `, ${v.plateNumber}`}`,
          branchId: d.branchId,
          salesExecutiveId: d.salesExecutiveId,
          soldOn: d.soldOn!,
          figures: profitView(profit, base),
          marginPercent: percentOf(profit.grossProfitMinor, profit.revenueMinor),
        });
      }
      units.sort((a, b) =>
        a.soldOn === b.soldOn
          ? a.dealNumber.localeCompare(b.dealNumber)
          : a.soldOn < b.soldOn
            ? -1
            : 1,
      );
      return {
        from: query.from,
        to: query.to,
        units,
        totals: {
          ...profitView(sums, base),
          count: units.length,
          marginPercent: percentOf(sums.grossProfitMinor, sums.revenueMinor),
        },
      };
    });
  }
}

function percentOf(profitMinor: number, revenueMinor: number): string | null {
  return marginOf(revenueMinor, revenueMinor - profitMinor).percent;
}
