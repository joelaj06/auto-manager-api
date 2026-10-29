import type { DealProps } from "../../../domain/dealer/Deal.js";
import { consignorPayout } from "../../../domain/dealer/StockUnit.js";
import { credit, debit, type JournalLine } from "../../../domain/finance/Journal.js";
import type { Principal } from "../../authorization/Principal.js";
import { COST_OF_SALE_SOURCE, type IDepreciationLedger } from "../../ports/IDealerCommissions.js";
import type { StockRecord } from "../../ports/IDealerStock.js";
import type { LedgerPosting } from "../finance/LedgerPosting.js";
import type { VehicleDepreciation } from "../finance/VehicleDepreciation.js";

/** Stock whose cost entered the books: a vehicle purchase capitalised to 1500, or a trade-in. */
const IN_THE_BOOKS = new Set(["purchase", "trade_in"]);

/**
 * The sold vehicle's cost leaves the books at the sale (docs/10 §6, decision 453), dated the sale:
 * Dr 5100 Cost of vehicles sold. A vehicle of the dealer's own is first depreciated to the day,
 * then its accumulated depreciation (Dr 1510) and cost (Cr 1500 Vehicles; Cr 3000 Owner's equity
 * when it was stocked without a purchase or trade-in, so its cost never entered the books) are
 * taken out: the cost of the sale is its book value. A consigned vehicle costs the consignor's
 * payout on the price, owed to them as customer credit (Cr 2100).
 */
export class CostOfSales {
  constructor(
    private readonly deps: Readonly<{
      posting: LedgerPosting;
      depreciation: VehicleDepreciation;
      depreciationLedger: IDepreciationLedger;
    }>,
  ) {}

  /** Posts the cost of the sale (inside the sale's unit of work); returns it. */
  async post(
    actor: Principal,
    deal: DealProps,
    record: StockRecord,
    soldOn: string,
  ): Promise<number> {
    const { deps } = this;
    const unit = record.unit.snapshot();
    const accounts = await deps.posting.accounts();
    const tags = { branchId: deal.branchId, vehicleId: deal.vehicleId };
    let cost: number;
    let lines: JournalLine[];
    // What leaves the books: the payout, or the vehicle's cost (nothing when it has none).
    let booked: number;
    if (unit.consignment !== null) {
      cost = consignorPayout(unit.consignment, deal.priceMinor - deal.discountMinor);
      booked = cost;
      lines = [
        debit(cost, { accountId: accounts("vehicle_cogs"), ...tags }),
        credit(cost, {
          accountId: accounts("party_credit"),
          ...tags,
          party: { type: "customer", id: unit.consignment.consignorId },
          memo: "Consignor's payout",
        }),
      ];
    } else {
      const acquisition = record.vehicle.acquisitionCostMinor ?? 0;
      await deps.depreciation.catchUp(deal.vehicleId, soldOn, actor.userId);
      const depreciated = Math.min(
        acquisition,
        await deps.depreciationLedger.posted(deal.vehicleId),
      );
      cost = acquisition - depreciated;
      booked = acquisition;
      lines = [
        ...(depreciated > 0
          ? [debit(depreciated, { accountId: accounts("accumulated_depreciation"), ...tags })]
          : []),
        ...(cost > 0 ? [debit(cost, { accountId: accounts("vehicle_cogs"), ...tags })] : []),
        credit(acquisition, {
          accountId: accounts(IN_THE_BOOKS.has(unit.source) ? "vehicles" : "equity"),
          ...tags,
        }),
      ];
    }
    if (booked === 0) return 0;
    await deps.posting.post(
      {
        date: soldOn,
        description: `Cost of sale ${deal.number}`,
        source: { type: COST_OF_SALE_SOURCE, id: deal.id },
        lines,
        reversesId: null,
      },
      actor.userId,
    );
    return cost;
  }
}
