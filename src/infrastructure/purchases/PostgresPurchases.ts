import type {
  ImportWatch,
  IPurchases,
  NewPurchaseCost,
  PurchaseCostRecord,
  PurchaseEvent,
  PurchaseFilter,
} from "../../application/ports/IPurchases.js";
import type { Allocation, CostKind } from "../../domain/purchases/LandedCost.js";
import {
  Purchase,
  type ImportStage,
  type PurchaseLine,
  type PurchaseProps,
} from "../../domain/purchases/Purchase.js";
import type { PostgresTransactionContext } from "../database/postgres/PostgresTransactionContext.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const COLUMNS = [
  "id",
  "number",
  "type",
  "status",
  "stage",
  "supplier_id",
  "branch_id",
  "currency",
  "reference",
  "expected_on",
  "notes",
  "vessel",
  "bill_of_lading",
  "container_number",
  "eta",
  "port_free_days",
  "ordered_on",
  "ordered_by",
  "arrived_on",
  "released_on",
  "received_on",
  "cancelled_at",
  "cancelled_by",
  "cancel_reason",
  "created_by",
  "created_at",
  "updated_at",
] as const;
type Column = (typeof COLUMNS)[number];
const DATES = new Set<Column>([
  "expected_on",
  "eta",
  "ordered_on",
  "arrived_on",
  "released_on",
  "received_on",
]);
const SELECT = COLUMNS.map((c) => (DATES.has(c) ? `${c}::text as ${c}` : c)).join(", ");

type Row = Record<Column, unknown>;
type LineRow = {
  id: string;
  purchase_id: string;
  position: number;
  vin: string | null;
  make: string;
  model: string;
  year: number | null;
  colour: string | null;
  description: string | null;
  price_minor: string;
  vehicle_id: string | null;
  received_at: Date | null;
  received_by: string | null;
};

function toRow(p: PurchaseProps): Row {
  return {
    id: p.id,
    number: p.number,
    type: p.type,
    status: p.status,
    stage: p.stage,
    supplier_id: p.supplierId,
    branch_id: p.branchId,
    currency: p.currency,
    reference: p.reference,
    expected_on: p.expectedOn,
    notes: p.notes,
    vessel: p.vessel,
    bill_of_lading: p.billOfLading,
    container_number: p.containerNumber,
    eta: p.eta,
    port_free_days: p.portFreeDays,
    ordered_on: p.orderedOn,
    ordered_by: p.orderedBy,
    arrived_on: p.arrivedOn,
    released_on: p.releasedOn,
    received_on: p.receivedOn,
    cancelled_at: p.cancelledAt,
    cancelled_by: p.cancelledBy,
    cancel_reason: p.cancelReason,
    created_by: p.createdBy,
    created_at: p.createdAt,
    updated_at: p.updatedAt,
  };
}

function toProps(r: Row, lines: PurchaseLine[]): PurchaseProps {
  return {
    id: r.id as string,
    number: r.number as string,
    type: r.type as PurchaseProps["type"],
    status: r.status as PurchaseProps["status"],
    stage: r.stage as ImportStage | null,
    supplierId: r.supplier_id as string,
    branchId: r.branch_id as string,
    currency: (r.currency as string).trim(),
    reference: r.reference as string | null,
    expectedOn: r.expected_on as string | null,
    notes: r.notes as string | null,
    vessel: r.vessel as string | null,
    billOfLading: r.bill_of_lading as string | null,
    containerNumber: r.container_number as string | null,
    eta: r.eta as string | null,
    portFreeDays: r.port_free_days as number | null,
    orderedOn: r.ordered_on as string | null,
    orderedBy: r.ordered_by as string | null,
    arrivedOn: r.arrived_on as string | null,
    releasedOn: r.released_on as string | null,
    receivedOn: r.received_on as string | null,
    cancelledAt: r.cancelled_at as Date | null,
    cancelledBy: r.cancelled_by as string | null,
    cancelReason: r.cancel_reason as string | null,
    createdBy: r.created_by as string | null,
    createdAt: r.created_at as Date,
    updatedAt: r.updated_at as Date,
    lines,
  };
}

const toLine = (r: LineRow): PurchaseLine => ({
  id: r.id,
  position: r.position,
  vin: r.vin,
  make: r.make,
  model: r.model,
  year: r.year,
  colour: r.colour,
  description: r.description,
  priceMinor: Number(r.price_minor),
  vehicleId: r.vehicle_id,
  receivedAt: r.received_at,
  receivedBy: r.received_by,
});

export class PostgresPurchases implements IPurchases {
  constructor(private readonly transactions: PostgresTransactionContext) {}

  private get tx() {
    return this.transactions.current();
  }

  async insert(purchase: Purchase): Promise<void> {
    const values = toRow(purchase.snapshot());
    await this.tx.query(
      `insert into purchases (${COLUMNS.join(", ")})
       values (${COLUMNS.map((_, i) => `$${i + 1}`).join(", ")})`,
      COLUMNS.map((c) => values[c]),
    );
    await this.lines(purchase);
  }

  async update(purchase: Purchase): Promise<void> {
    const values = toRow(purchase.snapshot());
    const changed = COLUMNS.filter((c) => c !== "id" && c !== "created_at");
    await this.tx.query(
      `update purchases set ${changed.map((c, i) => `${c} = $${i + 2}`).join(", ")}
        where id = $1`,
      [values.id, ...changed.map((c) => values[c])],
    );
    await this.lines(purchase);
  }

  get(id: string): Promise<Purchase | null> {
    return this.one(id, "");
  }

  lock(id: string): Promise<Purchase | null> {
    return this.one(id, "for update");
  }

  async list(filter: PurchaseFilter): Promise<Purchase[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, value: unknown) => {
      params.push(value);
      where.push(sql.replace("?", `$${params.length}`));
    };
    if (filter.branchIds !== "all") add("branch_id = any(?::uuid[])", filter.branchIds);
    if (filter.branchId !== undefined) add("branch_id = ?", filter.branchId);
    if (filter.supplierId !== undefined) add("supplier_id = ?", filter.supplierId);
    if (filter.statuses !== undefined) add("status = any(?::text[])", filter.statuses);
    if (filter.types !== undefined) add("type = any(?::text[])", filter.types);
    if (filter.beforeId !== undefined && UUID.test(filter.beforeId)) add("id < ?", filter.beforeId);
    params.push(filter.limit);
    return this.load(
      `${where.length === 0 ? "" : `where ${where.join(" and ")}`}
       order by id desc limit $${params.length}`,
      params,
    );
  }

  async addCost(c: NewPurchaseCost): Promise<void> {
    await this.tx.query(
      `insert into purchase_costs (id, purchase_id, line_id, kind, allocation, description,
         supplier_id, expense_id, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        c.id,
        c.purchaseId,
        c.lineId,
        c.kind,
        c.allocation,
        c.description,
        c.supplierId,
        c.expenseId,
        c.createdBy,
      ],
    );
  }

  async costs(purchaseId: string): Promise<PurchaseCostRecord[]> {
    if (!UUID.test(purchaseId)) return [];
    const { rows } = await this.tx.query<{
      id: string;
      purchase_id: string;
      line_id: string | null;
      kind: CostKind;
      allocation: Allocation;
      description: string;
      supplier_id: string;
      supplier_name: string;
      expense_id: string;
      expense_number: string | null;
      expense_status: string;
      currency: string;
      fx_rate: string;
      amount_minor: string;
      amount_base_minor: string;
      net_base_minor: string;
      created_by: string | null;
      created_at: Date;
    }>(
      `select c.id, c.purchase_id, c.line_id, c.kind, c.allocation, c.description, c.supplier_id,
              s.name as supplier_name, c.expense_id, e.number as expense_number,
              e.status as expense_status, e.currency, e.fx_rate::text as fx_rate, e.amount_minor,
              e.amount_base_minor, e.net_base_minor, c.created_by, c.created_at
         from purchase_costs c
         join expenses e on e.id = c.expense_id
         join suppliers s on s.id = c.supplier_id
        where c.purchase_id = $1
        order by c.created_at, c.id`,
      [purchaseId],
    );
    return rows.map((r) => ({
      id: r.id,
      purchaseId: r.purchase_id,
      lineId: r.line_id,
      kind: r.kind,
      allocation: r.allocation,
      description: r.description,
      supplierId: r.supplier_id,
      supplierName: r.supplier_name,
      expenseId: r.expense_id,
      expenseNumber: r.expense_number,
      expenseStatus: r.expense_status,
      currency: r.currency.trim(),
      fxRate: trimRate(r.fx_rate),
      amountMinor: Number(r.amount_minor),
      amountBaseMinor: Number(r.amount_base_minor),
      netBaseMinor: Number(r.net_base_minor),
      createdBy: r.created_by,
      createdAt: r.created_at,
    }));
  }

  async purchaseOfCost(costId: string): Promise<string | null> {
    if (!UUID.test(costId)) return null;
    const { rows } = await this.tx.query<{ purchase_id: string }>(
      "select purchase_id from purchase_costs where id = $1",
      [costId],
    );
    return rows[0]?.purchase_id ?? null;
  }

  async addEvent(e: PurchaseEvent): Promise<void> {
    await this.tx.query(
      `insert into purchase_events (id, purchase_id, kind, stage, occurred_on, note, details,
         recorded_by, recorded_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        e.id,
        e.purchaseId,
        e.kind,
        e.stage,
        e.occurredOn,
        e.note,
        JSON.stringify(e.details),
        e.recordedBy,
        e.recordedAt,
      ],
    );
  }

  async events(purchaseId: string): Promise<PurchaseEvent[]> {
    if (!UUID.test(purchaseId)) return [];
    const { rows } = await this.tx.query<{
      id: string;
      purchase_id: string;
      kind: PurchaseEvent["kind"];
      stage: ImportStage | null;
      occurred_on: string;
      note: string | null;
      details: PurchaseEvent["details"];
      recorded_by: string | null;
      recorded_at: Date;
    }>(
      `select id, purchase_id, kind, stage, occurred_on::text as occurred_on, note, details,
              recorded_by, recorded_at
         from purchase_events where purchase_id = $1 order by recorded_at, id`,
      [purchaseId],
    );
    return rows.map((r) => ({
      id: r.id,
      purchaseId: r.purchase_id,
      kind: r.kind,
      stage: r.stage,
      occurredOn: r.occurred_on,
      note: r.note,
      details: r.details,
      recordedBy: r.recorded_by,
      recordedAt: r.recorded_at,
    }));
  }

  async importsUnderWay(): Promise<ImportWatch[]> {
    const { rows } = await this.tx.query<{
      id: string;
      number: string;
      branch_id: string;
      supplier_name: string;
      stage: ImportStage;
      eta: string | null;
      arrived_on: string | null;
      port_free_days: number | null;
    }>(
      `select p.id, p.number, p.branch_id, s.name as supplier_name, p.stage, p.eta::text as eta,
              p.arrived_on::text as arrived_on, p.port_free_days
         from purchases p join suppliers s on s.id = p.supplier_id
        where p.status = 'ordered' and p.type = 'import'
          and p.stage in ('shipped', 'arrived_port', 'under_clearing', 'duty_paid')
        order by p.number`,
    );
    return rows.map((r) => ({
      purchaseId: r.id,
      number: r.number,
      branchId: r.branch_id,
      supplierName: r.supplier_name,
      stage: r.stage,
      eta: r.eta,
      arrivedOn: r.arrived_on,
      portFreeDays: r.port_free_days,
    }));
  }

  async supplierExists(id: string): Promise<boolean> {
    if (!UUID.test(id)) return false;
    const { rows } = await this.tx.query(
      "select 1 from suppliers where id = $1 and active and deleted_at is null",
      [id],
    );
    return rows.length > 0;
  }

  async supplierName(id: string): Promise<string> {
    const { rows } = await this.tx.query<{ name: string }>(
      "select name from suppliers where id = $1",
      [id],
    );
    return rows[0]?.name ?? "";
  }

  private async one(id: string, lock: string): Promise<Purchase | null> {
    if (!UUID.test(id)) return null;
    return (await this.load(`where id = $1 ${lock}`, [id]))[0] ?? null;
  }

  private async load(clause: string, params: readonly unknown[]): Promise<Purchase[]> {
    const { rows } = await this.tx.query<Row>(`select ${SELECT} from purchases ${clause}`, [
      ...params,
    ]);
    if (rows.length === 0) return [];
    const lines = await this.tx.query<LineRow>(
      `select id, purchase_id, position, vin, make, model, year, colour, description, price_minor,
              vehicle_id, received_at, received_by
         from purchase_lines where purchase_id = any($1::uuid[]) order by position`,
      [rows.map((r) => r.id)],
    );
    return rows.map((r) =>
      Purchase.restore(toProps(r, lines.rows.filter((l) => l.purchase_id === r.id).map(toLine))),
    );
  }

  /** Upserts the lines and drops those no longer on the purchase (drafts only have no costs). */
  private async lines(purchase: Purchase): Promise<void> {
    const p = purchase.snapshot();
    await this.tx.query(
      "delete from purchase_lines where purchase_id = $1 and not (id = any($2::uuid[]))",
      [p.id, p.lines.map((l) => l.id)],
    );
    for (const l of p.lines)
      await this.tx.query(
        `insert into purchase_lines (id, purchase_id, position, vin, make, model, year, colour,
           description, price_minor, vehicle_id, received_at, received_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         on conflict (id) do update set position = excluded.position, vin = excluded.vin,
           make = excluded.make, model = excluded.model, year = excluded.year,
           colour = excluded.colour, description = excluded.description,
           price_minor = excluded.price_minor, vehicle_id = excluded.vehicle_id,
           received_at = excluded.received_at, received_by = excluded.received_by`,
        [
          l.id,
          p.id,
          l.position,
          l.vin,
          l.make,
          l.model,
          l.year,
          l.colour,
          l.description,
          l.priceMinor,
          l.vehicleId,
          l.receivedAt,
          l.receivedBy,
        ],
      );
  }
}

/** "15.5000000000" → "15.5". */
function trimRate(rate: string): string {
  return rate.includes(".") ? rate.replace(/0+$/, "").replace(/\.$/, "") : rate;
}
