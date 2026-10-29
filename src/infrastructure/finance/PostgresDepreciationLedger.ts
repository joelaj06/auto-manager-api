import type {
  DepreciatingVehicle,
  IDepreciationLedger,
} from "../../application/ports/IDealerCommissions.js";
import type { PostgresTransactionContext } from "../database/postgres/PostgresTransactionContext.js";

export class PostgresDepreciationLedger implements IDepreciationLedger {
  constructor(private readonly transactions: PostgresTransactionContext) {}

  private get tx() {
    return this.transactions.current();
  }

  async vehicles(vehicleId?: string): Promise<DepreciatingVehicle[]> {
    const { rows } = await this.tx.query<{
      id: string;
      branch_id: string;
      acquisition_cost_minor: string;
      residual_value_minor: string | null;
      acquisition_date: string;
      useful_life_months: number;
      posted_minor: string;
    }>(
      `select v.id, v.branch_id, v.acquisition_cost_minor, v.residual_value_minor,
              v.acquisition_date::text as acquisition_date, v.useful_life_months,
              coalesce((select sum(d.amount_minor) from vehicle_depreciation d
                         where d.vehicle_id = v.id), 0) as posted_minor
         from vehicles v
        where v.depreciation_method = 'straight_line'
          and v.acquisition_cost_minor is not null and v.acquisition_date is not null
          and v.useful_life_months is not null and v.deleted_at is null
          and ($1::uuid is null and v.status <> 'sold' or v.id = $1::uuid)
        order by v.id`,
      [vehicleId ?? null],
    );
    return rows.map((r) => ({
      id: r.id,
      branchId: r.branch_id,
      acquisitionCostMinor: Number(r.acquisition_cost_minor),
      residualValueMinor: r.residual_value_minor === null ? null : Number(r.residual_value_minor),
      acquisitionDate: r.acquisition_date,
      usefulLifeMonths: r.useful_life_months,
      postedMinor: Number(r.posted_minor),
    }));
  }

  async posted(vehicleId: string): Promise<number> {
    const { rows } = await this.tx.query<{ posted: string }>(
      `select coalesce(sum(amount_minor), 0) as posted from vehicle_depreciation
        where vehicle_id = $1`,
      [vehicleId],
    );
    return Number(rows[0]!.posted);
  }

  async record(
    e: Readonly<{ vehicleId: string; period: string; amountMinor: number; journalId: string }>,
  ): Promise<void> {
    await this.tx.query(
      `insert into vehicle_depreciation (vehicle_id, period, amount_minor, journal_id)
       values ($1, $2, $3, $4)`,
      [e.vehicleId, e.period, e.amountMinor, e.journalId],
    );
  }
}
