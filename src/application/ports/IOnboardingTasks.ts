import type { PlannedTask, TaskTemplate } from "../../domain/console/OnboardingConcierge.js";
import type { OnboardingFacts } from "../../domain/console/TenantAnalytics.js";

export type OnboardingTaskStatus = "open" | "done" | "skipped";

export type OnboardingTask = Readonly<{
  id: string;
  tenantId: string;
  tenantSlug: string;
  tenantName: string;
  templateKey: string | null;
  title: string;
  description: string | null;
  completesWith: string | null;
  dueAt: Date;
  assigneeId: string | null;
  assigneeName: string | null;
  status: OnboardingTaskStatus;
  doneAt: Date | null;
  doneBy: string | null;
  doneAutomatically: boolean;
  note: string | null;
  createdAt: Date;
}>;

export type TaskFilter = Readonly<{
  status?: OnboardingTaskStatus;
  tenantId?: string;
  assigneeId?: string;
  /** Open and past due. */
  overdueAt?: Date;
  limit: number;
}>;

/** The onboarding concierge's templates and tasks (platform database, docs/27 §5.12). */
export interface IOnboardingTasks {
  templates(): Promise<TaskTemplate[]>;
  saveTemplate(template: TaskTemplate, staffId: string): Promise<void>;
  /** Live, non-demo tenants provisioned since `since` without any concierge task yet. */
  tenantsWithoutTasks(
    since: Date,
    limit: number,
  ): Promise<Readonly<{ tenantId: string; provisionedAt: Date }>[]>;
  /** Creates the tasks (skipping templates the tenant already has); returns how many. */
  create(
    tenantId: string,
    tasks: readonly PlannedTask[],
    assigneeId: string | null,
    createdBy: string | null,
  ): Promise<number>;
  addTask(
    tenantId: string,
    task: Readonly<{
      title: string;
      description: string | null;
      dueAt: Date;
      assigneeId: string | null;
    }>,
    createdBy: string,
  ): Promise<string>;
  find(id: string): Promise<OnboardingTask | null>;
  list(filter: TaskFilter): Promise<OnboardingTask[]>;
  /** Open tasks completed by a milestone, with the tenant's milestones. */
  openWithMilestones(
    limit: number,
  ): Promise<
    Readonly<{ id: string; tenantId: string; completesWith: string; facts: OnboardingFacts }>[]
  >;
  finish(
    id: string,
    status: "done" | "skipped",
    by: Readonly<{ staffId: string | null; automatically: boolean }>,
    note: string | null,
    at: Date,
  ): Promise<boolean>;
  reopen(id: string): Promise<boolean>;
  assignOpen(tenantId: string, assigneeId: string | null): Promise<number>;
  assign(id: string, assigneeId: string | null): Promise<boolean>;
  staffExists(staffId: string): Promise<boolean>;
}
