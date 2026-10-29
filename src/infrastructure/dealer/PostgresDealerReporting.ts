import type {
  CollectedRow,
  DatePeriod,
  DealBalanceRow,
  DealDepositRow,
  DealerReportFilter,
  IDealerReporting,
  InstantPeriod,
  LeadSummary,
  PriceReductionRow,
  SalesSummary,
  StockOnHand,
} from "../../application/ports/IDealerReporting.js";
import { DEAL_SOURCE } from "../../application/ports/IDealerDeals.js";
import { TRADE_IN_SOURCE } from "../../domain/finance/Payment.js";
import type { PostgresTransactionContext } from "../database/postgres/PostgresTransactionContext.js";

const ON_HAND = ["incoming", "reconditioning", "ready", "listed", "reserved"];

/** The dealer reports' queries (docs/10 §10): one round trip each, filtered by branch. */
export class PostgresDealerReporting implements IDealerReporting {
  constructor(private readonly transactions: PostgresTransactionContext) {}

  private get tx() {
    return this.transactions.current();
  }

  async priceReductions(
    period: InstantPeriod,
    filter: DealerReportFilter,
  ): Promise<PriceReductionRow[]> {
    const { rows } = await this.tx.query<{
      id: string;
      vehicle_id: string;
      code: string;
      plate_number: string | null;
      make: string;
      model: string;
      year: number | null;
      branch_id: string;
      status: PriceReductionRow["stockStatus"];
      stocked_on: string;
      previous_asking_minor: string;
      asking_price_minor: string;
      reason: string | null;
      changed_by: string | null;
      changed_by_name: string | null;
      changed_at: Date;
    }>(
      `select c.id, c.vehicle_id, v.code, v.plate_number, v.make, v.model, v.year, v.branch_id,
              s.status, s.stocked_on::text as stocked_on, c.previous_asking_minor,
              c.asking_price_minor, c.reason, c.changed_by, u.name as changed_by_name, c.changed_at
         from dealer_price_changes c
         join dealer_stock s on s.vehicle_id = c.vehicle_id
         join vehicles v on v.id = c.vehicle_id
         left join users u on u.id = c.changed_by
        where c.changed_at >= $1 and c.changed_at < $2
          and c.asking_price_minor < c.previous_asking_minor
          and ($3::uuid[] is null or v.branch_id = any($3))
          and ($4::uuid is null or v.branch_id = $4)
        order by c.changed_at, c.id`,
      [period.from, period.to, ...branchParams(filter)],
    );
    return rows.map((r) => ({
      changeId: r.id,
      vehicleId: r.vehicle_id,
      vehicleCode: r.code,
      plateNumber: r.plate_number,
      make: r.make,
      model: r.model,
      year: r.year,
      branchId: r.branch_id,
      stockStatus: r.status,
      stockedOn: r.stocked_on,
      previousAskingMinor: Number(r.previous_asking_minor),
      askingMinor: Number(r.asking_price_minor),
      reason: r.reason,
      changedBy: r.changed_by,
      changedByName: r.changed_by_name,
      changedAt: r.changed_at,
    }));
  }

  async collected(period: DatePeriod, filter: DealerReportFilter): Promise<CollectedRow[]> {
    const { rows } = await this.tx.query<{
      branch_id: string;
      method: string;
      payments: string;
      amount_minor: string;
    }>(
      `select d.branch_id, p.method, count(*) as payments,
              sum(p.amount_base_minor) as amount_minor
         from payments p
         join dealer_deals d on d.id = p.source_id
        where p.source_type = any($1::text[]) and p.direction = 'in' and p.status = 'recorded'
          and p.paid_on between $2::date and $3::date
          and ($4::uuid[] is null or d.branch_id = any($4))
          and ($5::uuid is null or d.branch_id = $5)
        group by d.branch_id, p.method
        order by d.branch_id, p.method`,
      [[DEAL_SOURCE, TRADE_IN_SOURCE], period.from, period.to, ...branchParams(filter)],
    );
    return rows.map((r) => ({
      branchId: r.branch_id,
      method: r.method,
      payments: Number(r.payments),
      amountMinor: Number(r.amount_minor),
    }));
  }

  async balances(filter: DealerReportFilter): Promise<DealBalanceRow[]> {
    const { rows } = await this.tx.query<{
      id: string;
      number: string;
      status: DealBalanceRow["status"];
      financing: DealBalanceRow["financing"];
      branch_id: string;
      customer_id: string;
      customer_name: string;
      sales_executive_id: string;
      sold_on: string;
      invoiced: string;
      paid: string;
    }>(
      `select d.id, d.number, d.status, d.financing, d.branch_id, d.customer_id,
              c.name as customer_name, d.sales_executive_id, d.sold_on::text as sold_on,
              i.invoiced, i.paid
         from dealer_deals d
         join customers c on c.id = d.customer_id
         cross join lateral (
           select coalesce(sum(total_minor), 0) as invoiced, coalesce(sum(paid_minor), 0) as paid
             from invoices
            where id in (d.invoice_id, d.charge_invoice_id) and status <> 'void') i
        where d.status in ('sold', 'delivered') and i.invoiced > i.paid
          and ($1::uuid[] is null or d.branch_id = any($1))
          and ($2::uuid is null or d.branch_id = $2)
        order by d.sold_on, d.number`,
      branchParams(filter),
    );
    return rows.map((r) => ({
      dealId: r.id,
      number: r.number,
      status: r.status,
      financing: r.financing,
      branchId: r.branch_id,
      customerId: r.customer_id,
      customerName: r.customer_name,
      salesExecutiveId: r.sales_executive_id,
      soldOn: r.sold_on,
      invoicedMinor: Number(r.invoiced),
      paidMinor: Number(r.paid),
    }));
  }

  async deposits(filter: DealerReportFilter): Promise<DealDepositRow[]> {
    const { rows } = await this.tx.query<{
      id: string;
      number: string;
      status: DealDepositRow["status"];
      branch_id: string;
      customer_name: string;
      held: string;
      hold_until: string | null;
    }>(
      `select d.id, d.number, d.status, d.branch_id, c.name as customer_name, h.held,
              d.hold_until::text as hold_until
         from dealer_deals d
         join customers c on c.id = d.customer_id
         cross join lateral (
           select coalesce(sum(amount_base_minor - allocated_minor), 0) as held
             from payments
            where source_type = $1 and source_id = d.id and direction = 'in'
              and status = 'recorded') h
        where d.status in ('draft', 'reserved') and h.held > 0
          and ($2::uuid[] is null or d.branch_id = any($2))
          and ($3::uuid is null or d.branch_id = $3)
        order by d.created_at, d.id`,
      [DEAL_SOURCE, ...branchParams(filter)],
    );
    return rows.map((r) => ({
      dealId: r.id,
      number: r.number,
      status: r.status,
      branchId: r.branch_id,
      customerName: r.customer_name,
      heldMinor: Number(r.held),
      holdUntil: r.hold_until,
    }));
  }

  async sales(period: DatePeriod, filter: DealerReportFilter): Promise<SalesSummary> {
    const { rows } = await this.tx.query<{
      sold: string;
      revenue: string;
      days: string;
      delivered: string;
    }>(
      `select count(*) filter (where d.sold_on between $1::date and $2::date) as sold,
              coalesce(sum(i.subtotal_minor) filter (
                where d.sold_on between $1::date and $2::date and i.status <> 'void'), 0) as revenue,
              coalesce(sum(greatest(0, d.sold_on - s.stocked_on)) filter (
                where d.sold_on between $1::date and $2::date), 0) as days,
              count(*) filter (where d.delivered_on between $1::date and $2::date) as delivered
         from dealer_deals d
         left join invoices i on i.id = d.invoice_id
         left join dealer_stock s on s.vehicle_id = d.vehicle_id
        where d.status in ('sold', 'delivered')
          and ($3::uuid[] is null or d.branch_id = any($3))
          and ($4::uuid is null or d.branch_id = $4)`,
      [period.from, period.to, ...branchParams(filter)],
    );
    const r = rows[0]!;
    return {
      sold: Number(r.sold),
      revenueMinor: Number(r.revenue),
      delivered: Number(r.delivered),
      daysToSell: Number(r.days),
    };
  }

  async stockOnHand(today: string, filter: DealerReportFilter): Promise<StockOnHand> {
    const { rows } = await this.tx.query<{ count: string; asking: string; aged: string }>(
      `select count(*) as count, coalesce(sum(s.asking_price_minor), 0) as asking,
              count(*) filter (where $2::date - s.stocked_on > 90) as aged
         from dealer_stock s
         join vehicles v on v.id = s.vehicle_id
        where s.status = any($1::text[]) and v.deleted_at is null
          and ($3::uuid[] is null or v.branch_id = any($3))
          and ($4::uuid is null or v.branch_id = $4)`,
      [ON_HAND, today, ...branchParams(filter)],
    );
    const r = rows[0]!;
    return { count: Number(r.count), askingMinor: Number(r.asking), agedOver90: Number(r.aged) };
  }

  async leads(period: InstantPeriod, filter: DealerReportFilter): Promise<LeadSummary> {
    const { rows } = await this.tx.query<{ created: string; won: string; lost: string }>(
      `select count(*) filter (where created_at >= $1 and created_at < $2) as created,
              count(*) filter (where stage = 'won' and closed_at >= $1 and closed_at < $2) as won,
              count(*) filter (where stage = 'lost' and closed_at >= $1 and closed_at < $2) as lost
         from dealer_leads
        where ($3::uuid[] is null or branch_id = any($3))
          and ($4::uuid is null or branch_id = $4)`,
      [period.from, period.to, ...branchParams(filter)],
    );
    const r = rows[0]!;
    return { created: Number(r.created), won: Number(r.won), lost: Number(r.lost) };
  }
}

const branchParams = (filter: DealerReportFilter): [readonly string[] | null, string | null] => [
  filter.branchIds === "all" ? null : filter.branchIds,
  filter.branchId,
];
