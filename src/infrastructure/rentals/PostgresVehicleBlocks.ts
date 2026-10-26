import { VehicleUnavailableError } from "../../application/errors/RentalErrors.js";
import type {
  FleetFilter,
  FleetVehicle,
  IVehicleBlocks,
} from "../../application/ports/IVehicleBlocks.js";
import {
  RENTABLE_STATUSES,
  type BlockReason,
  type BlockStatus,
  type BusyInterval,
  type VehicleBlock,
} from "../../domain/rentals/VehicleBlock.js";
import { OFF_FLEET_STATUSES, type VehicleStatus } from "../../domain/vehicles/VehicleStatus.js";
import { pgErrorCode, PgErrorCodes } from "../database/postgres/pgErrors.js";
import type { PostgresTransactionContext } from "../database/postgres/PostgresTransactionContext.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Off the fleet, or retired: never on the rental calendar. */
const GONE = [...OFF_FLEET_STATUSES, "retired"];

type BlockRow = {
  id: string;
  vehicle_id: string;
  branch_id: string;
  class_id: string | null;
  reason: BlockReason;
  status: BlockStatus;
  starts_at: Date;
  ends_at: Date | null;
  blocked_until: Date | null;
  expires_at: Date | null;
  customer_id: string | null;
  ref_type: string | null;
  ref_id: string | null;
  note: string | null;
  released_at: Date | null;
  released_reason: string | null;
  released_by: string | null;
  created_by: string | null;
  created_at: Date;
};

const toBlock = (r: BlockRow): VehicleBlock => ({
  id: r.id,
  vehicleId: r.vehicle_id,
  branchId: r.branch_id,
  classId: r.class_id,
  reason: r.reason,
  status: r.status,
  startsAt: r.starts_at,
  endsAt: r.ends_at,
  blockedUntil: r.blocked_until,
  expiresAt: r.expires_at,
  customerId: r.customer_id,
  refType: r.ref_type,
  refId: r.ref_id,
  note: r.note,
  releasedAt: r.released_at,
  releasedReason: r.released_reason,
  releasedBy: r.released_by,
  createdBy: r.created_by,
  createdAt: r.created_at,
});

type FleetRow = {
  id: string;
  code: string;
  plate_number: string | null;
  make: string;
  model: string;
  branch_id: string;
  rental_class_id: string | null;
  status: VehicleStatus;
  turnaround_minutes: number | null;
};

const toVehicle = (r: FleetRow): FleetVehicle => ({
  id: r.id,
  code: r.code,
  plateNumber: r.plate_number,
  make: r.make,
  model: r.model,
  branchId: r.branch_id,
  classId: r.rental_class_id,
  status: r.status,
  turnaroundMinutes: r.turnaround_minutes ?? 0,
});

const FLEET_SELECT = `select v.id, v.code, v.plate_number, v.make, v.model, v.branch_id,
    v.rental_class_id, v.status, c.turnaround_minutes
  from vehicles v left join vehicle_classes c on c.id = v.rental_class_id`;

/** A vehicle still out past its block (an overdue rental) stays busy until it is back. */
const OVERDUE_END =
  "case when b.status = 'out' and b.blocked_until < $2 then $2 else b.blocked_until end";

/** Live at $2: not released, and not a hold past its expiry. */
const LIVE = "b.status <> 'released' and not (b.status = 'hold' and b.expires_at <= $2)";

export class PostgresVehicleBlocks implements IVehicleBlocks {
  constructor(private readonly transactions: PostgresTransactionContext) {}

  private get tx() {
    return this.transactions.current();
  }

  async lock(vehicleIds: readonly string[]): Promise<void> {
    if (vehicleIds.length === 0) return;
    // In id order, so two writers locking overlapping sets never deadlock.
    await this.tx.query(
      `select pg_advisory_xact_lock(hashtextextended('vehicle_blocks:' || id::text, 0))
         from (select distinct unnest($1::uuid[]) as id order by 1) ids`,
      [vehicleIds],
    );
  }

  async releaseLapsed(vehicleIds: readonly string[], now: Date): Promise<number> {
    if (vehicleIds.length === 0) return 0;
    const result = await this.tx.query(
      `update vehicle_blocks set status = 'released', released_at = expires_at,
          released_reason = 'Hold lapsed', updated_at = now()
        where vehicle_id = any($1::uuid[]) and status = 'hold' and expires_at <= $2`,
      [vehicleIds, now],
    );
    return result.rowCount ?? 0;
  }

  async busy(
    vehicleIds: readonly string[],
    interval: BusyInterval,
    now: Date,
  ): Promise<VehicleBlock[]> {
    if (vehicleIds.length === 0) return [];
    const { rows } = await this.tx.query<BlockRow>(
      `select b.* from vehicle_blocks b
        where b.vehicle_id = any($1::uuid[]) and ${LIVE}
          and tstzrange(b.starts_at, ${OVERDUE_END}, '[)') && tstzrange($3, $4, '[)')
        order by b.vehicle_id, b.starts_at`,
      [vehicleIds, now, interval.from, interval.until],
    );
    return rows.map(toBlock);
  }

  async get(id: string): Promise<VehicleBlock | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.tx.query<BlockRow>("select * from vehicle_blocks where id = $1", [
      id,
    ]);
    return rows[0] === undefined ? null : toBlock(rows[0]);
  }

  async save(b: VehicleBlock): Promise<void> {
    await this.tx.query("savepoint vehicle_block_save");
    try {
      await this.tx.query(
        `insert into vehicle_blocks (id, vehicle_id, branch_id, class_id, reason, status,
           starts_at, ends_at, blocked_until, expires_at, customer_id, ref_type, ref_id, note,
           released_at, released_reason, released_by, created_by, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17,
           $18, $19)
         on conflict (id) do update set vehicle_id = excluded.vehicle_id,
           branch_id = excluded.branch_id, class_id = excluded.class_id,
           status = excluded.status, starts_at = excluded.starts_at, ends_at = excluded.ends_at,
           blocked_until = excluded.blocked_until, expires_at = excluded.expires_at,
           customer_id = excluded.customer_id, ref_type = excluded.ref_type,
           ref_id = excluded.ref_id, note = excluded.note, released_at = excluded.released_at,
           released_reason = excluded.released_reason, released_by = excluded.released_by,
           updated_at = now()`,
        [
          b.id,
          b.vehicleId,
          b.branchId,
          b.classId,
          b.reason,
          b.status,
          b.startsAt,
          b.endsAt,
          b.blockedUntil,
          b.expiresAt,
          b.customerId,
          b.refType,
          b.refId,
          b.note,
          b.releasedAt,
          b.releasedReason,
          b.releasedBy,
          b.createdBy,
          b.createdAt,
        ],
      );
      await this.tx.query("release savepoint vehicle_block_save");
    } catch (error) {
      if (pgErrorCode(error) !== PgErrorCodes.exclusionViolation) throw error;
      await this.tx.query("rollback to savepoint vehicle_block_save");
      throw new VehicleUnavailableError();
    }
  }

  async fleet(filter: FleetFilter): Promise<FleetVehicle[]> {
    const where = ["v.deleted_at is null", "v.status <> all($1::text[])"];
    const params: unknown[] = [GONE];
    const add = (clause: string, value: unknown) => {
      params.push(value);
      where.push(clause.replace("?", `$${params.length}`));
    };
    if (filter.classId !== undefined && filter.classId !== null)
      add("v.rental_class_id = ?", filter.classId);
    else where.push("v.rental_class_id is not null");
    if (filter.branchIds !== "all") add("v.branch_id = any(?::uuid[])", filter.branchIds);
    if (filter.rentableOnly) add("v.status = any(?::text[])", [...RENTABLE_STATUSES]);
    const { rows } = await this.tx.query<FleetRow>(
      `${FLEET_SELECT} where ${where.join(" and ")} order by v.code`,
      params,
    );
    return rows.map(toVehicle);
  }

  async vehicle(id: string): Promise<FleetVehicle | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.tx.query<FleetRow>(
      `${FLEET_SELECT} where v.id = $1 and v.deleted_at is null`,
      [id],
    );
    return rows[0] === undefined ? null : toVehicle(rows[0]);
  }
}
