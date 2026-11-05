import { pageOf, pageWindow, type Page, type Paging } from "../../dto/Page.js";
import {
  CONCIERGE_WINDOW_DAYS,
  checkTemplate,
  doneByProgress,
  OnboardingRuleError,
  planTasks,
  type TaskTemplate,
} from "../../../domain/console/OnboardingConcierge.js";
import type { OnboardingStep } from "../../../domain/console/TenantAnalytics.js";
import type { PlatformPrincipal } from "../../authorization/PlatformPrincipal.js";
import type { IJobHandler } from "../../jobs/IJobHandler.js";
import type { IClock } from "../../ports/IClock.js";
import type { ILogger } from "../../ports/ILogger.js";
import type { IOnboardingTasks, OnboardingTask, TaskFilter } from "../../ports/IOnboardingTasks.js";
import type { IPlatformAuditTrail } from "../../ports/IPlatformAuditTrail.js";

const DAY_MS = 86_400_000;

/**
 * The onboarding concierge (docs/27 §5.12, decision 502): every new tenant gets a task list for
 * staff from the templates — welcome call within a day, vehicles imported, app installed via
 * the QR link, a check-in after two weeks — due after provisioning. Tasks tied to an onboarding
 * milestone tick themselves off when the tenant reaches it; staff complete or skip the others
 * with a note. Demo tenants get none.
 */
export class OnboardingConcierge {
  constructor(
    private readonly deps: Readonly<{
      tasks: IOnboardingTasks;
      audit: IPlatformAuditTrail;
      clock: IClock;
    }>,
  ) {}

  templates(): Promise<TaskTemplate[]> {
    return this.deps.tasks.templates();
  }

  async saveTemplate(
    actor: PlatformPrincipal,
    key: string,
    input: Omit<TaskTemplate, "key">,
  ): Promise<TaskTemplate[]> {
    if (!/^[a-z][a-z0-9_]{1,39}$/.test(key))
      throw new OnboardingRuleError("A template key is lower case letters, digits and _");
    checkTemplate(input);
    const template = { ...input, key, title: input.title.trim() };
    await this.deps.tasks.saveTemplate(template, actor.userId);
    await this.deps.audit.record({
      actorType: "platform_staff",
      actorId: actor.userId,
      action: "onboarding.template_saved",
      entityType: "onboarding_template",
      entityId: key,
      after: { ...template },
    });
    return this.templates();
  }

  async list(filter: Paging<TaskFilter>): Promise<Page<OnboardingTask>> {
    return pageOf(filter, await this.deps.tasks.list({ ...filter, ...pageWindow(filter) }));
  }

  /** The tasks of the tenant, open first. */
  async tenantTasks(tenantId: string): Promise<OnboardingTask[]> {
    return (await this.deps.tasks.list({ tenantId, limit: 200 })).rows;
  }

  /** Creates a new tenant's tasks from the templates (once; none for a demo). */
  async start(tenantId: string, provisionedAt: Date): Promise<number> {
    return this.deps.tasks.create(
      tenantId,
      planTasks(await this.deps.tasks.templates(), provisionedAt),
      null,
      null,
    );
  }

  async addTask(
    actor: PlatformPrincipal,
    tenantId: string,
    input: Readonly<{
      title: string;
      description: string | null;
      dueAt: Date;
      assigneeId: string | null;
    }>,
  ): Promise<OnboardingTask> {
    if (input.assigneeId !== null) await this.requireStaff(input.assigneeId);
    const id = await this.deps.tasks.addTask(
      tenantId,
      { ...input, title: input.title.trim() },
      actor.userId,
    );
    return this.require(id);
  }

  async finish(
    actor: PlatformPrincipal,
    id: string,
    status: "done" | "skipped",
    note: string | null,
  ): Promise<OnboardingTask> {
    const task = await this.require(id);
    if (task.status !== "open") throw new OnboardingRuleError("The task is not open");
    if (status === "skipped" && (note === null || note.trim().length < 3))
      throw new OnboardingRuleError("Say why the task is skipped");
    await this.deps.tasks.finish(
      id,
      status,
      { staffId: actor.userId, automatically: false },
      note?.trim() || null,
      this.deps.clock.now(),
    );
    await this.audited(actor, `onboarding.task_${status === "done" ? "done" : "skipped"}`, task);
    return this.require(id);
  }

  async reopen(actor: PlatformPrincipal, id: string): Promise<OnboardingTask> {
    const task = await this.require(id);
    if (task.status === "open") return task;
    await this.deps.tasks.reopen(id);
    await this.audited(actor, "onboarding.task_reopened", task);
    return this.require(id);
  }

  async assign(
    actor: PlatformPrincipal,
    id: string,
    assigneeId: string | null,
  ): Promise<OnboardingTask> {
    const task = await this.require(id);
    if (assigneeId !== null) await this.requireStaff(assigneeId);
    await this.deps.tasks.assign(id, assigneeId);
    await this.audited(actor, "onboarding.task_assigned", task, { assigneeId });
    return this.require(id);
  }

  /** The tenant's concierge: every open task goes to them. */
  async assignTenant(
    actor: PlatformPrincipal,
    tenantId: string,
    assigneeId: string | null,
  ): Promise<OnboardingTask[]> {
    if (assigneeId !== null) await this.requireStaff(assigneeId);
    const count = await this.deps.tasks.assignOpen(tenantId, assigneeId);
    await this.deps.audit.record({
      actorType: "platform_staff",
      actorId: actor.userId,
      action: "onboarding.concierge_assigned",
      entityType: "tenant",
      entityId: tenantId,
      targetTenantId: tenantId,
      after: { assigneeId, tasks: count },
    });
    return this.tenantTasks(tenantId);
  }

  private async require(id: string): Promise<OnboardingTask> {
    const task = await this.deps.tasks.find(id);
    if (task === null) throw new OnboardingRuleError("No such task");
    return task;
  }

  private async requireStaff(staffId: string): Promise<void> {
    if (!(await this.deps.tasks.staffExists(staffId)))
      throw new OnboardingRuleError("No such staff member");
  }

  private audited(
    actor: PlatformPrincipal,
    action: string,
    task: OnboardingTask,
    after: Readonly<Record<string, unknown>> = {},
  ): Promise<string> {
    return this.deps.audit.record({
      actorType: "platform_staff",
      actorId: actor.userId,
      action,
      entityType: "onboarding_task",
      entityId: task.id,
      targetTenantId: task.tenantId,
      after: { title: task.title, ...after },
    });
  }
}

/**
 * Hourly: tenants provisioned in the last 30 days without tasks get them (a safety net for the
 * provisioning hook), and open tasks whose milestone the tenant reached are done automatically.
 */
export class SweepOnboarding implements IJobHandler<"onboarding.sweep"> {
  readonly job = "onboarding.sweep" as const;

  constructor(
    private readonly deps: Readonly<{
      concierge: OnboardingConcierge;
      tasks: IOnboardingTasks;
      clock: IClock;
      logger: ILogger;
    }>,
  ) {}

  async handle(): Promise<void> {
    const { deps } = this;
    const now = deps.clock.now();
    let created = 0;
    for (const t of await deps.tasks.tenantsWithoutTasks(
      new Date(now.getTime() - CONCIERGE_WINDOW_DAYS * DAY_MS),
      200,
    ))
      created += await deps.concierge.start(t.tenantId, t.provisionedAt);
    let done = 0;
    const open = await deps.tasks.openWithMilestones(1_000);
    for (const task of open)
      for (const reached of doneByProgress([task], task.facts))
        if (
          await deps.tasks.finish(
            reached.id,
            "done",
            { staffId: null, automatically: true },
            `Done in the app (${reached.completesWith as OnboardingStep})`,
            now,
          )
        )
          done++;
    if (created + done > 0) deps.logger.info("Onboarding concierge sweep", { created, done });
  }
}
