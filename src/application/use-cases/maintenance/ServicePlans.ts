import {
  checkTask,
  planScope,
  SERVICE_TEMPLATES,
  ServicePlanError,
  type PlanScope,
  type PlanTarget,
  type ServicePlanProps,
  type ServicePlanWithTasks,
  type ServiceTaskProps,
  type TaskInput,
} from "../../../domain/maintenance/ServicePlan.js";
import type { Principal } from "../../authorization/Principal.js";
import { ApplicationError } from "../../errors/ApplicationError.js";
import type { IAuditTrail } from "../../ports/IAuditTrail.js";
import type { IIdGenerator } from "../../ports/IIdGenerator.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import type { IServicePlans } from "../../ports/IServicePlans.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import { recordUserAction } from "../reference/userAudit.js";
import type { ServiceSchedule } from "./ServiceSchedule.js";

export class ServicePlanNotFoundError extends ApplicationError {
  readonly code = "SERVICE_PLAN_NOT_FOUND";
  constructor(what = "Service plan") {
    super(`${what} not found`);
  }
}

export type PlanInput = Readonly<{
  name?: string;
  description?: string | null;
  appliesTo: PlanTarget;
  make?: string | null;
  model?: string | null;
  groupId?: string | null;
  classId?: string | null;
  vehicleId?: string | null;
  /** Copy a built-in template's tasks (and name, unless given). */
  template?: string;
  tasks?: readonly TaskInput[];
}>;

export type PlanChange = Partial<Omit<PlanInput, "template" | "tasks">> &
  Readonly<{ active?: boolean }>;

export type TaskChange = Partial<TaskInput> & Readonly<{ position?: number; active?: boolean }>;

/**
 * Service plans (docs/12 §2): built-in templates businesses copy and adjust, plans for every
 * vehicle, a make and model, a group, a rental class or one vehicle, and their tasks. Any change
 * re-runs the due engine for the fleet (decision 377).
 */
export class ServicePlans {
  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      plans: IServicePlans;
      schedule: ServiceSchedule;
      auditTrail: IAuditTrail;
      requestContext: IRequestContext;
      ids: IIdGenerator;
      clock: { now(): Date };
    }>,
  ) {}

  templates() {
    return Object.entries(SERVICE_TEMPLATES).map(([key, t]) => ({ key, ...t }));
  }

  list(includeInactive: boolean): Promise<ServicePlanWithTasks[]> {
    return this.deps.unitOfWork.run(() => this.deps.plans.plans(includeInactive));
  }

  get(id: string): Promise<ServicePlanWithTasks> {
    return this.deps.unitOfWork.run(() => this.found(id));
  }

  create(actor: Principal, input: PlanInput): Promise<ServicePlanWithTasks> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const template = input.template === undefined ? undefined : SERVICE_TEMPLATES[input.template];
      if (input.template !== undefined && template === undefined)
        throw new ServicePlanError(`There is no template "${input.template}"`);
      const tasks = input.tasks ?? template?.tasks ?? [];
      if (tasks.length === 0) throw new ServicePlanError("A plan needs at least one task");
      const now = deps.clock.now();
      const plan: ServicePlanProps = {
        id: deps.ids.next(),
        name: named(input.name ?? template?.name),
        description: blank(input.description ?? template?.description),
        ...(await this.scope(input)),
        template: input.template ?? null,
        active: true,
        createdAt: now,
        updatedAt: now,
      };
      await deps.plans.addPlan(plan, actor.userId);
      for (const [position, task] of tasks.entries())
        await deps.plans.addTask(newTask(deps.ids.next(), plan.id, position, task));
      const saved = await this.found(plan.id);
      await this.changed(actor, "service_plan.created", saved, null);
      return saved;
    });
  }

  update(actor: Principal, id: string, change: PlanChange): Promise<ServicePlanWithTasks> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const before = await this.found(id);
      const scope =
        change.appliesTo === undefined &&
        change.make === undefined &&
        change.model === undefined &&
        change.groupId === undefined &&
        change.classId === undefined &&
        change.vehicleId === undefined
          ? scopeOf(before)
          : await this.scope({ ...scopeOf(before), ...change });
      await deps.plans.updatePlan({
        ...before,
        ...scope,
        name: change.name === undefined ? before.name : named(change.name),
        description:
          change.description === undefined ? before.description : blank(change.description),
        active: change.active ?? before.active,
        updatedAt: deps.clock.now(),
      });
      const after = await this.found(id);
      await this.changed(actor, "service_plan.updated", after, before);
      return after;
    });
  }

  addTask(actor: Principal, planId: string, input: TaskInput): Promise<ServicePlanWithTasks> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const before = await this.found(planId);
      const position = Math.max(-1, ...before.tasks.map((t) => t.position)) + 1;
      await deps.plans.addTask(newTask(deps.ids.next(), planId, position, input));
      const after = await this.found(planId);
      await this.changed(actor, "service_plan.task_added", after, before);
      return after;
    });
  }

  updateTask(actor: Principal, taskId: string, change: TaskChange): Promise<ServicePlanWithTasks> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const task = await deps.plans.task(taskId);
      if (task === null) throw new ServicePlanNotFoundError("Task");
      const before = await this.found(task.planId);
      const next: ServiceTaskProps = {
        ...task,
        name: change.name === undefined ? task.name : change.name.trim(),
        everyKm: change.everyKm === undefined ? task.everyKm : change.everyKm,
        everyDays: change.everyDays === undefined ? task.everyDays : change.everyDays,
        noticeKm: change.noticeKm ?? task.noticeKm,
        noticeDays: change.noticeDays ?? task.noticeDays,
        graceKm: change.graceKm ?? task.graceKm,
        graceDays: change.graceDays ?? task.graceDays,
        position: change.position ?? task.position,
        active: change.active ?? task.active,
      };
      checkTask(next);
      await deps.plans.updateTask(next);
      const after = await this.found(task.planId);
      await this.changed(actor, "service_plan.task_updated", after, before);
      return after;
    });
  }

  // --- helpers ---

  private async scope(input: Partial<PlanScope> & Readonly<{ appliesTo: PlanTarget }>) {
    const scope = planScope(input);
    const refs = [
      ["group", scope.groupId, "Vehicle group"],
      ["class", scope.classId, "Vehicle class"],
      ["vehicle", scope.vehicleId, "Vehicle"],
    ] as const;
    for (const [kind, id, label] of refs)
      if (id !== null && !(await this.deps.plans.exists(kind, id)))
        throw new ServicePlanNotFoundError(label);
    return scope;
  }

  private async found(id: string): Promise<ServicePlanWithTasks> {
    const plan = await this.deps.plans.plan(id);
    if (plan === null) throw new ServicePlanNotFoundError();
    return plan;
  }

  /** Audited, and the fleet's due rows follow the new plans. */
  private async changed(
    actor: Principal,
    action: string,
    after: ServicePlanWithTasks,
    before: ServicePlanWithTasks | null,
  ): Promise<void> {
    await recordUserAction(this.deps, actor.userId, {
      action,
      entityType: "service_plan",
      entityId: after.id,
      before,
      after,
    });
    await this.deps.schedule.recompute(null);
  }
}

function newTask(id: string, planId: string, position: number, input: TaskInput): ServiceTaskProps {
  const task: ServiceTaskProps = {
    id,
    planId,
    name: input.name.trim(),
    everyKm: input.everyKm ?? null,
    everyDays: input.everyDays ?? null,
    noticeKm: input.noticeKm ?? 1_000,
    noticeDays: input.noticeDays ?? 14,
    graceKm: input.graceKm ?? 500,
    graceDays: input.graceDays ?? 7,
    position,
    active: true,
  };
  // The default notice never outgrows a short interval.
  const fitted = {
    ...task,
    noticeKm:
      input.noticeKm === undefined && task.everyKm !== null
        ? Math.min(task.noticeKm, Math.floor(task.everyKm / 5))
        : task.noticeKm,
    noticeDays:
      input.noticeDays === undefined && task.everyDays !== null
        ? Math.min(task.noticeDays, Math.floor(task.everyDays / 5))
        : task.noticeDays,
  };
  checkTask(fitted);
  return fitted;
}

const scopeOf = (plan: PlanScope): PlanScope => ({
  appliesTo: plan.appliesTo,
  make: plan.make,
  model: plan.model,
  groupId: plan.groupId,
  classId: plan.classId,
  vehicleId: plan.vehicleId,
});

function named(name: string | undefined): string {
  const text = name?.trim() ?? "";
  if (text === "") throw new ServicePlanError("A plan needs a name");
  if (text.length > 120) throw new ServicePlanError("A plan name is at most 120 characters");
  return text;
}

const blank = (value: string | null | undefined): string | null => {
  const text = value?.trim() ?? "";
  return text === "" ? null : text;
};
