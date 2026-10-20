import type { IDriverAppLinks } from "../../application/ports/IDriverAppLinks.js";
import type {
  IVehicleIssueRepository,
  VehicleIssueFilter,
} from "../../domain/repositories/IVehicleIssueRepository.js";
import { VehicleIssue, type VehicleIssueProps } from "../../domain/vehicles/VehicleIssue.js";
import type { PostgresTransactionContext } from "../database/postgres/PostgresTransactionContext.js";

export class PostgresDriverAppLinks implements IDriverAppLinks {
  constructor(private readonly transactions: PostgresTransactionContext) {}

  private get tx() {
    return this.transactions.current();
  }

  async driverOf(userId: string): Promise<string | null> {
    const { rows } = await this.tx.query<{ id: string }>(
      "select id from drivers where user_id = $1 and deleted_at is null",
      [userId],
    );
    return rows[0]?.id ?? null;
  }

  async userOf(driverId: string): Promise<string | null> {
    const { rows } = await this.tx.query<{ user_id: string | null }>(
      "select user_id from drivers where id = $1",
      [driverId],
    );
    return rows[0]?.user_id ?? null;
  }

  async link(driverId: string, userId: string): Promise<void> {
    await this.tx.query("update drivers set user_id = $2, updated_at = now() where id = $1", [
      driverId,
      userId,
    ]);
  }
}

type Row = {
  id: string;
  number: string;
  vehicle_id: string;
  branch_id: string;
  driver_id: string | null;
  reported_by: string | null;
  type: VehicleIssueProps["type"];
  severity: VehicleIssueProps["severity"];
  can_drive: boolean;
  description: string;
  odometer: number | null;
  location: string | null;
  occurred_at: Date;
  status: VehicleIssueProps["status"];
  acknowledged_by: string | null;
  acknowledged_at: Date | null;
  resolution: string | null;
  resolved_by: string | null;
  resolved_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

const toIssue = (r: Row) =>
  VehicleIssue.restore({
    id: r.id,
    number: r.number,
    vehicleId: r.vehicle_id,
    branchId: r.branch_id,
    driverId: r.driver_id,
    reportedBy: r.reported_by,
    type: r.type,
    severity: r.severity,
    canDrive: r.can_drive,
    description: r.description,
    odometer: r.odometer,
    location: r.location,
    occurredAt: r.occurred_at,
    status: r.status,
    acknowledgedBy: r.acknowledged_by,
    acknowledgedAt: r.acknowledged_at,
    resolution: r.resolution,
    resolvedBy: r.resolved_by,
    resolvedAt: r.resolved_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });

export class PostgresVehicleIssues implements IVehicleIssueRepository {
  constructor(private readonly transactions: PostgresTransactionContext) {}

  private get tx() {
    return this.transactions.current();
  }

  async findById(id: string): Promise<VehicleIssue | null> {
    const { rows } = await this.tx.query<Row>("select * from vehicle_issues where id = $1", [id]);
    return rows[0] === undefined ? null : toIssue(rows[0]);
  }

  async lockById(id: string): Promise<VehicleIssue | null> {
    const { rows } = await this.tx.query<Row>(
      "select * from vehicle_issues where id = $1 for update",
      [id],
    );
    return rows[0] === undefined ? null : toIssue(rows[0]);
  }

  async save(issue: VehicleIssue): Promise<void> {
    const p = issue.snapshot();
    await this.tx.query(
      `insert into vehicle_issues (id, number, vehicle_id, branch_id, driver_id, reported_by, type,
         severity, can_drive, description, odometer, location, occurred_at, status,
         acknowledged_by, acknowledged_at, resolution, resolved_by, resolved_at, created_at,
         updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
               $19, $20, $21)
       on conflict (id) do update set
         status = excluded.status, acknowledged_by = excluded.acknowledged_by,
         acknowledged_at = excluded.acknowledged_at, resolution = excluded.resolution,
         resolved_by = excluded.resolved_by, resolved_at = excluded.resolved_at,
         updated_at = excluded.updated_at`,
      [
        p.id,
        p.number,
        p.vehicleId,
        p.branchId,
        p.driverId,
        p.reportedBy,
        p.type,
        p.severity,
        p.canDrive,
        p.description,
        p.odometer,
        p.location,
        p.occurredAt,
        p.status,
        p.acknowledgedBy,
        p.acknowledgedAt,
        p.resolution,
        p.resolvedBy,
        p.resolvedAt,
        p.createdAt,
        p.updatedAt,
      ],
    );
  }

  async list(filter: VehicleIssueFilter): Promise<VehicleIssue[]> {
    const { rows } = await this.tx.query<Row>(
      `select * from vehicle_issues
        where ($1::uuid[] is null or branch_id = any($1::uuid[]))
          and ($2::uuid is null or branch_id = $2)
          and ($3::uuid is null or vehicle_id = $3)
          and ($4::uuid is null or driver_id = $4)
          and ($5::text[] is null or status = any($5::text[]))
          and ($6::uuid is null or id < $6)
        order by id desc
        limit $7`,
      [
        filter.branchIds === "all" ? null : filter.branchIds,
        filter.branchId ?? null,
        filter.vehicleId ?? null,
        filter.driverId ?? null,
        filter.statuses ?? null,
        filter.afterId ?? null,
        filter.limit,
      ],
    );
    return rows.map(toIssue);
  }
}
