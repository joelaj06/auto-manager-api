import type {
  IParts,
  MoveFilter,
  PartFilter,
  PartMove,
  StockRow,
} from "../../application/ports/IParts.js";
import { Part, Stock, type Fit, type PartProps } from "../../domain/maintenance/Part.js";
import type { PostgresTransactionContext } from "../database/postgres/PostgresTransactionContext.js";

type PartRow = {
  id: string;
  sku: string;
  name: string;
  unit: PartProps["unit"];
  category: string | null;
  compatible: Fit[];
  notes: string | null;
  active: boolean;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
};

type StockDbRow = {
  id: string;
  part_id: string;
  branch_id: string;
  on_hand: string;
  avg_cost_minor: string;
  reorder_level: string | null;
  reorder_qty: string | null;
  location: string | null;
  below_since: Date | null;
  updated_at: Date;
};

type MoveRow = {
  id: string;
  part_id: string;
  branch_id: string;
  kind: PartMove["kind"];
  quantity: string;
  unit_cost_minor: string;
  value_minor: string;
  on_hand_after: string;
  avg_cost_after: string;
  work_order_id: string | null;
  supplier_id: string | null;
  expense_id: string | null;
  transfer_id: string | null;
  reference: string | null;
  reason: string | null;
  created_by: string | null;
  created_at: Date;
};

const PART_COLUMNS =
  "id, sku, name, unit, category, compatible, notes, active, created_by, created_at, updated_at";
const STOCK_COLUMNS = `s.id, s.part_id, s.branch_id, s.on_hand::text as on_hand,
  s.avg_cost_minor::text as avg_cost_minor, s.reorder_level::text as reorder_level,
  s.reorder_qty::text as reorder_qty, s.location, s.below_since, s.updated_at`;

export class PostgresParts implements IParts {
  constructor(private readonly transactions: PostgresTransactionContext) {}

  private get tx() {
    return this.transactions.current();
  }

  async insert(part: Part): Promise<void> {
    const p = part.snapshot();
    await this.tx.query(
      `insert into parts (id, sku, name, unit, category, compatible, notes, active, created_by,
         created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11)`,
      [
        p.id,
        p.sku,
        p.name,
        p.unit,
        p.category,
        JSON.stringify(p.compatible),
        p.notes,
        p.active,
        p.createdBy,
        p.createdAt,
        p.updatedAt,
      ],
    );
  }

  async update(part: Part): Promise<void> {
    const p = part.snapshot();
    await this.tx.query(
      `update parts set sku = $2, name = $3, unit = $4, category = $5, compatible = $6::jsonb,
              notes = $7, active = $8, updated_at = $9
        where id = $1`,
      [
        p.id,
        p.sku,
        p.name,
        p.unit,
        p.category,
        JSON.stringify(p.compatible),
        p.notes,
        p.active,
        p.updatedAt,
      ],
    );
  }

  async get(id: string): Promise<Part | null> {
    const { rows } = await this.tx.query<PartRow>(
      `select ${PART_COLUMNS} from parts where id = $1`,
      [id],
    );
    return rows[0] === undefined ? null : part(rows[0]);
  }

  async skuTaken(sku: string, exceptId: string | null): Promise<boolean> {
    const { rows } = await this.tx.query(
      "select 1 from parts where sku = $1 and id is distinct from $2",
      [sku, exceptId],
    );
    return rows.length > 0;
  }

  async list(filter: PartFilter): Promise<Part[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (!filter.includeInactive) where.push("active");
    if (filter.search !== undefined) {
      params.push(`%${filter.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
      where.push(`(sku ilike $${params.length} or name ilike $${params.length})`);
    }
    if (filter.category !== undefined) {
      params.push(filter.category);
      where.push(`lower(category) = lower($${params.length})`);
    }
    params.push(filter.limit);
    const { rows } = await this.tx.query<PartRow>(
      `select ${PART_COLUMNS} from parts
        ${where.length === 0 ? "" : `where ${where.join(" and ")}`}
        order by lower(name), sku limit $${params.length}`,
      params,
    );
    return rows.map(part);
  }

  async lockStock(partId: string, branchId: string): Promise<Stock> {
    await this.tx.query(
      `insert into part_stock (part_id, branch_id) values ($1, $2)
       on conflict (part_id, branch_id) do nothing`,
      [partId, branchId],
    );
    const { rows } = await this.tx.query<StockDbRow>(
      `select ${STOCK_COLUMNS} from part_stock s where s.part_id = $1 and s.branch_id = $2
        for update`,
      [partId, branchId],
    );
    return stock(rows[0]!);
  }

  async saveStock(s: Stock): Promise<void> {
    const p = s.snapshot();
    await this.tx.query(
      `update part_stock set on_hand = $2, avg_cost_minor = $3, reorder_level = $4,
              reorder_qty = $5, location = $6, below_since = $7, updated_at = $8
        where id = $1`,
      [
        p.id,
        p.onHand,
        p.avgCostMinor,
        p.reorderLevel,
        p.reorderQty,
        p.location,
        p.belowSince,
        p.updatedAt,
      ],
    );
  }

  stockOf(partId: string, branchIds: "all" | readonly string[]): Promise<StockRow[]> {
    return this.stockRows(["s.part_id = $1"], [partId], branchIds);
  }

  stock(
    filter: Readonly<{ branchIds: "all" | readonly string[]; branchId?: string; low?: boolean }>,
  ): Promise<StockRow[]> {
    const where: string[] = ["p.active"];
    const params: unknown[] = [];
    if (filter.branchId !== undefined) {
      params.push(filter.branchId);
      where.push(`s.branch_id = $${params.length}`);
    }
    if (filter.low === true)
      where.push("s.reorder_level is not null and s.on_hand <= s.reorder_level");
    return this.stockRows(where, params, filter.branchIds);
  }

  async costAt(partId: string, branchId: string): Promise<number | null> {
    const { rows } = await this.tx.query<{ avg_cost_minor: string }>(
      `select avg_cost_minor::text as avg_cost_minor from part_stock
        where part_id = $1 and branch_id = $2`,
      [partId, branchId],
    );
    return rows[0] === undefined ? null : Number(rows[0].avg_cost_minor);
  }

  async addMove(m: PartMove): Promise<void> {
    await this.tx.query(
      `insert into part_moves (id, part_id, branch_id, kind, quantity, unit_cost_minor,
         value_minor, on_hand_after, avg_cost_after, work_order_id, supplier_id, expense_id,
         transfer_id, reference, reason, created_by, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
      [
        m.id,
        m.partId,
        m.branchId,
        m.kind,
        m.quantity,
        m.unitCostMinor,
        m.valueMinor,
        m.onHandAfter,
        m.avgCostAfter,
        m.workOrderId,
        m.supplierId,
        m.expenseId,
        m.transferId,
        m.reference,
        m.reason,
        m.createdBy,
        m.createdAt,
      ],
    );
  }

  async supplierExists(id: string): Promise<boolean> {
    const { rows } = await this.tx.query(
      "select 1 from suppliers where id = $1 and active and deleted_at is null",
      [id],
    );
    return rows.length > 0;
  }

  async moves(filter: MoveFilter): Promise<PartMove[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, value: unknown) => {
      params.push(value);
      where.push(sql.replace("?", `$${params.length}`));
    };
    if (filter.branchIds !== "all") add("branch_id = any(?::uuid[])", filter.branchIds);
    if (filter.partId !== undefined) add("part_id = ?", filter.partId);
    if (filter.branchId !== undefined) add("branch_id = ?", filter.branchId);
    if (filter.workOrderId !== undefined) add("work_order_id = ?", filter.workOrderId);
    if (filter.beforeId !== undefined) add("id < ?", filter.beforeId);
    params.push(filter.limit);
    const { rows } = await this.tx.query<MoveRow>(
      `select id, part_id, branch_id, kind, quantity::text as quantity,
              unit_cost_minor::text as unit_cost_minor, value_minor::text as value_minor,
              on_hand_after::text as on_hand_after, avg_cost_after::text as avg_cost_after,
              work_order_id, supplier_id, expense_id, transfer_id, reference, reason, created_by,
              created_at
         from part_moves ${where.length === 0 ? "" : `where ${where.join(" and ")}`}
        order by id desc limit $${params.length}`,
      params,
    );
    return rows.map((r) => ({
      id: r.id,
      partId: r.part_id,
      branchId: r.branch_id,
      kind: r.kind,
      quantity: Number(r.quantity),
      unitCostMinor: Number(r.unit_cost_minor),
      valueMinor: Number(r.value_minor),
      onHandAfter: Number(r.on_hand_after),
      avgCostAfter: Number(r.avg_cost_after),
      workOrderId: r.work_order_id,
      supplierId: r.supplier_id,
      expenseId: r.expense_id,
      transferId: r.transfer_id,
      reference: r.reference,
      reason: r.reason,
      createdBy: r.created_by,
      createdAt: r.created_at,
    }));
  }

  private async stockRows(
    where: string[],
    params: unknown[],
    branchIds: "all" | readonly string[],
  ): Promise<StockRow[]> {
    const all = [...where];
    const values = [...params];
    if (branchIds !== "all") {
      values.push(branchIds);
      all.push(`s.branch_id = any($${values.length}::uuid[])`);
    }
    const { rows } = await this.tx.query<
      StockDbRow & { sku: string; name: string; unit: string; branch_name: string }
    >(
      `select ${STOCK_COLUMNS}, p.sku, p.name, p.unit, b.name as branch_name
         from part_stock s
         join parts p on p.id = s.part_id
         join branches b on b.id = s.branch_id
        where ${all.join(" and ")}
        order by lower(p.name), p.sku, b.name`,
      values,
    );
    return rows.map((r) => ({
      stock: stock(r),
      sku: r.sku,
      name: r.name,
      unit: r.unit,
      branchName: r.branch_name,
    }));
  }
}

function part(r: PartRow): Part {
  return Part.restore({
    id: r.id,
    sku: r.sku,
    name: r.name,
    unit: r.unit,
    category: r.category,
    compatible: r.compatible,
    notes: r.notes,
    active: r.active,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });
}

function stock(r: StockDbRow): Stock {
  return Stock.restore({
    id: r.id,
    partId: r.part_id,
    branchId: r.branch_id,
    onHand: Number(r.on_hand),
    avgCostMinor: Number(r.avg_cost_minor),
    reorderLevel: r.reorder_level === null ? null : Number(r.reorder_level),
    reorderQty: r.reorder_qty === null ? null : Number(r.reorder_qty),
    location: r.location,
    belowSince: r.below_since,
    updatedAt: r.updated_at,
  });
}
