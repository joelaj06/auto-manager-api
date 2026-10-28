import type {
  IWorkOrders,
  VendorRecord,
  WorkOrderFilter,
} from "../../application/ports/IWorkOrders.js";
import {
  WorkOrder,
  type Allocation,
  type WorkOrderLine,
  type WorkOrderProps,
} from "../../domain/maintenance/WorkOrder.js";
import type { PostgresTransactionContext } from "../database/postgres/PostgresTransactionContext.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type OrderRow = {
  id: string;
  number: string;
  vehicle_id: string;
  branch_id: string;
  type: WorkOrderProps["type"];
  priority: WorkOrderProps["priority"];
  status: WorkOrderProps["status"];
  title: string;
  description: string | null;
  issue_id: string | null;
  damage_id: string | null;
  service_task_ids: string[];
  vendor_id: string | null;
  assigned_to: string | null;
  warranty: boolean;
  off_road: boolean;
  block_id: string | null;
  status_before: string | null;
  workpay_agreement_id: string | null;
  expected_back_at: Date | null;
  downtime_started_at: Date | null;
  downtime_ended_at: Date | null;
  odometer_in: number | null;
  odometer_out: number | null;
  currency: string;
  vendor_invoice_ref: string | null;
  vendor_rating: number | null;
  expense_id: string | null;
  driver_expense_id: string | null;
  notes: string | null;
  started_at: Date | null;
  completed_at: Date | null;
  completed_by: string | null;
  cancelled_at: Date | null;
  cancelled_by: string | null;
  cancel_reason: string | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
};

type LineRow = {
  id: string;
  work_order_id: string;
  position: number;
  kind: WorkOrderLine["kind"];
  description: string;
  quantity: string;
  unit_cost_minor: string;
  amount_minor: string;
  part_ref: string | null;
};

type AllocationRow = {
  work_order_id: string;
  payer: Allocation["payer"];
  amount_minor: string;
  driver_id: string | null;
  customer_id: string | null;
  insurer_id: string | null;
  claim_ref: string | null;
};

const COLUMNS = [
  "id",
  "number",
  "vehicle_id",
  "branch_id",
  "type",
  "priority",
  "status",
  "title",
  "description",
  "issue_id",
  "damage_id",
  "service_task_ids",
  "vendor_id",
  "assigned_to",
  "warranty",
  "off_road",
  "block_id",
  "status_before",
  "workpay_agreement_id",
  "expected_back_at",
  "downtime_started_at",
  "downtime_ended_at",
  "odometer_in",
  "odometer_out",
  "currency",
  "vendor_invoice_ref",
  "vendor_rating",
  "expense_id",
  "driver_expense_id",
  "notes",
  "started_at",
  "completed_at",
  "completed_by",
  "cancelled_at",
  "cancelled_by",
  "cancel_reason",
  "created_by",
  "created_at",
  "updated_at",
] as const;

/** Work orders in the tenant database (docs/12 §3). */
export class PostgresWorkOrders implements IWorkOrders {
  constructor(private readonly transactions: PostgresTransactionContext) {}

  private get tx() {
    return this.transactions.current();
  }

  async insert(order: WorkOrder): Promise<void> {
    const values = toRow(order.snapshot());
    await this.tx.query(
      `insert into work_orders (${COLUMNS.join(", ")})
       values (${COLUMNS.map((_, i) => `$${i + 1}`).join(", ")})`,
      COLUMNS.map((c) => values[c]),
    );
    await this.children(order);
  }

  async update(order: WorkOrder): Promise<void> {
    const values = toRow(order.snapshot());
    const changed = COLUMNS.filter((c) => c !== "id" && c !== "created_at");
    await this.tx.query(
      `update work_orders set ${changed.map((c, i) => `${c} = $${i + 2}`).join(", ")}
        where id = $1`,
      [values.id, ...changed.map((c) => values[c])],
    );
    await this.tx.query("delete from work_order_lines where work_order_id = $1", [order.id]);
    await this.tx.query("delete from work_order_allocations where work_order_id = $1", [order.id]);
    await this.children(order);
  }

  async get(id: string): Promise<WorkOrder | null> {
    if (!UUID.test(id)) return null;
    return (await this.load("where id = $1", [id]))[0] ?? null;
  }

  async lock(id: string): Promise<WorkOrder | null> {
    if (!UUID.test(id)) return null;
    return (await this.load("where id = $1 for update", [id]))[0] ?? null;
  }

  list(filter: WorkOrderFilter): Promise<WorkOrder[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, value: unknown) => {
      params.push(value);
      where.push(sql.replace("?", `$${params.length}`));
    };
    if (filter.branchIds !== "all") add("branch_id = any(?::uuid[])", filter.branchIds);
    if (filter.branchId !== undefined) add("branch_id = ?", filter.branchId);
    if (filter.vehicleId !== undefined) add("vehicle_id = ?", filter.vehicleId);
    if (filter.vendorId !== undefined) add("vendor_id = ?", filter.vendorId);
    if (filter.statuses !== undefined) add("status = any(?::text[])", filter.statuses);
    if (filter.types !== undefined) add("type = any(?::text[])", filter.types);
    if (filter.beforeId !== undefined) add("id < ?", filter.beforeId);
    params.push(filter.limit);
    return this.load(
      `${where.length === 0 ? "" : `where ${where.join(" and ")}`}
       order by id desc limit $${params.length}`,
      params,
    );
  }

  async vendorRecord(vendorId: string): Promise<VendorRecord> {
    const { rows } = await this.tx.query<{
      work_orders: number;
      open: number;
      completed: number;
      spent: string | null;
      turnaround: string | null;
      rating: string | null;
      ratings: number;
    }>(
      `select count(*)::int as work_orders,
              count(*) filter (where o.status not in ('completed', 'cancelled'))::int as open,
              count(*) filter (where o.status = 'completed')::int as completed,
              (select coalesce(sum(l.amount_minor), 0) from work_order_lines l
                 join work_orders c on c.id = l.work_order_id
                where c.vendor_id = $1 and c.status = 'completed')::text as spent,
              avg(extract(epoch from o.completed_at - o.created_at) / 86400)
                filter (where o.status = 'completed')::text as turnaround,
              avg(o.vendor_rating)::text as rating,
              count(o.vendor_rating)::int as ratings
         from work_orders o where o.vendor_id = $1`,
      [vendorId],
    );
    const r = rows[0]!;
    const round = (value: string | null) =>
      value === null ? null : Math.round(Number(value) * 10) / 10;
    return {
      workOrders: r.work_orders,
      open: r.open,
      completed: r.completed,
      spentMinor: Number(r.spent ?? 0),
      averageTurnaroundDays: round(r.turnaround),
      averageRating: round(r.rating),
      ratings: r.ratings,
    };
  }

  async exists(kind: "supplier" | "user" | "driver", id: string): Promise<boolean> {
    if (!UUID.test(id)) return false;
    const sql = {
      supplier: "select 1 from suppliers where id = $1 and active and deleted_at is null",
      user: "select 1 from users where id = $1",
      driver: "select 1 from drivers where id = $1 and deleted_at is null",
    }[kind];
    return (await this.tx.query(sql, [id])).rows.length > 0;
  }

  async damageRenter(damageId: string): Promise<string | null> {
    const { rows } = await this.tx.query<{ customer_id: string }>(
      `select b.customer_id from vehicle_damages d join rental_bookings b on b.id = d.booking_id
        where d.id = $1`,
      [damageId],
    );
    return rows[0]?.customer_id ?? null;
  }

  // --- helpers ---

  private async children(order: WorkOrder): Promise<void> {
    const p = order.snapshot();
    for (const l of p.lines)
      await this.tx.query(
        `insert into work_order_lines (id, work_order_id, position, kind, description, quantity,
           unit_cost_minor, amount_minor, part_ref)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          l.id,
          p.id,
          l.position,
          l.kind,
          l.description,
          l.quantity,
          l.unitCostMinor,
          l.amountMinor,
          l.partRef,
        ],
      );
    for (const a of p.allocations)
      await this.tx.query(
        `insert into work_order_allocations (work_order_id, payer, amount_minor, driver_id,
           customer_id, insurer_id, claim_ref)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [p.id, a.payer, a.amountMinor, a.driverId, a.customerId, a.insurerId, a.claimRef],
      );
  }

  private async load(tail: string, params: unknown[]): Promise<WorkOrder[]> {
    const { rows } = await this.tx.query<OrderRow>(
      `select ${COLUMNS.join(", ")} from work_orders ${tail}`,
      params,
    );
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const lines = await this.tx.query<LineRow>(
      `select id, work_order_id, position, kind, description, quantity::text as quantity,
              unit_cost_minor::text as unit_cost_minor, amount_minor::text as amount_minor,
              part_ref
         from work_order_lines where work_order_id = any($1::uuid[]) order by position`,
      [ids],
    );
    const allocations = await this.tx.query<AllocationRow>(
      `select work_order_id, payer, amount_minor::text as amount_minor, driver_id, customer_id,
              insurer_id, claim_ref
         from work_order_allocations where work_order_id = any($1::uuid[])
        order by array_position(array['company','driver','customer','insurer'], payer)`,
      [ids],
    );
    return rows.map((r) =>
      WorkOrder.restore({
        id: r.id,
        number: r.number,
        vehicleId: r.vehicle_id,
        branchId: r.branch_id,
        type: r.type,
        priority: r.priority,
        status: r.status,
        title: r.title,
        description: r.description,
        issueId: r.issue_id,
        damageId: r.damage_id,
        serviceTaskIds: r.service_task_ids,
        vendorId: r.vendor_id,
        assignedTo: r.assigned_to,
        warranty: r.warranty,
        offRoad: r.off_road,
        blockId: r.block_id,
        statusBefore: r.status_before,
        workpayAgreementId: r.workpay_agreement_id,
        expectedBackAt: r.expected_back_at,
        downtimeStartedAt: r.downtime_started_at,
        downtimeEndedAt: r.downtime_ended_at,
        odometerIn: r.odometer_in,
        odometerOut: r.odometer_out,
        currency: r.currency,
        vendorInvoiceRef: r.vendor_invoice_ref,
        vendorRating: r.vendor_rating,
        expenseId: r.expense_id,
        driverExpenseId: r.driver_expense_id,
        notes: r.notes,
        lines: lines.rows
          .filter((l) => l.work_order_id === r.id)
          .map((l) => ({
            id: l.id,
            position: l.position,
            kind: l.kind,
            description: l.description,
            quantity: Number(l.quantity),
            unitCostMinor: Number(l.unit_cost_minor),
            amountMinor: Number(l.amount_minor),
            partRef: l.part_ref,
          })),
        allocations: allocations.rows
          .filter((a) => a.work_order_id === r.id)
          .map((a) => ({
            payer: a.payer,
            amountMinor: Number(a.amount_minor),
            driverId: a.driver_id,
            customerId: a.customer_id,
            insurerId: a.insurer_id,
            claimRef: a.claim_ref,
          })),
        startedAt: r.started_at,
        completedAt: r.completed_at,
        completedBy: r.completed_by,
        cancelledAt: r.cancelled_at,
        cancelledBy: r.cancelled_by,
        cancelReason: r.cancel_reason,
        createdBy: r.created_by,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      }),
    );
  }
}

function toRow(p: WorkOrderProps): Record<(typeof COLUMNS)[number], unknown> {
  return {
    id: p.id,
    number: p.number,
    vehicle_id: p.vehicleId,
    branch_id: p.branchId,
    type: p.type,
    priority: p.priority,
    status: p.status,
    title: p.title,
    description: p.description,
    issue_id: p.issueId,
    damage_id: p.damageId,
    service_task_ids: p.serviceTaskIds,
    vendor_id: p.vendorId,
    assigned_to: p.assignedTo,
    warranty: p.warranty,
    off_road: p.offRoad,
    block_id: p.blockId,
    status_before: p.statusBefore,
    workpay_agreement_id: p.workpayAgreementId,
    expected_back_at: p.expectedBackAt,
    downtime_started_at: p.downtimeStartedAt,
    downtime_ended_at: p.downtimeEndedAt,
    odometer_in: p.odometerIn,
    odometer_out: p.odometerOut,
    currency: p.currency,
    vendor_invoice_ref: p.vendorInvoiceRef,
    vendor_rating: p.vendorRating,
    expense_id: p.expenseId,
    driver_expense_id: p.driverExpenseId,
    notes: p.notes,
    started_at: p.startedAt,
    completed_at: p.completedAt,
    completed_by: p.completedBy,
    cancelled_at: p.cancelledAt,
    cancelled_by: p.cancelledBy,
    cancel_reason: p.cancelReason,
    created_by: p.createdBy,
    created_at: p.createdAt,
    updated_at: p.updatedAt,
  };
}
