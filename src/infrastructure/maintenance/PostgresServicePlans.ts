import type {
  DueFilter,
  IServicePlans,
  ServiceDueRow,
  ServiceDueView,
  ServiceRecordProps,
  ServiceVehicle,
  VehicleDriver,
} from "../../application/ports/IServicePlans.js";
import type { AlertStatus, DueStatus } from "../../domain/maintenance/ServiceDue.js";
import type {
  PlanTarget,
  ServicePlanProps,
  ServicePlanWithTasks,
  ServiceTaskProps,
} from "../../domain/maintenance/ServicePlan.js";
import type { PostgresTransactionContext } from "../database/postgres/PostgresTransactionContext.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Statuses of a vehicle that is no longer the business's to service. */
const OUT_OF_SERVICE = [
  "sold",
  "transferred",
  "stolen",
  "written_off",
  "retired",
  "scrapped",
] as const;

type PlanRow = {
  id: string;
  name: string;
  description: string | null;
  applies_to: PlanTarget;
  make: string | null;
  model: string | null;
  group_id: string | null;
  class_id: string | null;
  vehicle_id: string | null;
  template: string | null;
  active: boolean;
  created_at: Date;
  updated_at: Date;
};

type TaskRow = {
  id: string;
  plan_id: string;
  name: string;
  every_km: number | null;
  every_days: number | null;
  notice_km: number;
  notice_days: number;
  grace_km: number;
  grace_days: number;
  position: number;
  active: boolean;
};

type DueRow = {
  id: string;
  vehicle_id: string;
  task_id: string;
  plan_id: string;
  branch_id: string;
  base_km: number | null;
  base_on: string;
  due_km: number | null;
  due_on: string | null;
  status: DueStatus;
  alerted: AlertStatus | null;
  computed_at: Date;
};

type RecordRow = {
  id: string;
  vehicle_id: string;
  task_id: string;
  done_on: string;
  odometer: number | null;
  note: string | null;
  work_order_ref: string | null;
  recorded_by: string | null;
  created_at: Date;
};

const DUE_COLUMNS = `d.id, d.vehicle_id, d.task_id, d.plan_id, d.branch_id, d.base_km,
  d.base_on::text as base_on, d.due_km, d.due_on::text as due_on, d.status, d.alerted,
  d.computed_at`;

const RECORD_COLUMNS = `r.id, r.vehicle_id, r.task_id, r.done_on::text as done_on, r.odometer,
  r.note, r.work_order_ref, r.recorded_by, r.created_at`;

/** Service plans, due rows and service records in the tenant database (docs/12 §2). */
export class PostgresServicePlans implements IServicePlans {
  constructor(private readonly transactions: PostgresTransactionContext) {}

  private get tx() {
    return this.transactions.current();
  }

  async plans(includeInactive: boolean): Promise<ServicePlanWithTasks[]> {
    const { rows } = await this.tx.query<PlanRow>(
      `select * from service_plans ${includeInactive ? "" : "where active"}
        order by name, id`,
    );
    return this.withTasks(rows, includeInactive);
  }

  async plan(id: string): Promise<ServicePlanWithTasks | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.tx.query<PlanRow>("select * from service_plans where id = $1", [
      id,
    ]);
    return (await this.withTasks(rows, true))[0] ?? null;
  }

  async addPlan(plan: ServicePlanProps, createdBy: string): Promise<void> {
    await this.tx.query(
      `insert into service_plans (id, name, description, applies_to, make, model, group_id,
         class_id, vehicle_id, template, active, created_by, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        plan.id,
        plan.name,
        plan.description,
        plan.appliesTo,
        plan.make,
        plan.model,
        plan.groupId,
        plan.classId,
        plan.vehicleId,
        plan.template,
        plan.active,
        createdBy,
        plan.createdAt,
        plan.updatedAt,
      ],
    );
  }

  async updatePlan(plan: ServicePlanProps): Promise<void> {
    await this.tx.query(
      `update service_plans set name = $2, description = $3, applies_to = $4, make = $5,
         model = $6, group_id = $7, class_id = $8, vehicle_id = $9, active = $10, updated_at = $11
       where id = $1`,
      [
        plan.id,
        plan.name,
        plan.description,
        plan.appliesTo,
        plan.make,
        plan.model,
        plan.groupId,
        plan.classId,
        plan.vehicleId,
        plan.active,
        plan.updatedAt,
      ],
    );
  }

  async task(id: string): Promise<ServiceTaskProps | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.tx.query<TaskRow>(
      "select * from service_plan_tasks where id = $1",
      [id],
    );
    return rows[0] === undefined ? null : toTask(rows[0]);
  }

  async addTask(task: ServiceTaskProps): Promise<void> {
    await this.tx.query(
      `insert into service_plan_tasks (id, plan_id, name, every_km, every_days, notice_km,
         notice_days, grace_km, grace_days, position, active)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        task.id,
        task.planId,
        task.name,
        task.everyKm,
        task.everyDays,
        task.noticeKm,
        task.noticeDays,
        task.graceKm,
        task.graceDays,
        task.position,
        task.active,
      ],
    );
  }

  async updateTask(task: ServiceTaskProps): Promise<void> {
    await this.tx.query(
      `update service_plan_tasks set name = $2, every_km = $3, every_days = $4, notice_km = $5,
         notice_days = $6, grace_km = $7, grace_days = $8, position = $9, active = $10,
         updated_at = now()
       where id = $1`,
      [
        task.id,
        task.name,
        task.everyKm,
        task.everyDays,
        task.noticeKm,
        task.noticeDays,
        task.graceKm,
        task.graceDays,
        task.position,
        task.active,
      ],
    );
  }

  async vehicles(ids: readonly string[] | null): Promise<ServiceVehicle[]> {
    const { rows } = await this.tx.query<{
      id: string;
      code: string;
      plate_number: string | null;
      make: string;
      model: string;
      branch_id: string;
      group_ids: string[];
      rental_class_id: string | null;
      current_odometer: number | null;
      in_service: boolean;
    }>(
      `select v.id, v.code, v.plate_number, v.make, v.model, v.branch_id, v.rental_class_id,
              v.current_odometer,
              v.deleted_at is null and v.status <> all($2::text[]) as in_service,
              coalesce(array(select m.group_id from vehicle_group_members m
                              where m.vehicle_id = v.id), '{}') as group_ids
         from vehicles v
        where ($1::uuid[] is null or v.id = any($1::uuid[]))
        order by v.id`,
      [ids, OUT_OF_SERVICE],
    );
    return rows.map((r) => ({
      vehicleId: r.id,
      code: r.code,
      plateNumber: r.plate_number,
      make: r.make,
      model: r.model,
      branchId: r.branch_id,
      groupIds: r.group_ids,
      classId: r.rental_class_id,
      odometer: r.current_odometer,
      inService: r.in_service,
    }));
  }

  async dueRows(vehicleIds: readonly string[] | null): Promise<ServiceDueRow[]> {
    const { rows } = await this.tx.query<DueRow>(
      `select ${DUE_COLUMNS} from service_due d
        where $1::uuid[] is null or d.vehicle_id = any($1::uuid[])
        for update`,
      [vehicleIds],
    );
    return rows.map(toDue);
  }

  async lastRecords(vehicleIds: readonly string[] | null): Promise<ServiceRecordProps[]> {
    const { rows } = await this.tx.query<RecordRow>(
      `select distinct on (r.vehicle_id, r.task_id) ${RECORD_COLUMNS}
         from service_records r
        where $1::uuid[] is null or r.vehicle_id = any($1::uuid[])
        order by r.vehicle_id, r.task_id, r.done_on desc, r.created_at desc`,
      [vehicleIds],
    );
    return rows.map(toRecord);
  }

  async saveDue(row: ServiceDueRow): Promise<void> {
    await this.tx.query(
      `insert into service_due (id, vehicle_id, task_id, plan_id, branch_id, base_km, base_on,
         due_km, due_on, status, alerted, computed_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       on conflict (vehicle_id, task_id) do update set plan_id = excluded.plan_id,
         branch_id = excluded.branch_id, base_km = excluded.base_km, base_on = excluded.base_on,
         due_km = excluded.due_km, due_on = excluded.due_on, status = excluded.status,
         alerted = excluded.alerted, computed_at = excluded.computed_at`,
      [
        row.id,
        row.vehicleId,
        row.taskId,
        row.planId,
        row.branchId,
        row.baseKm,
        row.baseOn,
        row.dueKm,
        row.dueOn,
        row.status,
        row.alerted,
        row.computedAt,
      ],
    );
  }

  async removeDue(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.tx.query("delete from service_due where id = any($1::uuid[])", [ids]);
  }

  async due(filter: DueFilter): Promise<ServiceDueView[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, value: unknown) => {
      params.push(value);
      where.push(sql.replace("?", `$${params.length}`));
    };
    if (filter.branchIds !== "all") add("d.branch_id = any(?::uuid[])", filter.branchIds);
    if (filter.branchId !== undefined) add("d.branch_id = ?", filter.branchId);
    if (filter.vehicleId !== undefined) add("d.vehicle_id = ?", filter.vehicleId);
    if (filter.statuses !== undefined) add("d.status = any(?::text[])", filter.statuses);
    params.push(filter.limit);
    return this.views(
      `${where.length === 0 ? "" : `where ${where.join(" and ")}`}
       order by array_position(array['overdue','due','upcoming','scheduled'], d.status),
                d.due_on nulls last, d.due_km - coalesce(v.current_odometer, 0) nulls last, d.id
       limit $${params.length}`,
      params,
    );
  }

  dueView(ids: readonly string[]): Promise<ServiceDueView[]> {
    return this.views("where d.id = any($1::uuid[]) order by d.id", [ids]);
  }

  async addRecord(record: ServiceRecordProps): Promise<void> {
    await this.tx.query(
      `insert into service_records (id, vehicle_id, task_id, done_on, odometer, note,
         work_order_ref, recorded_by, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        record.id,
        record.vehicleId,
        record.taskId,
        record.doneOn,
        record.odometer,
        record.note,
        record.workOrderRef,
        record.recordedBy,
        record.createdAt,
      ],
    );
  }

  async records(
    vehicleId: string,
    limit: number,
  ): Promise<(ServiceRecordProps & { taskName: string })[]> {
    const { rows } = await this.tx.query<RecordRow & { task_name: string }>(
      `select ${RECORD_COLUMNS}, t.name as task_name
         from service_records r join service_plan_tasks t on t.id = r.task_id
        where r.vehicle_id = $1
        order by r.done_on desc, r.created_at desc limit $2`,
      [vehicleId, limit],
    );
    return rows.map((r) => ({ ...toRecord(r), taskName: r.task_name }));
  }

  async driverOf(vehicleId: string): Promise<VehicleDriver | null> {
    const { rows } = await this.tx.query<{ id: string; name: string; phone: string }>(
      `select d.id, d.first_name || ' ' || d.last_name as name, d.phone
         from vehicle_assignments a join drivers d on d.id = a.driver_id
        where a.vehicle_id = $1 and a.ended_at is null and a.started_at <= now()
        order by a.started_at desc limit 1`,
      [vehicleId],
    );
    const row = rows[0];
    return row === undefined ? null : { driverId: row.id, name: row.name, phone: row.phone };
  }

  async exists(kind: "group" | "class" | "vehicle", id: string): Promise<boolean> {
    if (!UUID.test(id)) return false;
    const table = { group: "vehicle_groups", class: "vehicle_classes", vehicle: "vehicles" }[kind];
    const extra = kind === "vehicle" ? " and deleted_at is null" : "";
    const { rows } = await this.tx.query(`select 1 from ${table} where id = $1${extra}`, [id]);
    return rows.length > 0;
  }

  // --- helpers ---

  private async views(tail: string, params: unknown[]): Promise<ServiceDueView[]> {
    const { rows } = await this.tx.query<
      DueRow & {
        code: string;
        plate_number: string | null;
        make: string;
        model: string;
        current_odometer: number | null;
        plan_name: string;
        task_name: string;
      }
    >(
      `select ${DUE_COLUMNS}, v.code, v.plate_number, v.make, v.model, v.current_odometer,
              p.name as plan_name, t.name as task_name
         from service_due d
         join vehicles v on v.id = d.vehicle_id
         join service_plans p on p.id = d.plan_id
         join service_plan_tasks t on t.id = d.task_id
       ${tail}`,
      params,
    );
    return rows.map((r) => ({
      ...toDue(r),
      vehicleCode: r.code,
      plateNumber: r.plate_number,
      make: r.make,
      model: r.model,
      odometer: r.current_odometer,
      planName: r.plan_name,
      taskName: r.task_name,
    }));
  }

  private async withTasks(
    plans: readonly PlanRow[],
    inactiveTasks: boolean,
  ): Promise<ServicePlanWithTasks[]> {
    if (plans.length === 0) return [];
    const { rows } = await this.tx.query<TaskRow>(
      `select * from service_plan_tasks where plan_id = any($1::uuid[]) ${
        inactiveTasks ? "" : "and active"
      } order by position, created_at, id`,
      [plans.map((p) => p.id)],
    );
    return plans.map((p) => ({
      ...toPlan(p),
      tasks: rows.filter((t) => t.plan_id === p.id).map(toTask),
    }));
  }
}

const toPlan = (r: PlanRow): ServicePlanProps => ({
  id: r.id,
  name: r.name,
  description: r.description,
  appliesTo: r.applies_to,
  make: r.make,
  model: r.model,
  groupId: r.group_id,
  classId: r.class_id,
  vehicleId: r.vehicle_id,
  template: r.template,
  active: r.active,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toTask = (r: TaskRow): ServiceTaskProps => ({
  id: r.id,
  planId: r.plan_id,
  name: r.name,
  everyKm: r.every_km,
  everyDays: r.every_days,
  noticeKm: r.notice_km,
  noticeDays: r.notice_days,
  graceKm: r.grace_km,
  graceDays: r.grace_days,
  position: r.position,
  active: r.active,
});

const toDue = (r: DueRow): ServiceDueRow => ({
  id: r.id,
  vehicleId: r.vehicle_id,
  taskId: r.task_id,
  planId: r.plan_id,
  branchId: r.branch_id,
  baseKm: r.base_km,
  baseOn: r.base_on,
  dueKm: r.due_km,
  dueOn: r.due_on,
  status: r.status,
  alerted: r.alerted,
  computedAt: r.computed_at,
});

const toRecord = (r: RecordRow): ServiceRecordProps => ({
  id: r.id,
  vehicleId: r.vehicle_id,
  taskId: r.task_id,
  doneOn: r.done_on,
  odometer: r.odometer,
  note: r.note,
  workOrderRef: r.work_order_ref,
  recordedBy: r.recorded_by,
  createdAt: r.created_at,
});
