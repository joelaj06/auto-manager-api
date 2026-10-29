import type { AppraisalFilter, IAppraisals } from "../../application/ports/IDealerDeals.js";
import { Appraisal, type AppraisalProps } from "../../domain/dealer/Appraisal.js";
import type { PostgresTransactionContext } from "../database/postgres/PostgresTransactionContext.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const COLUMNS = [
  "id",
  "number",
  "branch_id",
  "lead_id",
  "customer_id",
  "status",
  "make",
  "model",
  "year",
  "plate_number",
  "vin",
  "colour",
  "mileage",
  "condition",
  "findings",
  "value_minor",
  "valid_until",
  "appraised_by",
  "appraised_on",
  "deal_id",
  "vehicle_id",
  "declined_reason",
  "created_at",
  "updated_at",
] as const;
type Column = (typeof COLUMNS)[number];
type Row = Record<Column, unknown>;
const SELECT = COLUMNS.map((c) =>
  c === "valid_until" || c === "appraised_on" ? `a.${c}::text as ${c}` : `a.${c}`,
).join(", ");

function toRow(p: AppraisalProps): Row {
  return {
    id: p.id,
    number: p.number,
    branch_id: p.branchId,
    lead_id: p.leadId,
    customer_id: p.customerId,
    status: p.status,
    make: p.make,
    model: p.model,
    year: p.year,
    plate_number: p.plateNumber,
    vin: p.vin,
    colour: p.colour,
    mileage: p.mileage,
    condition: p.condition,
    findings: p.findings,
    value_minor: p.valueMinor,
    valid_until: p.validUntil,
    appraised_by: p.appraisedBy,
    appraised_on: p.appraisedOn,
    deal_id: p.dealId,
    vehicle_id: p.vehicleId,
    declined_reason: p.declinedReason,
    created_at: p.createdAt,
    updated_at: p.updatedAt,
  };
}

const toAppraisal = (r: Row): Appraisal =>
  Appraisal.restore({
    id: r.id as string,
    number: r.number as string,
    branchId: r.branch_id as string,
    leadId: r.lead_id as string | null,
    customerId: r.customer_id as string | null,
    status: r.status as AppraisalProps["status"],
    make: r.make as string,
    model: r.model as string,
    year: r.year as number | null,
    plateNumber: r.plate_number as string | null,
    vin: r.vin as string | null,
    colour: r.colour as string | null,
    mileage: r.mileage as number | null,
    condition: r.condition as AppraisalProps["condition"],
    findings: r.findings as string | null,
    valueMinor: Number(r.value_minor),
    validUntil: r.valid_until as string,
    appraisedBy: r.appraised_by as string,
    appraisedOn: r.appraised_on as string,
    dealId: r.deal_id as string | null,
    vehicleId: r.vehicle_id as string | null,
    declinedReason: r.declined_reason as string | null,
    createdAt: r.created_at as Date,
    updatedAt: r.updated_at as Date,
  });

export class PostgresAppraisals implements IAppraisals {
  constructor(private readonly transactions: PostgresTransactionContext) {}

  private get tx() {
    return this.transactions.current();
  }

  async insert(appraisal: Appraisal): Promise<void> {
    const values = toRow(appraisal.snapshot());
    await this.tx.query(
      `insert into dealer_appraisals (${COLUMNS.join(", ")})
       values (${COLUMNS.map((_, i) => `$${i + 1}`).join(", ")})`,
      COLUMNS.map((c) => values[c]),
    );
  }

  async update(appraisal: Appraisal): Promise<void> {
    const values = toRow(appraisal.snapshot());
    const changed = COLUMNS.filter((c) => c !== "id" && c !== "created_at");
    await this.tx.query(
      `update dealer_appraisals set ${changed.map((c, i) => `${c} = $${i + 2}`).join(", ")}
        where id = $1`,
      [values.id, ...changed.map((c) => values[c])],
    );
  }

  get(id: string): Promise<Appraisal | null> {
    return this.one(id, "");
  }

  lock(id: string): Promise<Appraisal | null> {
    return this.one(id, "for update");
  }

  async list(filter: AppraisalFilter): Promise<Appraisal[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, value: unknown) => {
      params.push(value);
      where.push(sql.replace("?", `$${params.length}`));
    };
    if (filter.branchIds !== "all") add("a.branch_id = any(?::uuid[])", filter.branchIds);
    if (filter.statuses !== undefined) add("a.status = any(?::text[])", filter.statuses);
    if (filter.leadId !== undefined) add("a.lead_id = ?", filter.leadId);
    if (filter.customerId !== undefined) add("a.customer_id = ?", filter.customerId);
    if (filter.beforeId !== undefined && UUID.test(filter.beforeId))
      add("a.id < ?", filter.beforeId);
    params.push(filter.limit);
    const { rows } = await this.tx.query<Row>(
      `select ${SELECT} from dealer_appraisals a
        ${where.length === 0 ? "" : `where ${where.join(" and ")}`}
        order by a.id desc limit $${params.length}`,
      params,
    );
    return rows.map(toAppraisal);
  }

  private async one(id: string, lock: string): Promise<Appraisal | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.tx.query<Row>(
      `select ${SELECT} from dealer_appraisals a where a.id = $1 ${lock}`,
      [id],
    );
    return rows[0] === undefined ? null : toAppraisal(rows[0]);
  }
}
