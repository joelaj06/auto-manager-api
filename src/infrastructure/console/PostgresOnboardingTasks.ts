import type { PlannedTask, TaskTemplate } from "../../domain/console/OnboardingConcierge.js";
import type { OnboardingFacts, OnboardingStep } from "../../domain/console/TenantAnalytics.js";
import type {
  IOnboardingTasks,
  OnboardingTask,
  OnboardingTaskStatus,
  TaskFilter,
} from "../../application/ports/IOnboardingTasks.js";
import type { Queryable } from "../database/postgres/Queryable.js";

type Row = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const text = (v: unknown) => (typeof v === "string" ? v : null);
const date = (v: unknown) => (v instanceof Date ? v : null);

const TASKS = `
  select k.*, t.slug::text as tenant_slug, t.name as tenant_name, u.name as assignee_name
    from onboarding_tasks k
    join tenants t on t.id = k.tenant_id
    left join platform_users u on u.id = k.assignee_id`;

const toTask = (r: Row): OnboardingTask => ({
  id: String(r.id),
  tenantId: String(r.tenant_id),
  tenantSlug: String(r.tenant_slug),
  tenantName: String(r.tenant_name),
  templateKey: text(r.template_key),
  title: String(r.title),
  description: text(r.description),
  completesWith: text(r.completes_with),
  dueAt: r.due_at as Date,
  assigneeId: text(r.assignee_id),
  assigneeName: text(r.assignee_name),
  status: r.status as OnboardingTaskStatus,
  doneAt: date(r.done_at),
  doneBy: text(r.done_by),
  doneAutomatically: r.done_automatically === true,
  note: text(r.note),
  createdAt: r.created_at as Date,
});

const toTemplate = (r: Row): TaskTemplate => ({
  key: String(r.key),
  title: String(r.title),
  description: text(r.description),
  dueAfterHours: Number(r.due_after_hours),
  completesWith: (r.completes_with ?? null) as OnboardingStep | null,
  position: Number(r.position),
  active: r.active === true,
});

/** The onboarding concierge's tables (platform migration 0026). */
export class PostgresOnboardingTasks implements IOnboardingTasks {
  constructor(private readonly db: Queryable) {}

  async templates(): Promise<TaskTemplate[]> {
    const { rows } = await this.db.query<Row>(
      "select * from onboarding_task_templates order by position, key",
    );
    return rows.map(toTemplate);
  }

  async saveTemplate(template: TaskTemplate, staffId: string): Promise<void> {
    await this.db.query(
      `insert into onboarding_task_templates
         (key, title, description, due_after_hours, completes_with, position, active, updated_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (key) do update
         set title = excluded.title, description = excluded.description,
             due_after_hours = excluded.due_after_hours, completes_with = excluded.completes_with,
             position = excluded.position, active = excluded.active,
             updated_by = excluded.updated_by, updated_at = now()`,
      [
        template.key,
        template.title,
        template.description,
        template.dueAfterHours,
        template.completesWith,
        template.position,
        template.active,
        staffId,
      ],
    );
  }

  async tenantsWithoutTasks(
    since: Date,
    limit: number,
  ): Promise<Readonly<{ tenantId: string; provisionedAt: Date }>[]> {
    const { rows } = await this.db.query<{ id: string; provisioned_at: Date }>(
      `select t.id, t.provisioned_at from tenants t
        where t.provisioned_at >= $1 and not t.demo
          and t.status in ('trialing', 'active', 'past_due', 'read_only')
          and not exists (select 1 from onboarding_tasks k where k.tenant_id = t.id)
        order by t.provisioned_at
        limit $2`,
      [since, limit],
    );
    return rows.map((r) => ({ tenantId: r.id, provisionedAt: r.provisioned_at }));
  }

  async create(
    tenantId: string,
    tasks: readonly PlannedTask[],
    assigneeId: string | null,
    createdBy: string | null,
  ): Promise<number> {
    let created = 0;
    for (const task of tasks) {
      const { rowCount } = await this.db.query(
        `insert into onboarding_tasks
           (tenant_id, template_key, title, description, completes_with, due_at, assignee_id,
            created_by)
         select $1, $2, $3, $4, $5, $6, $7, $8
          where exists (select 1 from tenants where id = $1 and not demo)
         on conflict (tenant_id, template_key) do nothing`,
        [
          tenantId,
          task.templateKey,
          task.title,
          task.description,
          task.completesWith,
          task.dueAt,
          assigneeId,
          createdBy,
        ],
      );
      created += rowCount ?? 0;
    }
    return created;
  }

  async addTask(
    tenantId: string,
    task: Readonly<{
      title: string;
      description: string | null;
      dueAt: Date;
      assigneeId: string | null;
    }>,
    createdBy: string,
  ): Promise<string> {
    const { rows } = await this.db.query<{ id: string }>(
      `insert into onboarding_tasks (tenant_id, title, description, due_at, assignee_id, created_by)
       values ($1, $2, $3, $4, $5, $6) returning id`,
      [tenantId, task.title, task.description, task.dueAt, task.assigneeId, createdBy],
    );
    return rows[0]!.id;
  }

  async find(id: string): Promise<OnboardingTask | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.db.query<Row>(`${TASKS} where k.id = $1`, [id]);
    return rows[0] === undefined ? null : toTask(rows[0]);
  }

  async list(filter: TaskFilter): Promise<OnboardingTask[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (column: string, value: unknown, op = "=") => {
      params.push(value);
      where.push(`${column} ${op} $${params.length}`);
    };
    if (filter.status !== undefined) add("k.status", filter.status);
    if (filter.tenantId !== undefined) add("k.tenant_id", filter.tenantId);
    if (filter.assigneeId !== undefined) add("k.assignee_id", filter.assigneeId);
    if (filter.overdueAt !== undefined) {
      where.push("k.status = 'open'");
      add("k.due_at", filter.overdueAt, "<");
    }
    params.push(filter.limit);
    const { rows } = await this.db.query<Row>(
      `${TASKS} ${where.length === 0 ? "" : `where ${where.join(" and ")}`}
        order by (k.status = 'open') desc, k.due_at, k.created_at
        limit $${params.length}`,
      params,
    );
    return rows.map(toTask);
  }

  async openWithMilestones(
    limit: number,
  ): Promise<
    Readonly<{ id: string; tenantId: string; completesWith: string; facts: OnboardingFacts }>[]
  > {
    const { rows } = await this.db.query<{
      id: string;
      tenant_id: string;
      completes_with: string;
      steps: OnboardingFacts;
    }>(
      `select k.id, k.tenant_id, k.completes_with, o.steps
         from onboarding_tasks k
         join tenant_onboarding o on o.tenant_id = k.tenant_id
        where k.status = 'open' and k.completes_with is not null
          and o.steps ? k.completes_with
        order by k.due_at
        limit $1`,
      [limit],
    );
    return rows.map((r) => ({
      id: r.id,
      tenantId: r.tenant_id,
      completesWith: r.completes_with,
      facts: r.steps,
    }));
  }

  async finish(
    id: string,
    status: "done" | "skipped",
    by: Readonly<{ staffId: string | null; automatically: boolean }>,
    note: string | null,
    at: Date,
  ): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `update onboarding_tasks
          set status = $2, done_at = $3, done_by = $4, done_automatically = $5, note = $6,
              updated_at = now()
        where id = $1 and status = 'open'`,
      [id, status, at, by.staffId, by.automatically, note],
    );
    return (rowCount ?? 0) > 0;
  }

  async reopen(id: string): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `update onboarding_tasks
          set status = 'open', done_at = null, done_by = null, done_automatically = false,
              updated_at = now()
        where id = $1 and status <> 'open'`,
      [id],
    );
    return (rowCount ?? 0) > 0;
  }

  async assignOpen(tenantId: string, assigneeId: string | null): Promise<number> {
    const { rowCount } = await this.db.query(
      `update onboarding_tasks set assignee_id = $2, updated_at = now()
        where tenant_id = $1 and status = 'open'`,
      [tenantId, assigneeId],
    );
    return rowCount ?? 0;
  }

  async assign(id: string, assigneeId: string | null): Promise<boolean> {
    const { rowCount } = await this.db.query(
      "update onboarding_tasks set assignee_id = $2, updated_at = now() where id = $1",
      [id, assigneeId],
    );
    return (rowCount ?? 0) > 0;
  }

  async staffExists(staffId: string): Promise<boolean> {
    if (!UUID.test(staffId)) return false;
    const { rowCount } = await this.db.query(
      "select 1 from platform_users where id = $1 and status = 'active'",
      [staffId],
    );
    return (rowCount ?? 0) > 0;
  }
}
