import type {
  AccountTotal,
  BranchFilter,
  CashDay,
  DriverShortfall,
  ExpenseDay,
  IDashboardQueries,
  IncomeSource,
  IVehicleStatsStore,
  LedgerDay,
  RemittanceDay,
  StatsState,
  VehicleSpend,
  VehicleStatsDay,
  VehicleStatsRow,
} from "../../application/ports/IReporting.js";
import {
  IDLE_STATUSES,
  OFF_ROAD_STATUSES,
  WORKING_STATUSES,
} from "../../domain/reporting/VehicleProfit.js";
import type { VehicleStatus } from "../../domain/vehicles/VehicleStatus.js";
import type { DepreciableAsset } from "../../domain/vehicles/Vehicle.js";
import type { PostgresTransactionContext } from "../database/postgres/PostgresTransactionContext.js";

const n = (value: string | number | null) => (value === null ? 0 : Number(value));
const scope = (filter: BranchFilter) => [
  filter.branchIds === "all" ? null : filter.branchIds,
  filter.branchId,
];

/** Rows of `daily_vehicle_stats` for every vehicle-day of a range (params: from, to, timezone). */
const REBUILD = `
with days as (
  select d::date as day from generate_series($1::date, $2::date, interval '1 day') as d
),
money as (
  select l.vehicle_id, e.entry_date as day,
         coalesce(sum(l.credit_minor - l.debit_minor)
           filter (where a.type = 'income' and a.system_key = 'remittance_income'), 0) as remittance,
         coalesce(sum(l.credit_minor - l.debit_minor)
           filter (where a.type = 'income' and a.system_key = 'rental_income'), 0) as rental,
         coalesce(sum(l.credit_minor - l.debit_minor)
           filter (where a.type = 'income' and a.system_key is distinct from 'remittance_income'
                     and a.system_key is distinct from 'rental_income'), 0) as other,
         coalesce(sum(l.debit_minor - l.credit_minor) filter (where a.type = 'expense'), 0) as cost
    from ledger_lines l
    join journal_entries e on e.id = l.entry_id
    join ledger_accounts a on a.id = l.account_id
   where l.vehicle_id is not null and a.type in ('income', 'expense')
     and e.entry_date between $1::date and $2::date
   group by l.vehicle_id, e.entry_date
),
readings as (
  select r.vehicle_id, (r.read_at at time zone $3::text)::date as day, r.value, r.replacement,
         lag(r.value) over (partition by r.vehicle_id order by r.read_at, r.id) as previous
    from odometer_readings r
   where r.read_at < (($2::date + 1)::timestamp at time zone $3::text)
),
distance as (
  select vehicle_id, day,
         sum(case when replacement or previous is null then 0
                  else greatest(value - previous, 0) end) as distance
    from readings where day >= $1::date
   group by vehicle_id, day
),
fuel as (
  select vehicle_id, (filled_at at time zone $3::text)::date as day,
         sum(litres) as litres, sum(amount_minor) as amount
    from fuel_logs
   where filled_at >= ($1::date::timestamp at time zone $3::text)
     and filled_at < (($2::date + 1)::timestamp at time zone $3::text)
   group by 1, 2
),
vehicle_days as (
  select v.id as vehicle_id, d.day
    from vehicles v
    join days d on d.day >= (v.created_at at time zone $3::text)::date
               and (v.deleted_at is null or d.day < (v.deleted_at at time zone $3::text)::date)
  union select vehicle_id, day from money
  union select vehicle_id, day from distance
  union select vehicle_id, day from fuel
)
insert into daily_vehicle_stats
  (vehicle_id, stat_date, branch_id, status, driver_id, remittance_income_minor,
   rental_income_minor, other_income_minor, cost_minor, distance, fuel_litres, fuel_cost_minor)
select vd.vehicle_id, vd.day, v.branch_id,
       coalesce(latest.to_status, first.from_status, first.to_status, v.status),
       driver.driver_id,
       coalesce(m.remittance, 0), coalesce(m.rental, 0), coalesce(m.other, 0), coalesce(m.cost, 0),
       coalesce(dist.distance, 0), coalesce(f.litres, 0), coalesce(f.amount, 0)
  from vehicle_days vd
  join vehicles v on v.id = vd.vehicle_id
  left join money m on m.vehicle_id = vd.vehicle_id and m.day = vd.day
  left join distance dist on dist.vehicle_id = vd.vehicle_id and dist.day = vd.day
  left join fuel f on f.vehicle_id = vd.vehicle_id and f.day = vd.day
  left join lateral (
    select h.to_status from vehicle_status_history h
     where h.vehicle_id = vd.vehicle_id
       and h.changed_at < ((vd.day + 1)::timestamp at time zone $3::text)
     order by h.changed_at desc, h.id desc limit 1
  ) latest on true
  left join lateral (
    select h.from_status, h.to_status from vehicle_status_history h
     where h.vehicle_id = vd.vehicle_id
     order by h.changed_at, h.id limit 1
  ) first on true
  left join lateral (
    select a.driver_id from vehicle_assignments a
     where a.vehicle_id = vd.vehicle_id
       and a.started_at < ((vd.day + 1)::timestamp at time zone $3::text)
       and (a.ended_at is null or a.ended_at >= ((vd.day + 1)::timestamp at time zone $3::text))
     order by a.started_at desc limit 1
  ) driver on true`;

/** The daily vehicle stats read model. */
export class PostgresVehicleStatsStore implements IVehicleStatsStore {
  constructor(private readonly transactions: PostgresTransactionContext) {}

  private get tx() {
    return this.transactions.current();
  }

  async lock(): Promise<void> {
    await this.tx.query("select pg_advisory_xact_lock(hashtext('daily_vehicle_stats'))");
  }

  async state(): Promise<StatsState> {
    const { rows } = await this.tx.query<{
      built: string | null;
      dirty: string | null;
      last: string | null;
    }>(
      `select (select stats_built_through::text from organisation) as built,
              min(from_date)::text as dirty, max(id) as last
         from stats_dirty_marks`,
    );
    const row = rows[0]!;
    return {
      builtThrough: row.built,
      dirtyFrom: row.dirty,
      lastMarkId: row.last === null ? null : Number(row.last),
    };
  }

  async earliestActivity(timezone: string): Promise<string | null> {
    const { rows } = await this.tx.query<{ day: string | null }>(
      `select least(
         (select min((created_at at time zone $1::text)::date) from vehicles),
         (select min(e.entry_date) from journal_entries e
           where exists (select 1 from ledger_lines l where l.entry_id = e.id and l.vehicle_id is not null)),
         (select min((read_at at time zone $1::text)::date) from odometer_readings),
         (select min((filled_at at time zone $1::text)::date) from fuel_logs)
       )::text as day`,
      [timezone],
    );
    return rows[0]!.day;
  }

  async rebuild(from: string, to: string, timezone: string): Promise<number> {
    await this.tx.query("delete from daily_vehicle_stats where stat_date between $1 and $2", [
      from,
      to,
    ]);
    const result = await this.tx.query(REBUILD, [from, to, timezone]);
    return result.rowCount ?? 0;
  }

  async built(through: string, lastMarkId: number | null): Promise<void> {
    await this.tx.query("update organisation set stats_built_through = $1", [through]);
    if (lastMarkId !== null)
      await this.tx.query("delete from stats_dirty_marks where id <= $1", [lastMarkId]);
  }
}

/** Dashboard aggregations over business dates. */
export class PostgresDashboardQueries implements IDashboardQueries {
  constructor(private readonly transactions: PostgresTransactionContext) {}

  private get tx() {
    return this.transactions.current();
  }

  async vehicleTotals(
    from: string,
    to: string,
    filter: BranchFilter & Readonly<{ vehicleId?: string; groupId?: string }>,
  ): Promise<VehicleStatsRow[]> {
    const { rows } = await this.tx.query<{
      vehicle_id: string;
      code: string;
      plate_number: string | null;
      make: string;
      model: string;
      branch_id: string;
      mileage_unit: "km" | "mi";
      acquisition_cost_minor: string | null;
      residual_value_minor: string | null;
      depreciation_method: "none" | "straight_line";
      acquisition_date: string | null;
      useful_life_months: number | null;
      remittance: string;
      rental: string;
      other: string;
      cost: string;
      distance: string;
      litres: string;
      fuel_cost: string;
      working: string;
      idle: string;
      off_road: string;
      days: string;
    }>(
      `select s.vehicle_id, v.code, v.plate_number, v.make, v.model, v.branch_id, v.mileage_unit,
              v.acquisition_cost_minor, v.residual_value_minor, v.depreciation_method,
              v.acquisition_date::text as acquisition_date, v.useful_life_months,
              sum(s.remittance_income_minor) as remittance, sum(s.rental_income_minor) as rental,
              sum(s.other_income_minor) as other, sum(s.cost_minor) as cost,
              sum(s.distance) as distance, sum(s.fuel_litres) as litres,
              sum(s.fuel_cost_minor) as fuel_cost,
              count(*) filter (where s.status = any($7::text[])) as working,
              count(*) filter (where s.status = any($8::text[])) as idle,
              count(*) filter (where s.status = any($9::text[])) as off_road,
              count(*) as days
         from daily_vehicle_stats s
         join vehicles v on v.id = s.vehicle_id
        where s.stat_date between $1 and $2
          and ($3::uuid[] is null or s.branch_id = any($3::uuid[]))
          and ($4::uuid is null or s.branch_id = $4)
          and ($5::uuid is null or s.vehicle_id = $5)
          and ($6::uuid is null or exists (select 1 from vehicle_group_members g
                where g.vehicle_id = s.vehicle_id and g.group_id = $6))
        group by s.vehicle_id, v.id`,
      [
        from,
        to,
        ...scope(filter),
        filter.vehicleId ?? null,
        filter.groupId ?? null,
        WORKING_STATUSES,
        IDLE_STATUSES,
        OFF_ROAD_STATUSES,
      ],
    );
    return rows.map((r) => {
      const asset: DepreciableAsset = {
        acquisitionCostMinor:
          r.acquisition_cost_minor === null ? null : n(r.acquisition_cost_minor),
        residualValueMinor: r.residual_value_minor === null ? null : n(r.residual_value_minor),
        depreciationMethod: r.depreciation_method,
        acquisitionDate: r.acquisition_date,
        usefulLifeMonths: r.useful_life_months,
      };
      const working = n(r.working);
      const idle = n(r.idle);
      const offRoad = n(r.off_road);
      return {
        vehicleId: r.vehicle_id,
        code: r.code,
        plateNumber: r.plate_number,
        make: r.make,
        model: r.model,
        branchId: r.branch_id,
        mileageUnit: r.mileage_unit,
        asset,
        remittanceIncomeMinor: n(r.remittance),
        rentalIncomeMinor: n(r.rental),
        otherIncomeMinor: n(r.other),
        costMinor: n(r.cost),
        distance: n(r.distance),
        fuelLitres: n(r.litres),
        fuelCostMinor: n(r.fuel_cost),
        days: { working, idle, off_road: offRoad, other: n(r.days) - working - idle - offRoad },
      };
    });
  }

  async vehicleDays(vehicleId: string, from: string, to: string): Promise<VehicleStatsDay[]> {
    const { rows } = await this.tx.query<{
      day: string;
      status: VehicleStatus;
      driver_id: string | null;
      remittance_income_minor: string;
      rental_income_minor: string;
      other_income_minor: string;
      cost_minor: string;
      distance: string;
      fuel_litres: string;
    }>(
      `select stat_date::text as day, status, driver_id, remittance_income_minor,
              rental_income_minor, other_income_minor, cost_minor, distance, fuel_litres
         from daily_vehicle_stats
        where vehicle_id = $1 and stat_date between $2 and $3
        order by stat_date`,
      [vehicleId, from, to],
    );
    return rows.map((r) => ({
      date: r.day,
      status: r.status,
      driverId: r.driver_id,
      remittanceIncomeMinor: n(r.remittance_income_minor),
      rentalIncomeMinor: n(r.rental_income_minor),
      otherIncomeMinor: n(r.other_income_minor),
      costMinor: n(r.cost_minor),
      distance: n(r.distance),
      fuelLitres: n(r.fuel_litres),
    }));
  }

  async ledgerDays(from: string, to: string, filter: BranchFilter): Promise<LedgerDay[]> {
    const { rows } = await this.tx.query<{
      day: string;
      source: IncomeSource | null;
      income: string;
      cost: string;
    }>(
      `select e.entry_date::text as day,
              case when a.type <> 'income' then null
                   when a.system_key = 'remittance_income' then 'remittances'
                   when a.system_key = 'rental_income' then 'rentals'
                   else 'other' end as source,
              coalesce(sum(l.credit_minor - l.debit_minor) filter (where a.type = 'income'), 0)
                as income,
              coalesce(sum(l.debit_minor - l.credit_minor) filter (where a.type = 'expense'), 0)
                as cost
         from ledger_lines l
         join journal_entries e on e.id = l.entry_id
         join ledger_accounts a on a.id = l.account_id
        where a.type in ('income', 'expense') and e.entry_date between $1 and $2
          and ($3::uuid[] is null or l.branch_id = any($3::uuid[]))
          and ($4::uuid is null or l.branch_id = $4)
        group by 1, 2
        order by 1`,
      [from, to, ...scope(filter)],
    );
    return rows.map((r) => ({
      date: r.day,
      source: r.source,
      incomeMinor: n(r.income),
      costMinor: n(r.cost),
    }));
  }

  async costsByAccount(from: string, to: string, filter: BranchFilter): Promise<AccountTotal[]> {
    const { rows } = await this.tx.query<{
      id: string;
      code: string;
      name: string;
      amount: string;
    }>(
      `select a.id, a.code, a.name, sum(l.debit_minor - l.credit_minor) as amount
         from ledger_lines l
         join journal_entries e on e.id = l.entry_id
         join ledger_accounts a on a.id = l.account_id
        where a.type = 'expense' and e.entry_date between $1 and $2
          and ($3::uuid[] is null or l.branch_id = any($3::uuid[]))
          and ($4::uuid is null or l.branch_id = $4)
        group by a.id
       having sum(l.debit_minor - l.credit_minor) <> 0
        order by 4 desc, a.code`,
      [from, to, ...scope(filter)],
    );
    return rows.map((r) => ({
      accountId: r.id,
      code: r.code,
      name: r.name,
      amountMinor: n(r.amount),
    }));
  }

  async cashDays(from: string, to: string, filter: BranchFilter): Promise<CashDay[]> {
    const { rows } = await this.tx.query<{ day: string; money_in: string; money_out: string }>(
      `select paid_on::text as day,
              coalesce(sum(amount_base_minor) filter (where direction = 'in'), 0) as money_in,
              coalesce(sum(amount_base_minor) filter (where direction = 'out'), 0) as money_out
         from payments
        where status = 'recorded' and paid_on between $1 and $2
          and ($3::uuid[] is null or branch_id = any($3::uuid[]))
          and ($4::uuid is null or branch_id = $4)
        group by paid_on
        order by paid_on`,
      [from, to, ...scope(filter)],
    );
    return rows.map((r) => ({ date: r.day, inMinor: n(r.money_in), outMinor: n(r.money_out) }));
  }

  async remittanceDays(from: string, to: string, filter: BranchFilter): Promise<RemittanceDay[]> {
    const { rows } = await this.tx.query<{
      day: string;
      status: string;
      mode: "fixed_target" | "variable";
      count: string;
      expected: string;
      received: string;
      waived: string;
      outstanding: string;
    }>(
      `select period_end::text as day, status, mode, count(*) as count,
              coalesce(sum(expected_minor), 0) as expected, sum(received_minor) as received,
              sum(waived_minor) as waived,
              coalesce(sum(greatest(expected_minor - received_minor - waived_minor, 0)), 0)
                as outstanding
         from remittances
        where period_end between $1 and $2
          and ($3::uuid[] is null or branch_id = any($3::uuid[]))
          and ($4::uuid is null or branch_id = $4)
        group by period_end, status, mode
        order by period_end`,
      [from, to, ...scope(filter)],
    );
    return rows.map((r) => ({
      date: r.day,
      status: r.status,
      mode: r.mode,
      count: n(r.count),
      expectedMinor: n(r.expected),
      receivedMinor: n(r.received),
      waivedMinor: n(r.waived),
      outstandingMinor: n(r.outstanding),
    }));
  }

  async driverShortfalls(
    from: string,
    to: string,
    filter: BranchFilter,
    limit: number,
  ): Promise<DriverShortfall[]> {
    const { rows } = await this.tx.query<{
      driver_id: string;
      code: string;
      name: string;
      periods: string;
      expected: string;
      received: string;
      outstanding: string;
    }>(
      `select r.driver_id, d.code, d.first_name || ' ' || d.last_name as name,
              count(*) filter (where r.expected_minor > r.received_minor + r.waived_minor)
                as periods,
              sum(r.expected_minor) as expected, sum(r.received_minor) as received,
              sum(greatest(r.expected_minor - r.received_minor - r.waived_minor, 0)) as outstanding
         from remittances r
         join drivers d on d.id = r.driver_id
        where r.mode = 'fixed_target' and r.period_end between $1 and $2
          and ($3::uuid[] is null or r.branch_id = any($3::uuid[]))
          and ($4::uuid is null or r.branch_id = $4)
        group by r.driver_id, d.id
       having sum(greatest(r.expected_minor - r.received_minor - r.waived_minor, 0)) > 0
        order by 7 desc, d.code
        limit $5`,
      [from, to, ...scope(filter), limit],
    );
    return rows.map((r) => ({
      driverId: r.driver_id,
      code: r.code,
      name: r.name,
      periods: n(r.periods),
      expectedMinor: n(r.expected),
      receivedMinor: n(r.received),
      outstandingMinor: n(r.outstanding),
    }));
  }

  async expenseDays(from: string, to: string, filter: BranchFilter): Promise<ExpenseDay[]> {
    const { rows } = await this.tx.query<{
      day: string;
      category_id: string;
      category_name: string;
      count: string;
      amount: string;
      net: string;
      tax: string;
    }>(
      `select e.expense_date::text as day, c.id as category_id, c.name as category_name,
              count(*) as count, sum(e.amount_base_minor) as amount,
              sum(e.net_base_minor) as net, sum(e.tax_base_minor) as tax
         from expenses e
         join expense_categories c on c.id = e.category_id
        where e.status in ('approved', 'paid') and e.expense_date between $1 and $2
          and ($3::uuid[] is null or e.branch_id = any($3::uuid[]))
          and ($4::uuid is null or e.branch_id = $4)
        group by e.expense_date, c.id
        order by e.expense_date`,
      [from, to, ...scope(filter)],
    );
    return rows.map((r) => ({
      date: r.day,
      categoryId: r.category_id,
      categoryName: r.category_name,
      count: n(r.count),
      amountMinor: n(r.amount),
      netMinor: n(r.net),
      taxMinor: n(r.tax),
    }));
  }

  async vehicleSpend(
    from: string,
    to: string,
    filter: BranchFilter,
    limit: number,
  ): Promise<VehicleSpend[]> {
    const { rows } = await this.tx.query<{
      vehicle_id: string;
      code: string;
      plate_number: string | null;
      amount: string;
    }>(
      `select v.id as vehicle_id, v.code, v.plate_number, sum(l.amount_base_minor) as amount
         from expense_lines l
         join expenses e on e.id = l.expense_id
         join vehicles v on v.id = l.vehicle_id
        where e.status in ('approved', 'paid') and e.expense_date between $1 and $2
          and ($3::uuid[] is null or e.branch_id = any($3::uuid[]))
          and ($4::uuid is null or e.branch_id = $4)
        group by v.id
        order by 4 desc, v.code
        limit $5`,
      [from, to, ...scope(filter), limit],
    );
    return rows.map((r) => ({
      vehicleId: r.vehicle_id,
      code: r.code,
      plateNumber: r.plate_number,
      amountMinor: n(r.amount),
    }));
  }

  async pendingExpenses(filter: BranchFilter) {
    const { rows } = await this.tx.query<{ count: string; amount: string }>(
      `select count(*) as count, coalesce(sum(amount_base_minor), 0) as amount
         from expenses
        where status = 'submitted'
          and ($1::uuid[] is null or branch_id = any($1::uuid[]))
          and ($2::uuid is null or branch_id = $2)`,
      scope(filter),
    );
    return { count: n(rows[0]!.count), amountMinor: n(rows[0]!.amount) };
  }
}
