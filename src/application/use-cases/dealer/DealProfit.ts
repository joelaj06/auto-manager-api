import { grossProfit, type GrossProfit } from "../../../domain/dealer/Commission.js";
import { Money, type MoneyJson } from "../../../domain/money/Money.js";
import type { DealProps } from "../../../domain/dealer/Deal.js";
import { daysInStock } from "../../../domain/dealer/StockUnit.js";
import type { IInvoiceRepository } from "../../../domain/repositories/IFinanceRepositories.js";
import type { ICommissions } from "../../ports/IDealerCommissions.js";
import type { IDealerStock } from "../../ports/IDealerStock.js";
import type { IOrganisationSettings } from "../../ports/IOrganisationSettings.js";

/**
 * Gross profit on a sold unit (docs/10 §1, decision 454): the sale invoice before tax, less what
 * the vehicle cost the books at the sale, the spend on it since it entered stock (net of tax the
 * business recovers), its holding cost to the sale and the commissions on it. Instalment charges
 * are finance income, not the sale's.
 */
export class DealProfit {
  constructor(
    private readonly deps: Readonly<{
      stock: IDealerStock;
      invoices: IInvoiceRepository;
      commissions: ICommissions;
      organisation: IOrganisationSettings;
    }>,
  ) {}

  async of(deal: DealProps): Promise<GrossProfit | null> {
    const { deps } = this;
    if (deal.invoiceId === null || deal.soldOn === null) return null;
    const invoice = (await deps.invoices.findById(deal.invoiceId))!.snapshot();
    const unit = (await deps.stock.record(deal.vehicleId))?.unit.snapshot();
    const spend = (await deps.stock.spend([deal.vehicleId])).get(deal.vehicleId);
    const recoverTax = (await deps.organisation.taxSettings()).scheme !== "not_registered";
    const commissions = await deps.commissions.list({ dealId: deal.id, branchIds: "all" });
    return grossProfit({
      revenueMinor: invoice.status === "void" ? 0 : invoice.subtotalMinor,
      costMinor: deal.costOfSaleMinor ?? 0,
      reconditioningMinor:
        spend === undefined ? 0 : recoverTax ? spend.netBaseMinor : spend.amountBaseMinor,
      holdingMinor:
        unit === undefined
          ? 0
          : daysInStock(unit.stockedOn, deal.soldOn) * unit.holdingCostPerDayMinor,
      commissionMinor: commissions
        .map((l) => l.commission.snapshot())
        .filter((c) => c.status !== "clawed_back")
        .reduce((s, c) => s + c.amountMinor, 0),
    });
  }
}

/** Gross profit figures as money, named without units. */
export type ProfitView = Readonly<{
  revenue: MoneyJson;
  cost: MoneyJson;
  reconditioning: MoneyJson;
  holding: MoneyJson;
  commission: MoneyJson;
  beforeCommission: MoneyJson;
  grossProfit: MoneyJson;
}>;

export function profitView(p: GrossProfit, base: string): ProfitView {
  const m = (minor: number) => Money.ofMinor(minor, base).toJSON();
  return {
    revenue: m(p.revenueMinor),
    cost: m(p.costMinor),
    reconditioning: m(p.reconditioningMinor),
    holding: m(p.holdingMinor),
    commission: m(p.commissionMinor),
    beforeCommission: m(p.beforeCommissionMinor),
    grossProfit: m(p.grossProfitMinor),
  };
}
