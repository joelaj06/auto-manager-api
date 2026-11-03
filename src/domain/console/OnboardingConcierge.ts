import { DomainError } from "../errors/DomainError.js";
import { ONBOARDING_STEPS, type OnboardingFacts, type OnboardingStep } from "./TenantAnalytics.js";

export class OnboardingRuleError extends DomainError {
  readonly code = "ONBOARDING_RULE";
  constructor(message: string) {
    super(message);
  }
}

const HOUR_MS = 3_600_000;

/** Tenants provisioned this recently get the concierge's tasks (and older ones are left alone). */
export const CONCIERGE_WINDOW_DAYS = 30;

export type TaskTemplate = Readonly<{
  key: string;
  title: string;
  description: string | null;
  dueAfterHours: number;
  completesWith: OnboardingStep | null;
  position: number;
  active: boolean;
}>;

export type PlannedTask = Readonly<{
  templateKey: string;
  title: string;
  description: string | null;
  completesWith: OnboardingStep | null;
  dueAt: Date;
}>;

/** The tasks of a new tenant (docs/27 §5.12): each active template, due after provisioning. */
export function planTasks(templates: readonly TaskTemplate[], provisionedAt: Date): PlannedTask[] {
  return templates
    .filter((t) => t.active)
    .sort((a, b) => a.position - b.position || a.key.localeCompare(b.key))
    .map((t) => ({
      templateKey: t.key,
      title: t.title,
      description: t.description,
      completesWith: t.completesWith,
      dueAt: new Date(provisionedAt.getTime() + t.dueAfterHours * HOUR_MS),
    }));
}

/** The open tasks the tenant's own progress has done (a milestone reached). */
export function doneByProgress<T extends Readonly<{ completesWith: string | null }>>(
  tasks: readonly T[],
  facts: OnboardingFacts,
): T[] {
  return tasks.filter(
    (t) => t.completesWith !== null && facts[t.completesWith as OnboardingStep] !== undefined,
  );
}

export function checkTemplate(
  input: Readonly<{ dueAfterHours: number; completesWith: string | null }>,
) {
  if (
    !Number.isInteger(input.dueAfterHours) ||
    input.dueAfterHours < 1 ||
    input.dueAfterHours > 2_160
  )
    throw new OnboardingRuleError("A task is due 1 hour to 90 days after provisioning");
  if (input.completesWith !== null && !ONBOARDING_STEPS.some((s) => s.key === input.completesWith))
    throw new OnboardingRuleError(`Unknown onboarding milestone ${input.completesWith}`);
}
