import type {
  AgedStock,
  IDealerStock,
  PriceChangeRecord,
  StockFilter,
  StockRecord,
  StockSpend,
  StockTransfer,
  StockVehicle,
} from "../../application/ports/IDealerStock.js";
import { StockUnit, type Consignment, type StockUnitProps } from "../../domain/dealer/StockUnit.js";
import type { PostgresTransactionContext } from "../database/postgres/PostgresTransactionContext.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** What sits on the lot and ages. */
const IN_STOCK = `('incoming', 'reconditioning', 'ready', 'listed', 'reserved')`;

const COLUMNS = [
  "vehicle_id",
  "status",
  "source",
  "stocked_on",
  "asking_price_minor",
  "minimum_price_minor",
  "holding_cost_per_day_minor",
  "consignor_id",
  "consignment_terms",
  "consignor_payout_minor",
  "commission_rate",
  "listed_on",
  "withdrawn_on",
  "withdraw_reason",
  "sold_on",
  "delivered_on",
  "notes",
  "created_by",
  "created_at",
  "updated_at",
] as const;
type Column = (typeof COLUMNS)[number];
const DATES = new Set<Column>([
  "stocked_on",
  "listed_on",
  "withdrawn_on",
  "sold_on",
  "delivered_on",
]);
const SELECT = COLUMNS.map((c) =>
  DATES.has(c) || c === "commission_rate" ? `s.${c}::text as ${c}` : `s.${c}`,
).join(", ");

type Row = Record<Column, unknown>;
type VehicleRow = {
  v_code: string;
  v_plate_number: string | null;
  v_vin: string | null;
  v_make: string;
  v_model: string;
  v_year: number | null;
  v_colour: string | null;
  v_odometer: number | null;
  v_status: StockVehicle["status"];
  v_ownership_type: StockVehicle["ownershipType"];
  v_branch_id: string;
  v_acquisition_cost_minor: string | null;
  consignor_name: string | null;
};

const minor = (value: unknown): number | null => (value === null ? null : Number(value));

function toRow(p: StockUnitProps): Row {
  const c = p.consignment;
  return {
    vehicle_id: p.vehicleId,
    status: p.status,
    source: p.source,
    stocked_on: p.stockedOn,
    asking_price_minor: p.askingPriceMinor,
    minimum_price_minor: p.minimumPriceMinor,
    holding_cost_per_day_minor: p.holdingCostPerDayMinor,
    consignor_id: c?.consignorId ?? null,
    consignment_terms: c?.terms ?? null,
    consignor_payout_minor: c?.payoutMinor ?? null,
    commission_rate: c?.commissionRate ?? null,
    listed_on: p.listedOn,
    withdrawn_on: p.withdrawnOn,
    withdraw_reason: p.withdrawReason,
    sold_on: p.soldOn,
    delivered_on: p.deliveredOn,
    notes: p.notes,
    created_by: p.createdBy,
    created_at: p.createdAt,
    updated_at: p.updatedAt,
  };
}

function toUnit(r: Row): StockUnit {
  const consignment: Consignment | null =
    r.consignor_id === null
      ? null
      : {
          consignorId: r.consignor_id as string,
          terms: r.consignment_terms as Consignment["terms"],
          payoutMinor: minor(r.consignor_payout_minor),
          // numeric(5, 2) comes back as "10.00": shown as entered ("10").
          commissionRate:
            r.commission_rate === null ? null : (r.commission_rate as string).replace(/\.?0+$/, ""),
        };
  return StockUnit.restore({
    vehicleId: r.vehicle_id as string,
    status: r.status as StockUnitProps["status"],
    source: r.source as StockUnitProps["source"],
    stockedOn: r.stocked_on as string,
    askingPriceMinor: minor(r.asking_price_minor),
    minimumPriceMinor: minor(r.minimum_price_minor),
    holdingCostPerDayMinor: Number(r.holding_cost_per_day_minor),
    consignment,
    listedOn: r.listed_on as string | null,
    withdrawnOn: r.withdrawn_on as string | null,
    withdrawReason: r.withdraw_reason as string | null,
    soldOn: r.sold_on as string | null,
    deliveredOn: r.delivered_on as string | null,
    notes: r.notes as string | null,
    createdBy: r.created_by as string | null,
    createdAt: r.created_at as Date,
    updatedAt: r.updated_at as Date,
  });
}

const RECORD_SELECT = `${SELECT}, v.code as v_code, v.plate_number as v_plate_number,
  v.vin as v_vin, v.make as v_make, v.model as v_model, v.year as v_year, v.colour as v_colour,
  v.current_odometer as v_odometer, v.status as v_status, v.ownership_type as v_ownership_type,
  v.branch_id as v_branch_id, v.acquisition_cost_minor as v_acquisition_cost_minor,
  c.name as consignor_name
  from dealer_stock s
  join vehicles v on v.id = s.vehicle_id
  left join customers c on c.id = s.consignor_id`;

const toRecord = (r: Row & VehicleRow): StockRecord => ({
  unit: toUnit(r),
  vehicle: {
    code: r.v_code,
    plateNumber: r.v_plate_number,
    vin: r.v_vin,
    make: r.v_make,
    model: r.v_model,
    year: r.v_year,
    colour: r.v_colour,
    odometer: r.v_odometer,
    status: r.v_status,
    ownershipType: r.v_ownership_type,
    branchId: r.v_branch_id,
    acquisitionCostMinor: minor(r.v_acquisition_cost_minor),
  },
  consignorName: r.consignor_name,
});

export class PostgresDealerStock implements IDealerStock {
  constructor(private readonly transactions: PostgresTransactionContext) {}

  private get tx() {
    return this.transactions.current();
  }

  async insert(unit: StockUnit): Promise<void> {
    const values = toRow(unit.snapshot());
    await this.tx.query(
      `insert into dealer_stock (${COLUMNS.join(", ")})
       values (${COLUMNS.map((_, i) => `$${i + 1}`).join(", ")})`,
      COLUMNS.map((c) => values[c]),
    );
  }

  async update(unit: StockUnit): Promise<void> {
    const values = toRow(unit.snapshot());
    const changed = COLUMNS.filter((c) => c !== "vehicle_id" && c !== "created_at");
    await this.tx.query(
      `update dealer_stock set ${changed.map((c, i) => `${c} = $${i + 2}`).join(", ")}
        where vehicle_id = $1`,
      [values.vehicle_id, ...changed.map((c) => values[c])],
    );
  }

  get(vehicleId: string): Promise<StockUnit | null> {
    return this.one(vehicleId, "");
  }

  lock(vehicleId: string): Promise<StockUnit | null> {
    return this.one(vehicleId, "for update");
  }

  async record(vehicleId: string): Promise<StockRecord | null> {
    if (!UUID.test(vehicleId)) return null;
    const { rows } = await this.tx.query<Row & VehicleRow>(
      `select ${RECORD_SELECT} where s.vehicle_id = $1`,
      [vehicleId],
    );
    return rows[0] === undefined ? null : toRecord(rows[0]);
  }

  async list(filter: StockFilter): Promise<StockRecord[]> {
    const where: string[] = ["v.deleted_at is null"];
    const params: unknown[] = [];
    const add = (sql: string, value: unknown) => {
      params.push(value);
      where.push(sql.replaceAll("?", `$${params.length}`));
    };
    if (filter.branchIds !== "all") add("v.branch_id = any(?::uuid[])", filter.branchIds);
    if (filter.branchId !== undefined) add("v.branch_id = ?", filter.branchId);
    if (filter.statuses !== undefined) add("s.status = any(?::text[])", filter.statuses);
    if (filter.sources !== undefined) add("s.source = any(?::text[])", filter.sources);
    if (filter.make !== undefined) add("lower(v.make) = lower(?)", filter.make);
    if (filter.model !== undefined) add("lower(v.model) = lower(?)", filter.model);
    if (filter.yearFrom !== undefined) add("v.year >= ?", filter.yearFrom);
    if (filter.yearTo !== undefined) add("v.year <= ?", filter.yearTo);
    if (filter.priceFromMinor !== undefined)
      add("s.asking_price_minor >= ?", filter.priceFromMinor);
    if (filter.priceToMinor !== undefined) add("s.asking_price_minor <= ?", filter.priceToMinor);
    if (filter.stockedOnOrBefore !== undefined)
      add("s.stocked_on <= ?::date", filter.stockedOnOrBefore);
    if (filter.consignorId !== undefined) add("s.consignor_id = ?", filter.consignorId);
    if (filter.afterVehicleId !== undefined && UUID.test(filter.afterVehicleId))
      add(
        `(s.stocked_on, s.vehicle_id) >
           (select a.stocked_on, a.vehicle_id from dealer_stock a where a.vehicle_id = ?)`,
        filter.afterVehicleId,
      );
    params.push(filter.limit);
    const { rows } = await this.tx.query<Row & VehicleRow>(
      `select ${RECORD_SELECT}
        where ${where.join(" and ")}
        order by s.stocked_on, s.vehicle_id
        limit $${params.length}`,
      params,
    );
    return rows.map(toRecord);
  }

  async spend(vehicleIds: readonly string[]): Promise<Map<string, StockSpend>> {
    const result = new Map<string, StockSpend>();
    const ids = vehicleIds.filter((id) => UUID.test(id));
    if (ids.length === 0) return result;
    const { rows } = await this.tx.query<{
      vehicle_id: string;
      amount_base_minor: string;
      net_base_minor: string;
    }>(
      `select l.vehicle_id, sum(l.amount_base_minor) as amount_base_minor,
              sum(l.net_base_minor) as net_base_minor
         from expense_lines l
         join expenses e on e.id = l.expense_id
         join expense_categories k on k.id = e.category_id
         join dealer_stock s on s.vehicle_id = l.vehicle_id
        where l.vehicle_id = any($1::uuid[])
          and e.status in ('approved', 'paid')
          and e.expense_date >= s.stocked_on
          and k.code <> 'vehicle_purchase'
        group by l.vehicle_id`,
      [ids],
    );
    for (const r of rows)
      result.set(r.vehicle_id, {
        amountBaseMinor: Number(r.amount_base_minor),
        netBaseMinor: Number(r.net_base_minor),
      });
    return result;
  }

  async addPriceChange(c: PriceChangeRecord): Promise<void> {
    await this.tx.query(
      `insert into dealer_price_changes (id, vehicle_id, asking_price_minor, minimum_price_minor,
         previous_asking_minor, previous_minimum_minor, reason, changed_by, changed_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        c.id,
        c.vehicleId,
        c.askingPriceMinor,
        c.minimumPriceMinor,
        c.previousAskingMinor,
        c.previousMinimumMinor,
        c.reason,
        c.changedBy,
        c.changedAt,
      ],
    );
  }

  async priceChanges(vehicleId: string): Promise<PriceChangeRecord[]> {
    if (!UUID.test(vehicleId)) return [];
    const { rows } = await this.tx.query<{
      id: string;
      vehicle_id: string;
      asking_price_minor: string | null;
      minimum_price_minor: string | null;
      previous_asking_minor: string | null;
      previous_minimum_minor: string | null;
      reason: string | null;
      changed_by: string | null;
      changed_at: Date;
    }>(
      `select id, vehicle_id, asking_price_minor, minimum_price_minor, previous_asking_minor,
              previous_minimum_minor, reason, changed_by, changed_at
         from dealer_price_changes where vehicle_id = $1 order by changed_at, id`,
      [vehicleId],
    );
    return rows.map((r) => ({
      id: r.id,
      vehicleId: r.vehicle_id,
      askingPriceMinor: minor(r.asking_price_minor),
      minimumPriceMinor: minor(r.minimum_price_minor),
      previousAskingMinor: minor(r.previous_asking_minor),
      previousMinimumMinor: minor(r.previous_minimum_minor),
      reason: r.reason,
      changedBy: r.changed_by,
      changedAt: r.changed_at,
    }));
  }

  async addTransfer(t: StockTransfer): Promise<void> {
    await this.tx.query(
      `insert into dealer_stock_transfers (id, vehicle_id, from_branch_id, to_branch_id,
         transferred_on, reason, transferred_by, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        t.id,
        t.vehicleId,
        t.fromBranchId,
        t.toBranchId,
        t.transferredOn,
        t.reason,
        t.transferredBy,
        t.createdAt,
      ],
    );
  }

  async transfers(vehicleId: string): Promise<StockTransfer[]> {
    if (!UUID.test(vehicleId)) return [];
    const { rows } = await this.tx.query<{
      id: string;
      vehicle_id: string;
      from_branch_id: string;
      to_branch_id: string;
      transferred_on: string;
      reason: string;
      transferred_by: string | null;
      created_at: Date;
    }>(
      `select id, vehicle_id, from_branch_id, to_branch_id, transferred_on::text as transferred_on,
              reason, transferred_by, created_at
         from dealer_stock_transfers where vehicle_id = $1 order by created_at, id`,
      [vehicleId],
    );
    return rows.map((r) => ({
      id: r.id,
      vehicleId: r.vehicle_id,
      fromBranchId: r.from_branch_id,
      toBranchId: r.to_branch_id,
      transferredOn: r.transferred_on,
      reason: r.reason,
      transferredBy: r.transferred_by,
      createdAt: r.created_at,
    }));
  }

  async agedStock(stockedOnOrBefore: string): Promise<AgedStock[]> {
    const { rows } = await this.tx.query<{
      vehicle_id: string;
      branch_id: string;
      code: string;
      plate_number: string | null;
      make: string;
      model: string;
      stocked_on: string;
    }>(
      `select s.vehicle_id, v.branch_id, v.code, v.plate_number, v.make, v.model,
              s.stocked_on::text as stocked_on
         from dealer_stock s
         join vehicles v on v.id = s.vehicle_id
        where s.status in ${IN_STOCK} and s.stocked_on <= $1::date and v.deleted_at is null
        order by s.stocked_on, s.vehicle_id`,
      [stockedOnOrBefore],
    );
    return rows.map((r) => ({
      vehicleId: r.vehicle_id,
      branchId: r.branch_id,
      code: r.code,
      plateNumber: r.plate_number,
      make: r.make,
      model: r.model,
      stockedOn: r.stocked_on,
    }));
  }

  async consignorExists(customerId: string): Promise<boolean> {
    if (!UUID.test(customerId)) return false;
    const { rows } = await this.tx.query(
      `select 1 from customers where id = $1 and deleted_at is null`,
      [customerId],
    );
    return rows.length > 0;
  }

  private async one(vehicleId: string, lock: string): Promise<StockUnit | null> {
    if (!UUID.test(vehicleId)) return null;
    const { rows } = await this.tx.query<Row>(
      `select ${SELECT} from dealer_stock s where s.vehicle_id = $1 ${lock}`,
      [vehicleId],
    );
    return rows[0] === undefined ? null : toUnit(rows[0]);
  }
}
