import type { ITestDrives, TestDriveFilter } from "../../application/ports/IDealerSales.js";
import { TestDrive, type TestDriveProps } from "../../domain/dealer/TestDrive.js";
import type { PostgresTransactionContext } from "../database/postgres/PostgresTransactionContext.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const COLUMNS = [
  "id",
  "branch_id",
  "vehicle_id",
  "lead_id",
  "status",
  "starts_at",
  "ends_at",
  "driver_name",
  "driver_phone",
  "licence_number",
  "licence_expires_on",
  "accompanied_by",
  "block_id",
  "odometer_out",
  "odometer_in",
  "went_out_at",
  "came_back_at",
  "waiver_document_id",
  "feedback",
  "cancel_reason",
  "notes",
  "created_by",
  "created_at",
  "updated_at",
] as const;
type Column = (typeof COLUMNS)[number];
type Row = Record<Column, unknown>;
const SELECT = COLUMNS.map((c) => (c === "licence_expires_on" ? `${c}::text as ${c}` : c)).join(
  ", ",
);

function toRow(p: TestDriveProps): Row {
  return {
    id: p.id,
    branch_id: p.branchId,
    vehicle_id: p.vehicleId,
    lead_id: p.leadId,
    status: p.status,
    starts_at: p.startsAt,
    ends_at: p.endsAt,
    driver_name: p.driverName,
    driver_phone: p.driverPhone,
    licence_number: p.licenceNumber,
    licence_expires_on: p.licenceExpiresOn,
    accompanied_by: p.accompaniedBy,
    block_id: p.blockId,
    odometer_out: p.odometerOut,
    odometer_in: p.odometerIn,
    went_out_at: p.wentOutAt,
    came_back_at: p.cameBackAt,
    waiver_document_id: p.waiverDocumentId,
    feedback: p.feedback,
    cancel_reason: p.cancelReason,
    notes: p.notes,
    created_by: p.createdBy,
    created_at: p.createdAt,
    updated_at: p.updatedAt,
  };
}

const toDrive = (r: Row): TestDrive =>
  TestDrive.restore({
    id: r.id as string,
    branchId: r.branch_id as string,
    vehicleId: r.vehicle_id as string,
    leadId: r.lead_id as string | null,
    status: r.status as TestDriveProps["status"],
    startsAt: r.starts_at as Date,
    endsAt: r.ends_at as Date,
    driverName: r.driver_name as string,
    driverPhone: r.driver_phone as string,
    licenceNumber: r.licence_number as string,
    licenceExpiresOn: r.licence_expires_on as string,
    accompaniedBy: r.accompanied_by as string,
    blockId: r.block_id as string,
    odometerOut: r.odometer_out as number | null,
    odometerIn: r.odometer_in as number | null,
    wentOutAt: r.went_out_at as Date | null,
    cameBackAt: r.came_back_at as Date | null,
    waiverDocumentId: r.waiver_document_id as string | null,
    feedback: r.feedback as string | null,
    cancelReason: r.cancel_reason as string | null,
    notes: r.notes as string | null,
    createdBy: r.created_by as string | null,
    createdAt: r.created_at as Date,
    updatedAt: r.updated_at as Date,
  });

export class PostgresTestDrives implements ITestDrives {
  constructor(private readonly transactions: PostgresTransactionContext) {}

  private get tx() {
    return this.transactions.current();
  }

  async insert(drive: TestDrive): Promise<void> {
    const values = toRow(drive.snapshot());
    await this.tx.query(
      `insert into dealer_test_drives (${COLUMNS.join(", ")})
       values (${COLUMNS.map((_, i) => `$${i + 1}`).join(", ")})`,
      COLUMNS.map((c) => values[c]),
    );
  }

  async update(drive: TestDrive): Promise<void> {
    const values = toRow(drive.snapshot());
    const changed = COLUMNS.filter((c) => c !== "id" && c !== "created_at");
    await this.tx.query(
      `update dealer_test_drives set ${changed.map((c, i) => `${c} = $${i + 2}`).join(", ")}
        where id = $1`,
      [values.id, ...changed.map((c) => values[c])],
    );
  }

  get(id: string): Promise<TestDrive | null> {
    return this.one(id, "");
  }

  lock(id: string): Promise<TestDrive | null> {
    return this.one(id, "for update");
  }

  async list(filter: TestDriveFilter): Promise<TestDrive[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, value: unknown) => {
      params.push(value);
      where.push(sql.replace("?", `$${params.length}`));
    };
    if (filter.branchIds !== "all") add("branch_id = any(?::uuid[])", filter.branchIds);
    if (filter.vehicleId !== undefined) add("vehicle_id = ?", filter.vehicleId);
    if (filter.leadId !== undefined) add("lead_id = ?", filter.leadId);
    if (filter.statuses !== undefined) add("status = any(?::text[])", filter.statuses);
    if (filter.from !== undefined) add("ends_at > ?", filter.from);
    if (filter.until !== undefined) add("starts_at < ?", filter.until);
    if (filter.beforeId !== undefined && UUID.test(filter.beforeId)) add("id < ?", filter.beforeId);
    params.push(filter.limit);
    const { rows } = await this.tx.query<Row>(
      `select ${SELECT} from dealer_test_drives
        ${where.length === 0 ? "" : `where ${where.join(" and ")}`}
        order by id desc limit $${params.length}`,
      params,
    );
    return rows.map(toDrive);
  }

  private async one(id: string, lock: string): Promise<TestDrive | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.tx.query<Row>(
      `select ${SELECT} from dealer_test_drives where id = $1 ${lock}`,
      [id],
    );
    return rows[0] === undefined ? null : toDrive(rows[0]);
  }
}
