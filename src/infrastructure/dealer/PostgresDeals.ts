import {
  DEAL_SOURCE,
  type DealCustomer,
  type DealFilter,
  type DealPayment,
  type IDeals,
} from "../../application/ports/IDealerDeals.js";
import {
  Deal,
  type ChecklistItem,
  type DealProps,
  type ScheduledInstalment,
} from "../../domain/dealer/Deal.js";
import type { AddOn } from "../../domain/dealer/Quote.js";
import { TRADE_IN_SOURCE } from "../../domain/finance/Payment.js";
import type { PostgresTransactionContext } from "../database/postgres/PostgresTransactionContext.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const COLUMNS = [
  "id",
  "number",
  "branch_id",
  "vehicle_id",
  "customer_id",
  "lead_id",
  "quote_id",
  "sales_executive_id",
  "status",
  "price_minor",
  "discount_minor",
  "needs_approval",
  "approved_by",
  "approved_at",
  "trade_in_id",
  "trade_in_minor",
  "financing",
  "lender",
  "loan_minor",
  "loan_status",
  "loan_reference",
  "down_payment_minor",
  "plan_markup_percent",
  "plan_frequency",
  "plan_months",
  "plan_first_due_on",
  "plan_charge_minor",
  "warranty_months",
  "service_vouchers",
  "notes",
  "hold_until",
  "reserved_at",
  "sold_on",
  "invoice_id",
  "charge_invoice_id",
  "trade_in_payment_id",
  "agreement_document_id",
  "delivered_on",
  "delivery_odometer",
  "delivery_checklist",
  "delivery_document_id",
  "warranty_ends_on",
  "cancelled_at",
  "cancel_reason",
  "created_by",
  "created_at",
  "updated_at",
] as const;
type Column = (typeof COLUMNS)[number];
type Row = Record<Column, unknown>;
const DATES: readonly Column[] = [
  "plan_first_due_on",
  "hold_until",
  "sold_on",
  "delivered_on",
  "warranty_ends_on",
];
const SELECT = COLUMNS.map((c) => (DATES.includes(c) ? `d.${c}::text as ${c}` : `d.${c}`)).join(
  ", ",
);

const minor = (value: unknown): number | null => (value === null ? null : Number(value));

function toRow(p: DealProps): Row {
  return {
    id: p.id,
    number: p.number,
    branch_id: p.branchId,
    vehicle_id: p.vehicleId,
    customer_id: p.customerId,
    lead_id: p.leadId,
    quote_id: p.quoteId,
    sales_executive_id: p.salesExecutiveId,
    status: p.status,
    price_minor: p.priceMinor,
    discount_minor: p.discountMinor,
    needs_approval: p.needsApproval,
    approved_by: p.approvedBy,
    approved_at: p.approvedAt,
    trade_in_id: p.tradeIn?.appraisalId ?? null,
    trade_in_minor: p.tradeIn?.valueMinor ?? 0,
    financing: p.financing,
    lender: p.loan?.lender ?? null,
    loan_minor: p.loan?.loanMinor ?? null,
    loan_status: p.loanStatus,
    loan_reference: p.loan?.reference ?? null,
    down_payment_minor: p.plan?.downPaymentMinor ?? null,
    plan_markup_percent: p.plan?.markupPercent ?? null,
    plan_frequency: p.plan?.frequency ?? null,
    plan_months: p.plan?.months ?? null,
    plan_first_due_on: p.plan?.firstDueOn ?? null,
    plan_charge_minor: p.planChargeMinor,
    warranty_months: p.warrantyMonths,
    service_vouchers: p.serviceVouchers,
    notes: p.notes,
    hold_until: p.holdUntil,
    reserved_at: p.reservedAt,
    sold_on: p.soldOn,
    invoice_id: p.invoiceId,
    charge_invoice_id: p.chargeInvoiceId,
    trade_in_payment_id: p.tradeInPaymentId,
    agreement_document_id: p.agreementDocumentId,
    delivered_on: p.deliveredOn,
    delivery_odometer: p.deliveryOdometer,
    delivery_checklist: p.deliveryChecklist === null ? null : JSON.stringify(p.deliveryChecklist),
    delivery_document_id: p.deliveryDocumentId,
    warranty_ends_on: p.warrantyEndsOn,
    cancelled_at: p.cancelledAt,
    cancel_reason: p.cancelReason,
    created_by: p.createdBy,
    created_at: p.createdAt,
    updated_at: p.updatedAt,
  };
}

const toDeal = (r: Row, addOns: AddOn[]): Deal =>
  Deal.restore({
    id: r.id as string,
    number: r.number as string,
    branchId: r.branch_id as string,
    vehicleId: r.vehicle_id as string,
    customerId: r.customer_id as string,
    leadId: r.lead_id as string | null,
    quoteId: r.quote_id as string | null,
    salesExecutiveId: r.sales_executive_id as string,
    status: r.status as DealProps["status"],
    priceMinor: Number(r.price_minor),
    discountMinor: Number(r.discount_minor),
    addOns,
    needsApproval: r.needs_approval as boolean,
    approvedBy: r.approved_by as string | null,
    approvedAt: r.approved_at as Date | null,
    tradeIn:
      r.trade_in_id === null
        ? null
        : { appraisalId: r.trade_in_id as string, valueMinor: Number(r.trade_in_minor) },
    financing: r.financing as DealProps["financing"],
    loan:
      r.lender === null
        ? null
        : {
            lender: r.lender as string,
            loanMinor: Number(r.loan_minor),
            reference: r.loan_reference as string | null,
          },
    loanStatus: r.loan_status as DealProps["loanStatus"],
    plan:
      r.plan_markup_percent === null
        ? null
        : {
            downPaymentMinor: Number(r.down_payment_minor),
            markupPercent: r.plan_markup_percent as string,
            frequency: r.plan_frequency as "weekly" | "monthly",
            months: r.plan_months as number,
            firstDueOn: r.plan_first_due_on as string | null,
          },
    planChargeMinor: minor(r.plan_charge_minor),
    warrantyMonths: r.warranty_months as number,
    serviceVouchers: r.service_vouchers as number,
    notes: r.notes as string | null,
    holdUntil: r.hold_until as string | null,
    reservedAt: r.reserved_at as Date | null,
    soldOn: r.sold_on as string | null,
    invoiceId: r.invoice_id as string | null,
    chargeInvoiceId: r.charge_invoice_id as string | null,
    tradeInPaymentId: r.trade_in_payment_id as string | null,
    agreementDocumentId: r.agreement_document_id as string | null,
    deliveredOn: r.delivered_on as string | null,
    deliveryOdometer: r.delivery_odometer as number | null,
    deliveryChecklist: r.delivery_checklist as ChecklistItem[] | null,
    deliveryDocumentId: r.delivery_document_id as string | null,
    warrantyEndsOn: r.warranty_ends_on as string | null,
    cancelledAt: r.cancelled_at as Date | null,
    cancelReason: r.cancel_reason as string | null,
    createdBy: r.created_by as string | null,
    createdAt: r.created_at as Date,
    updatedAt: r.updated_at as Date,
  });

export class PostgresDeals implements IDeals {
  constructor(private readonly transactions: PostgresTransactionContext) {}

  private get tx() {
    return this.transactions.current();
  }

  async insert(deal: Deal): Promise<void> {
    const values = toRow(deal.snapshot());
    await this.tx.query(
      `insert into dealer_deals (${COLUMNS.join(", ")})
       values (${COLUMNS.map((_, i) => `$${i + 1}`).join(", ")})`,
      COLUMNS.map((c) => values[c]),
    );
    await this.items(deal);
  }

  async update(deal: Deal): Promise<void> {
    const values = toRow(deal.snapshot());
    const changed = COLUMNS.filter((c) => c !== "id" && c !== "created_at");
    await this.tx.query(
      `update dealer_deals set ${changed.map((c, i) => `${c} = $${i + 2}`).join(", ")}
        where id = $1`,
      [values.id, ...changed.map((c) => values[c])],
    );
    await this.items(deal);
  }

  get(id: string): Promise<Deal | null> {
    return this.one(id, "");
  }

  lock(id: string): Promise<Deal | null> {
    return this.one(id, "for update");
  }

  async list(filter: DealFilter): Promise<Deal[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, value: unknown) => {
      params.push(value);
      where.push(sql.replace("?", `$${params.length}`));
    };
    if (filter.branchIds !== "all") add("d.branch_id = any(?::uuid[])", filter.branchIds);
    if (filter.salesExecutiveId !== undefined)
      add("d.sales_executive_id = ?", filter.salesExecutiveId);
    if (filter.statuses !== undefined) add("d.status = any(?::text[])", filter.statuses);
    if (filter.customerId !== undefined) add("d.customer_id = ?", filter.customerId);
    if (filter.vehicleId !== undefined) add("d.vehicle_id = ?", filter.vehicleId);
    if (filter.leadId !== undefined) add("d.lead_id = ?", filter.leadId);
    if (filter.beforeId !== undefined && UUID.test(filter.beforeId))
      add("d.id < ?", filter.beforeId);
    params.push(filter.limit);
    return this.load(
      `${where.length === 0 ? "" : `where ${where.join(" and ")}`}
       order by d.id desc limit $${params.length}`,
      params,
    );
  }

  async liveForVehicle(vehicleId: string): Promise<string | null> {
    const { rows } = await this.tx.query<{ id: string }>(
      `select id from dealer_deals
        where vehicle_id = $1 and status in ('draft', 'reserved', 'sold')`,
      [vehicleId],
    );
    return rows[0]?.id ?? null;
  }

  async prepayments(dealId: string): Promise<{ paymentId: string; unallocatedMinor: number }[]> {
    const { rows } = await this.tx.query<{ id: string; unallocated: string }>(
      `select id, amount_minor - allocated_minor as unallocated from payments
        where source_type = $2 and source_id = $1 and direction = 'in'
          and status = 'recorded' and allocated_minor < amount_minor
        order by recorded_at, id`,
      [dealId, DEAL_SOURCE],
    );
    return rows.map((r) => ({ paymentId: r.id, unallocatedMinor: Number(r.unallocated) }));
  }

  async payments(dealId: string): Promise<DealPayment[]> {
    const { rows } = await this.tx.query<{
      id: string;
      number: string;
      method: DealPayment["method"];
      paid_on: string;
      amount_minor: string;
      allocated_minor: string;
      status: DealPayment["status"];
      notes: string | null;
    }>(
      `select id, number, method, paid_on::text as paid_on, amount_minor, allocated_minor,
              status, notes
         from payments
        where source_id = $1 and source_type = any($2::text[]) and direction = 'in'
        order by recorded_at, id`,
      [dealId, [DEAL_SOURCE, TRADE_IN_SOURCE]],
    );
    return rows.map((r) => ({
      id: r.id,
      number: r.number,
      method: r.method,
      paidOn: r.paid_on,
      amountMinor: Number(r.amount_minor),
      unallocatedMinor:
        r.status === "recorded" ? Number(r.amount_minor) - Number(r.allocated_minor) : 0,
      status: r.status,
      notes: r.notes,
    }));
  }

  async saveSchedule(dealId: string, schedule: readonly ScheduledInstalment[]): Promise<void> {
    await this.tx.query("delete from dealer_deal_instalments where deal_id = $1", [dealId]);
    if (schedule.length > 0)
      await this.tx.query(
        `insert into dealer_deal_instalments (deal_id, number, due_on, amount_minor)
         select $1, n, d, a from unnest($2::int[], $3::date[], $4::bigint[]) as x (n, d, a)`,
        [
          dealId,
          schedule.map((i) => i.number),
          schedule.map((i) => i.dueOn),
          schedule.map((i) => i.amountMinor),
        ],
      );
  }

  async schedule(dealId: string): Promise<ScheduledInstalment[]> {
    const { rows } = await this.tx.query<{ number: number; due_on: string; amount_minor: string }>(
      `select number, due_on::text as due_on, amount_minor from dealer_deal_instalments
        where deal_id = $1 order by number`,
      [dealId],
    );
    return rows.map((r) => ({
      number: r.number,
      dueOn: r.due_on,
      amountMinor: Number(r.amount_minor),
    }));
  }

  async lapsedReservations(today: string): Promise<string[]> {
    const { rows } = await this.tx.query<{ id: string }>(
      `select id from dealer_deals where status = 'reserved' and hold_until < $1::date
        order by id`,
      [today],
    );
    return rows.map((r) => r.id);
  }

  async withUnnoticedDue(today: string): Promise<string[]> {
    const { rows } = await this.tx.query<{ deal_id: string }>(
      `select distinct i.deal_id from dealer_deal_instalments i
         join dealer_deals d on d.id = i.deal_id
        where d.status in ('sold', 'delivered') and i.due_on < $1::date
          and i.overdue_noticed_at is null
        order by i.deal_id`,
      [today],
    );
    return rows.map((r) => r.deal_id);
  }

  async markNoticed(dealId: string, numbers: readonly number[], at: Date): Promise<void> {
    if (numbers.length === 0) return;
    await this.tx.query(
      `update dealer_deal_instalments set overdue_noticed_at = $3
        where deal_id = $1 and number = any($2::int[])`,
      [dealId, numbers, at],
    );
  }

  async noticed(dealId: string): Promise<Set<number>> {
    const { rows } = await this.tx.query<{ number: number }>(
      `select number from dealer_deal_instalments
        where deal_id = $1 and overdue_noticed_at is not null`,
      [dealId],
    );
    return new Set(rows.map((r) => r.number));
  }

  async customer(id: string): Promise<DealCustomer | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.tx.query<{
      id: string;
      name: string;
      phone: string | null;
      email: string | null;
      address: string | null;
      ghana_card_number: string | null;
    }>(
      `select id, name, phone, email, address, ghana_card_number from customers
        where id = $1 and deleted_at is null`,
      [id],
    );
    const r = rows[0];
    return r === undefined
      ? null
      : {
          id: r.id,
          name: r.name,
          phone: r.phone,
          email: r.email,
          address: r.address,
          ghanaCardNumber: r.ghana_card_number,
        };
  }

  private async items(deal: Deal): Promise<void> {
    const p = deal.snapshot();
    await this.tx.query("delete from dealer_deal_items where deal_id = $1", [p.id]);
    if (p.addOns.length > 0)
      await this.tx.query(
        `insert into dealer_deal_items (deal_id, position, kind, description, amount_minor)
         select $1, n, k, d, a
           from unnest($2::text[], $3::text[], $4::bigint[]) with ordinality as x (k, d, a, n)`,
        [
          p.id,
          p.addOns.map((a) => a.kind),
          p.addOns.map((a) => a.description),
          p.addOns.map((a) => a.amountMinor),
        ],
      );
  }

  private async one(id: string, lock: string): Promise<Deal | null> {
    if (!UUID.test(id)) return null;
    const [deal] = await this.load(`where d.id = $1 ${lock}`, [id]);
    return deal ?? null;
  }

  private async load(tail: string, params: unknown[]): Promise<Deal[]> {
    const { rows } = await this.tx.query<Row>(
      `select ${SELECT} from dealer_deals d ${tail}`,
      params,
    );
    if (rows.length === 0) return [];
    const items = await this.tx.query<{
      deal_id: string;
      kind: AddOn["kind"];
      description: string;
      amount_minor: string;
    }>(
      `select deal_id, kind, description, amount_minor from dealer_deal_items
        where deal_id = any($1::uuid[]) order by deal_id, position`,
      [rows.map((r) => r.id)],
    );
    return rows.map((r) =>
      toDeal(
        r,
        items.rows
          .filter((i) => i.deal_id === r.id)
          .map((i) => ({
            kind: i.kind,
            description: i.description,
            amountMinor: Number(i.amount_minor),
          })),
      ),
    );
  }
}
