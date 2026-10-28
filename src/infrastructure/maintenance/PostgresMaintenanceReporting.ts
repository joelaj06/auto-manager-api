import type {
  CompletedOrderRow,
  ComplianceVehicleRow,
  DocumentExpiryRow,
  FleetVehicleRow,
  IdleVehicleRow,
  IMaintenanceReporting,
  Instants,
  LateWorkOrderRow,
  LicenceExpiryRow,
  ServiceDueRow,
} from "../../application/ports/IMaintenanceReporting.js";
import type { BranchFilter } from "../../application/ports/IReporting.js";
import type { OffRoadSpell } from "../../domain/maintenance/MaintenanceMetrics.js";
import { OFF_FLEET_STATUSES } from "../../domain/vehicles/VehicleStatus.js";
import type { PostgresTransactionContext } from "../database/postgres/PostgresTransactionContext.js";

type Row = Record<string, unknown>;

const n = (value: unknown) => (value === null || value === undefined ? 0 : Number(value));
const scope = (filter: BranchFilter) => [
  filter.branchIds === "all" ? null : filter.branchIds,
  filter.branchId,
];
const OFF_FLEET = [...OFF_FLEET_STATUSES];

/** Maintenance KPIs, compliance and the daily maintenance alerts (docs/12 §6, docs/15 §2). */
export class PostgresMaintenanceReporting implements IMaintenanceReporting {
  constructor(private readonly transactions: PostgresTransactionContext) {}

  private get tx() {
    return this.transactions.current();
  }

  async completedOrders(period: Instants, filter: BranchFilter): Promise<CompletedOrderRow[]> {
    const { rows } = await this.tx.query<Row>(
      `select o.id, o.vehicle_id, o.type, o.completed_at,
              coalesce((select sum(l.amount_minor) from work_order_lines l
                         where l.work_order_id = o.id and l.kind = 'labour'), 0) as labour,
              coalesce((select sum(l.amount_minor) from work_order_lines l
                         where l.work_order_id = o.id and l.kind = 'part'), 0) as part,
              coalesce((select sum(l.amount_minor) from work_order_lines l
                         where l.work_order_id = o.id and l.kind = 'sublet'), 0) as sublet,
              coalesce((select sum(l.amount_minor) from work_order_lines l
                         where l.work_order_id = o.id and l.kind = 'other'), 0) as other,
              coalesce((select sum(a.amount_minor) from work_order_allocations a
                         where a.work_order_id = o.id and a.payer <> 'company'), 0) as recovered
         from work_orders o
        where o.status = 'completed' and o.completed_at >= $1 and o.completed_at < $2
          and ($3::uuid[] is null or o.branch_id = any($3::uuid[]))
          and ($4::uuid is null or o.branch_id = $4)
        order by o.completed_at`,
      [period.from, period.to, ...scope(filter)],
    );
    return rows.map((r) => ({
      id: r.id as string,
      vehicleId: r.vehicle_id as string,
      type: r.type as string,
      completedAt: r.completed_at as Date,
      labourMinor: n(r.labour),
      partMinor: n(r.part),
      subletMinor: n(r.sublet),
      otherMinor: n(r.other),
      recoveredMinor: n(r.recovered),
    }));
  }

  async failures(period: Instants, filter: BranchFilter): Promise<Map<string, number>> {
    const { rows } = await this.tx.query<Row>(
      `select vehicle_id, count(*) as failures
         from work_orders
        where type in ('corrective', 'accident') and status <> 'cancelled'
          and created_at >= $1 and created_at < $2
          and ($3::uuid[] is null or branch_id = any($3::uuid[]))
          and ($4::uuid is null or branch_id = $4)
        group by vehicle_id`,
      [period.from, period.to, ...scope(filter)],
    );
    return new Map(rows.map((r) => [r.vehicle_id as string, n(r.failures)]));
  }

  async fleet(
    period: Instants,
    days: Readonly<{ from: string; to: string }>,
    filter: BranchFilter,
  ): Promise<FleetVehicleRow[]> {
    const { rows } = await this.tx.query<Row>(
      `select v.id, v.code, v.plate_number, v.make, v.model, v.branch_id, v.mileage_unit,
              v.created_at,
              case when v.status = any($5::text[]) then v.status_changed_at end as left_at,
              coalesce((select sum(s.distance) from daily_vehicle_stats s
                         where s.vehicle_id = v.id and s.stat_date between $6 and $7), 0)
                as distance
         from vehicles v
        where v.deleted_at is null and v.created_at < $2
          and not (v.status = any($5::text[]) and v.status_changed_at <= $1)
          and ($3::uuid[] is null or v.branch_id = any($3::uuid[]))
          and ($4::uuid is null or v.branch_id = $4)
        order by v.code`,
      [period.from, period.to, ...scope(filter), OFF_FLEET, days.from, days.to],
    );
    return rows.map((r) => ({
      vehicleId: r.id as string,
      code: r.code as string,
      plateNumber: r.plate_number as string | null,
      make: r.make as string,
      model: r.model as string,
      branchId: r.branch_id as string,
      mileageUnit: r.mileage_unit as "km" | "mi",
      addedAt: r.created_at as Date,
      leftAt: r.left_at as Date | null,
      distance: n(r.distance),
    }));
  }

  async offRoadSpells(
    period: Instants,
    filter: BranchFilter,
  ): Promise<Map<string, OffRoadSpell[]>> {
    const { rows } = await this.tx.query<Row>(
      `select o.vehicle_id, o.downtime_started_at as start_at,
              coalesce(o.downtime_ended_at, o.completed_at, o.cancelled_at) as end_at
         from work_orders o
         join vehicles v on v.id = o.vehicle_id
        where o.downtime_started_at is not null and o.downtime_started_at < $2
          and coalesce(o.downtime_ended_at, o.completed_at, o.cancelled_at, 'infinity') > $1
          and ($3::uuid[] is null or v.branch_id = any($3::uuid[]))
          and ($4::uuid is null or v.branch_id = $4)
       union all
       select i.vehicle_id, i.created_at, i.closed_at
         from incidents i
         join vehicles v on v.id = i.vehicle_id
        where i.vehicle_status is not null and i.created_at < $2
          and coalesce(i.closed_at, 'infinity') > $1
          and ($3::uuid[] is null or v.branch_id = any($3::uuid[]))
          and ($4::uuid is null or v.branch_id = $4)`,
      [period.from, period.to, ...scope(filter)],
    );
    const spells = new Map<string, OffRoadSpell[]>();
    for (const r of rows) {
      const id = r.vehicle_id as string;
      spells.set(id, [
        ...(spells.get(id) ?? []),
        { start: r.start_at as Date, end: r.end_at as Date | null },
      ]);
    }
    return spells;
  }

  async openWorkOrders(filter: BranchFilter): Promise<Readonly<{ open: number; offRoad: number }>> {
    const { rows } = await this.tx.query<Row>(
      `select count(*) as open, count(*) filter (where off_road) as off_road
         from work_orders
        where status not in ('completed', 'cancelled')
          and ($1::uuid[] is null or branch_id = any($1::uuid[]))
          and ($2::uuid is null or branch_id = $2)`,
      scope(filter),
    );
    return { open: n(rows[0]!.open), offRoad: n(rows[0]!.off_road) };
  }

  async serviceDue(filter: BranchFilter): Promise<ServiceDueRow[]> {
    const { rows } = await this.tx.query<Row>(
      `select d.vehicle_id, t.name, d.status, d.due_km, d.due_on::text as due_on
         from service_due d
         join service_plan_tasks t on t.id = d.task_id
         join vehicles v on v.id = d.vehicle_id
        where d.status in ('due', 'overdue') and v.deleted_at is null
          and not (v.status = any($3::text[]))
          and ($1::uuid[] is null or d.branch_id = any($1::uuid[]))
          and ($2::uuid is null or d.branch_id = $2)
        order by d.status desc, d.due_on nulls last, t.name`,
      [...scope(filter), OFF_FLEET],
    );
    return rows.map((r) => ({
      vehicleId: r.vehicle_id as string,
      taskName: r.name as string,
      status: r.status as "due" | "overdue",
      dueKm: r.due_km === null ? null : n(r.due_km),
      dueOn: r.due_on as string | null,
    }));
  }

  async documentsExpiring(until: string, filter: BranchFilter): Promise<DocumentExpiryRow[]> {
    const { rows } = await this.tx.query<Row>(
      `select * from (
         select distinct on (d.vehicle_id, d.type)
                d.id, d.vehicle_id, d.type, d.title, d.number, d.expires_on::text as expires_on
           from vehicle_documents d
           join vehicles v on v.id = d.vehicle_id
          where d.expires_on is not null and v.deleted_at is null
            and not (v.status = any($4::text[]))
            and ($2::uuid[] is null or v.branch_id = any($2::uuid[]))
            and ($3::uuid is null or v.branch_id = $3)
          order by d.vehicle_id, d.type, d.expires_on desc
       ) latest
       where expires_on <= $1
       order by expires_on, type`,
      [until, ...scope(filter), OFF_FLEET],
    );
    return rows.map((r) => ({
      vehicleId: r.vehicle_id as string,
      documentId: r.id as string,
      type: r.type as string,
      title: r.title as string | null,
      number: r.number as string | null,
      expiresOn: r.expires_on as string,
    }));
  }

  async licencesExpiring(until: string, filter: BranchFilter): Promise<LicenceExpiryRow[]> {
    const { rows } = await this.tx.query<Row>(
      `select id, code, first_name || ' ' || last_name as name, phone, branch_id,
              licence_number, licence_expires_on::text as expires_on
         from drivers
        where status = 'active' and deleted_at is null
          and licence_expires_on is not null and licence_expires_on <= $1
          and ($2::uuid[] is null or branch_id = any($2::uuid[]))
          and ($3::uuid is null or branch_id = $3)
        order by licence_expires_on, code`,
      [until, ...scope(filter)],
    );
    return rows.map((r) => ({
      driverId: r.id as string,
      code: r.code as string,
      name: r.name as string,
      phone: r.phone as string,
      branchId: r.branch_id as string,
      licenceNumber: r.licence_number as string | null,
      expiresOn: r.expires_on as string,
    }));
  }

  async complianceVehicles(today: string, filter: BranchFilter): Promise<ComplianceVehicleRow[]> {
    const { rows } = await this.tx.query<Row>(
      `select v.id, v.code, v.plate_number, v.make, v.model, v.branch_id, v.status,
              (select count(*) from traffic_offences o
                where o.vehicle_id = v.id and o.status in ('unpaid', 'contested')
                  and o.due_on < $1) as fines_overdue,
              (select count(*) from incidents i
                where i.vehicle_id = v.id and i.status = 'open') as open_incidents
         from vehicles v
        where v.deleted_at is null and not (v.status = any($4::text[]))
          and ($2::uuid[] is null or v.branch_id = any($2::uuid[]))
          and ($3::uuid is null or v.branch_id = $3)
        order by v.code`,
      [today, ...scope(filter), OFF_FLEET],
    );
    return rows.map((r) => ({
      vehicleId: r.id as string,
      code: r.code as string,
      plateNumber: r.plate_number as string | null,
      make: r.make as string,
      model: r.model as string,
      branchId: r.branch_id as string,
      status: r.status as string,
      finesOverdue: n(r.fines_overdue),
      openIncidents: n(r.open_incidents),
    }));
  }

  async idleVehicles(before: Date): Promise<IdleVehicleRow[]> {
    const { rows } = await this.tx.query<Row>(
      `select id, code, plate_number, branch_id, status_changed_at
         from vehicles
        where status = 'available' and deleted_at is null and status_changed_at < $1
        order by status_changed_at`,
      [before],
    );
    return rows.map((r) => ({
      vehicleId: r.id as string,
      code: r.code as string,
      plateNumber: r.plate_number as string | null,
      branchId: r.branch_id as string,
      since: r.status_changed_at as Date,
    }));
  }

  async lateWorkOrders(now: Date): Promise<LateWorkOrderRow[]> {
    const { rows } = await this.tx.query<Row>(
      `select o.id, o.number, o.vehicle_id, o.branch_id, o.expected_back_at,
              coalesce(v.plate_number, v.code) as vehicle
         from work_orders o
         join vehicles v on v.id = o.vehicle_id
        where o.off_road and o.status not in ('completed', 'cancelled')
          and o.expected_back_at < $1
        order by o.expected_back_at`,
      [now],
    );
    return rows.map((r) => ({
      id: r.id as string,
      number: r.number as string,
      vehicleId: r.vehicle_id as string,
      vehicleName: r.vehicle as string,
      branchId: r.branch_id as string,
      expectedBackAt: r.expected_back_at as Date,
    }));
  }
}
