import type {
  DueTask,
  FunnelRow,
  ILeads,
  LeadActivity,
  LeadFilter,
  LeadTask,
  ListedVehicle,
} from "../../application/ports/IDealerSales.js";
import { Lead, type LeadProps } from "../../domain/dealer/Lead.js";
import type { PostgresTransactionContext } from "../database/postgres/PostgresTransactionContext.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const COLUMNS = [
  "id",
  "number",
  "branch_id",
  "source",
  "stage",
  "lost_reason",
  "customer_id",
  "name",
  "phone",
  "email",
  "vehicle_id",
  "make",
  "model",
  "year_from",
  "year_to",
  "budget_max_minor",
  "notify_matches",
  "notes",
  "assigned_to",
  "assigned_at",
  "stage_changed_at",
  "closed_at",
  "created_by",
  "created_at",
  "updated_at",
] as const;
type Column = (typeof COLUMNS)[number];
type Row = Record<Column, unknown>;
const SELECT = COLUMNS.map((c) => (c === "email" ? "l.email::text as email" : `l.${c}`)).join(", ");

function toRow(p: LeadProps): Row {
  return {
    id: p.id,
    number: p.number,
    branch_id: p.branchId,
    source: p.source,
    stage: p.stage,
    lost_reason: p.lostReason,
    customer_id: p.customerId,
    name: p.name,
    phone: p.phone,
    email: p.email,
    vehicle_id: p.vehicleId,
    make: p.make,
    model: p.model,
    year_from: p.yearFrom,
    year_to: p.yearTo,
    budget_max_minor: p.budgetMaxMinor,
    notify_matches: p.notifyMatches,
    notes: p.notes,
    assigned_to: p.assignedTo,
    assigned_at: p.assignedAt,
    stage_changed_at: p.stageChangedAt,
    closed_at: p.closedAt,
    created_by: p.createdBy,
    created_at: p.createdAt,
    updated_at: p.updatedAt,
  };
}

const toLead = (r: Row): Lead =>
  Lead.restore({
    id: r.id as string,
    number: r.number as string,
    branchId: r.branch_id as string,
    source: r.source as LeadProps["source"],
    stage: r.stage as LeadProps["stage"],
    lostReason: r.lost_reason as string | null,
    customerId: r.customer_id as string | null,
    name: r.name as string,
    phone: r.phone as string | null,
    email: r.email as string | null,
    vehicleId: r.vehicle_id as string | null,
    make: r.make as string | null,
    model: r.model as string | null,
    yearFrom: r.year_from as number | null,
    yearTo: r.year_to as number | null,
    budgetMaxMinor: r.budget_max_minor === null ? null : Number(r.budget_max_minor),
    notifyMatches: r.notify_matches as boolean,
    notes: r.notes as string | null,
    assignedTo: r.assigned_to as string | null,
    assignedAt: r.assigned_at as Date | null,
    stageChangedAt: r.stage_changed_at as Date,
    closedAt: r.closed_at as Date | null,
    createdBy: r.created_by as string | null,
    createdAt: r.created_at as Date,
    updatedAt: r.updated_at as Date,
  });

type TaskRow = {
  id: string;
  lead_id: string;
  title: string;
  due_on: string;
  assigned_to: string | null;
  done_at: Date | null;
  done_by: string | null;
  created_by: string | null;
  created_at: Date;
};
const TASK_SELECT = `t.id, t.lead_id, t.title, t.due_on::text as due_on, t.assigned_to, t.done_at,
  t.done_by, t.created_by, t.created_at`;
const toTask = (r: TaskRow): LeadTask => ({
  id: r.id,
  leadId: r.lead_id,
  title: r.title,
  dueOn: r.due_on,
  assignedTo: r.assigned_to,
  doneAt: r.done_at,
  doneBy: r.done_by,
  createdBy: r.created_by,
  createdAt: r.created_at,
});

export class PostgresLeads implements ILeads {
  constructor(private readonly transactions: PostgresTransactionContext) {}

  private get tx() {
    return this.transactions.current();
  }

  async insert(lead: Lead): Promise<void> {
    const values = toRow(lead.snapshot());
    await this.tx.query(
      `insert into dealer_leads (${COLUMNS.join(", ")})
       values (${COLUMNS.map((_, i) => `$${i + 1}`).join(", ")})`,
      COLUMNS.map((c) => values[c]),
    );
  }

  async update(lead: Lead): Promise<void> {
    const values = toRow(lead.snapshot());
    const changed = COLUMNS.filter((c) => c !== "id" && c !== "created_at");
    await this.tx.query(
      `update dealer_leads set ${changed.map((c, i) => `${c} = $${i + 2}`).join(", ")}
        where id = $1`,
      [values.id, ...changed.map((c) => values[c])],
    );
  }

  get(id: string): Promise<Lead | null> {
    return this.one(id, "");
  }

  lock(id: string): Promise<Lead | null> {
    return this.one(id, "for update");
  }

  async list(filter: LeadFilter): Promise<Lead[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, value: unknown) => {
      params.push(value);
      where.push(sql.replaceAll("?", `$${params.length}`));
    };
    if (filter.branchIds !== "all") add("l.branch_id = any(?::uuid[])", filter.branchIds);
    if (filter.branchId !== undefined) add("l.branch_id = ?", filter.branchId);
    if (filter.assignedTo !== undefined) add("l.assigned_to = ?", filter.assignedTo);
    if (filter.unassigned === true) where.push("l.assigned_to is null");
    if (filter.stages !== undefined) add("l.stage = any(?::text[])", filter.stages);
    if (filter.sources !== undefined) add("l.source = any(?::text[])", filter.sources);
    if (filter.search !== undefined && filter.search.trim() !== "")
      add(
        `(l.name ilike ? or l.phone ilike ? or l.email::text ilike ? or l.number ilike ?)`,
        `%${filter.search.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`,
      );
    if (filter.beforeId !== undefined && UUID.test(filter.beforeId))
      add("l.id < ?", filter.beforeId);
    params.push(filter.limit);
    const { rows } = await this.tx.query<Row>(
      `select ${SELECT} from dealer_leads l
        ${where.length === 0 ? "" : `where ${where.join(" and ")}`}
        order by l.id desc limit $${params.length}`,
      params,
    );
    return rows.map(toLead);
  }

  async addActivity(a: LeadActivity): Promise<void> {
    await this.tx.query(
      `insert into dealer_lead_activities (id, lead_id, kind, note, details, occurred_at,
         recorded_by, recorded_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        a.id,
        a.leadId,
        a.kind,
        a.note,
        JSON.stringify(a.details),
        a.occurredAt,
        a.recordedBy,
        a.recordedAt,
      ],
    );
  }

  async activities(leadId: string): Promise<LeadActivity[]> {
    if (!UUID.test(leadId)) return [];
    const { rows } = await this.tx.query<{
      id: string;
      lead_id: string;
      kind: LeadActivity["kind"];
      note: string | null;
      details: LeadActivity["details"];
      occurred_at: Date;
      recorded_by: string | null;
      recorded_at: Date;
    }>(
      `select id, lead_id, kind, note, details, occurred_at, recorded_by, recorded_at
         from dealer_lead_activities where lead_id = $1 order by occurred_at, id`,
      [leadId],
    );
    return rows.map((r) => ({
      id: r.id,
      leadId: r.lead_id,
      kind: r.kind,
      note: r.note,
      details: r.details,
      occurredAt: r.occurred_at,
      recordedBy: r.recorded_by,
      recordedAt: r.recorded_at,
    }));
  }

  async saveTask(t: LeadTask): Promise<void> {
    await this.tx.query(
      `insert into dealer_lead_tasks (id, lead_id, title, due_on, assigned_to, done_at, done_by,
         created_by, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       on conflict (id) do update set title = excluded.title, due_on = excluded.due_on,
         assigned_to = excluded.assigned_to, done_at = excluded.done_at, done_by = excluded.done_by`,
      [
        t.id,
        t.leadId,
        t.title,
        t.dueOn,
        t.assignedTo,
        t.doneAt,
        t.doneBy,
        t.createdBy,
        t.createdAt,
      ],
    );
  }

  async task(id: string): Promise<LeadTask | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.tx.query<TaskRow>(
      `select ${TASK_SELECT} from dealer_lead_tasks t where t.id = $1 for update`,
      [id],
    );
    return rows[0] === undefined ? null : toTask(rows[0]);
  }

  async tasks(leadId: string): Promise<LeadTask[]> {
    if (!UUID.test(leadId)) return [];
    const { rows } = await this.tx.query<TaskRow>(
      `select ${TASK_SELECT} from dealer_lead_tasks t where t.lead_id = $1
        order by t.done_at nulls first, t.due_on, t.id`,
      [leadId],
    );
    return rows.map(toTask);
  }

  async dueTasks(onOrBefore: string): Promise<DueTask[]> {
    const { rows } = await this.tx.query<
      TaskRow & { lead_number: string; lead_name: string; branch_id: string }
    >(
      `select ${TASK_SELECT}, l.number as lead_number, l.name as lead_name, l.branch_id
         from dealer_lead_tasks t join dealer_leads l on l.id = t.lead_id
        where t.done_at is null and t.due_on <= $1::date
          and l.stage not in ('won', 'lost')
        order by t.due_on, t.id`,
      [onOrBefore],
    );
    return rows.map((r) => ({
      ...toTask(r),
      leadNumber: r.lead_number,
      leadName: r.lead_name,
      branchId: r.branch_id,
    }));
  }

  async pool(branchId: string): Promise<string[]> {
    if (!UUID.test(branchId)) return [];
    const { rows } = await this.tx.query<{ user_id: string }>(
      `select p.user_id from dealer_lead_pool p join users u on u.id = p.user_id
        where p.branch_id = $1 and u.status = 'active' order by p.position`,
      [branchId],
    );
    return rows.map((r) => r.user_id);
  }

  async setPool(branchId: string, userIds: readonly string[]): Promise<void> {
    await this.tx.query("delete from dealer_lead_pool where branch_id = $1", [branchId]);
    if (userIds.length > 0)
      await this.tx.query(
        `insert into dealer_lead_pool (branch_id, user_id, position)
         select $1, u, n from unnest($2::uuid[]) with ordinality as x (u, n)`,
        [branchId, userIds],
      );
  }

  async lastAssigned(userIds: readonly string[]): Promise<Map<string, Date | null>> {
    const result = new Map<string, Date | null>(userIds.map((id) => [id, null]));
    if (userIds.length === 0) return result;
    const { rows } = await this.tx.query<{ assigned_to: string; at: Date }>(
      `select assigned_to, max(assigned_at) as at from dealer_leads
        where assigned_to = any($1::uuid[]) group by assigned_to`,
      [userIds],
    );
    for (const r of rows) result.set(r.assigned_to, r.at);
    return result;
  }

  async savedSearches(): Promise<Lead[]> {
    const { rows } = await this.tx.query<Row>(
      `select ${SELECT} from dealer_leads l
        where l.notify_matches and l.stage not in ('won', 'lost') order by l.id`,
    );
    return rows.map(toLead);
  }

  async listedVehicles(): Promise<ListedVehicle[]> {
    const { rows } = await this.tx.query<{
      vehicle_id: string;
      branch_id: string;
      code: string;
      plate_number: string | null;
      make: string;
      model: string;
      year: number | null;
      asking_price_minor: string | null;
    }>(
      `select s.vehicle_id, v.branch_id, v.code, v.plate_number, v.make, v.model, v.year,
              s.asking_price_minor
         from dealer_stock s join vehicles v on v.id = s.vehicle_id
        where s.status = 'listed' and v.deleted_at is null
        order by s.vehicle_id`,
    );
    return rows.map((r) => ({
      vehicleId: r.vehicle_id,
      branchId: r.branch_id,
      code: r.code,
      plateNumber: r.plate_number,
      make: r.make,
      model: r.model,
      year: r.year,
      askingPriceMinor: r.asking_price_minor === null ? null : Number(r.asking_price_minor),
    }));
  }

  async recordMatch(leadId: string, vehicleId: string): Promise<boolean> {
    const { rows } = await this.tx.query(
      `insert into dealer_lead_matches (lead_id, vehicle_id) values ($1, $2)
       on conflict do nothing returning lead_id`,
      [leadId, vehicleId],
    );
    return rows.length > 0;
  }

  async funnel(
    filter: Readonly<{
      branchIds: "all" | readonly string[];
      assignedTo?: string;
      from: Date;
      until: Date;
    }>,
  ): Promise<FunnelRow[]> {
    const params: unknown[] = [filter.from, filter.until];
    let branch = "";
    if (filter.branchIds !== "all") {
      params.push(filter.branchIds);
      branch = `and branch_id = any($${params.length}::uuid[])`;
    }
    if (filter.assignedTo !== undefined) {
      params.push(filter.assignedTo);
      branch += ` and assigned_to = $${params.length}`;
    }
    const { rows } = await this.tx.query<{
      source: FunnelRow["source"];
      assigned_to: string | null;
      stage: FunnelRow["stage"];
      leads: string;
    }>(
      `select source, assigned_to, stage, count(*) as leads from dealer_leads
        where created_at >= $1 and created_at < $2 ${branch}
        group by source, assigned_to, stage`,
      params,
    );
    return rows.map((r) => ({
      source: r.source,
      assignedTo: r.assigned_to,
      stage: r.stage,
      leads: Number(r.leads),
    }));
  }

  async customer(id: string): Promise<Readonly<{ name: string; phone: string | null }> | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.tx.query<{ name: string; phone: string | null }>(
      "select name, phone from customers where id = $1 and deleted_at is null",
      [id],
    );
    return rows[0] ?? null;
  }

  private async one(id: string, lock: string): Promise<Lead | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.tx.query<Row>(
      `select ${SELECT} from dealer_leads l where l.id = $1 ${lock}`,
      [id],
    );
    return rows[0] === undefined ? null : toLead(rows[0]);
  }
}
