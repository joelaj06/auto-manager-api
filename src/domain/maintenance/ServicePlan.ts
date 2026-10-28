import { DomainError } from "../errors/DomainError.js";

export class ServicePlanError extends DomainError {
  readonly code = "SERVICE_PLAN_RULE";
  constructor(message: string) {
    super(message);
  }
}

export const PLAN_TARGETS = [
  "all",
  "make_model",
  "vehicle_group",
  "rental_class",
  "vehicle",
] as const;
export type PlanTarget = (typeof PLAN_TARGETS)[number];

export type PlanScope = Readonly<{
  appliesTo: PlanTarget;
  make: string | null;
  model: string | null;
  groupId: string | null;
  classId: string | null;
  vehicleId: string | null;
}>;

export type ServiceTaskProps = Readonly<{
  id: string;
  planId: string;
  name: string;
  everyKm: number | null;
  everyDays: number | null;
  noticeKm: number;
  noticeDays: number;
  graceKm: number;
  graceDays: number;
  position: number;
  active: boolean;
}>;

export type ServicePlanProps = PlanScope &
  Readonly<{
    id: string;
    name: string;
    description: string | null;
    template: string | null;
    active: boolean;
    createdAt: Date;
    updatedAt: Date;
  }>;

export type ServicePlanWithTasks = ServicePlanProps &
  Readonly<{ tasks: readonly ServiceTaskProps[] }>;

const MAX_KM = 1_000_000;
const MAX_DAYS = 3_650;

/** The scope as given, cleaned: only the fields its target uses. */
export function planScope(
  input: Partial<PlanScope> & Readonly<{ appliesTo: PlanTarget }>,
): PlanScope {
  const scope: PlanScope = {
    appliesTo: input.appliesTo,
    make: input.appliesTo === "make_model" ? trimmed(input.make) : null,
    model: input.appliesTo === "make_model" ? trimmed(input.model) : null,
    groupId: input.appliesTo === "vehicle_group" ? (input.groupId ?? null) : null,
    classId: input.appliesTo === "rental_class" ? (input.classId ?? null) : null,
    vehicleId: input.appliesTo === "vehicle" ? (input.vehicleId ?? null) : null,
  };
  const missing: Readonly<Record<PlanTarget, [unknown, string] | null>> = {
    all: null,
    make_model: [scope.make, "make"],
    vehicle_group: [scope.groupId, "groupId"],
    rental_class: [scope.classId, "classId"],
    vehicle: [scope.vehicleId, "vehicleId"],
  };
  const need = missing[scope.appliesTo];
  if (need !== null && need[0] === null)
    throw new ServicePlanError(`A plan for ${scope.appliesTo.replace("_", " ")} needs ${need[1]}`);
  return scope;
}

export type TaskInput = Readonly<{
  name: string;
  everyKm?: number | null;
  everyDays?: number | null;
  noticeKm?: number;
  noticeDays?: number;
  graceKm?: number;
  graceDays?: number;
}>;

/** A task's intervals checked: km and/or days, whichever comes first. */
export function checkTask(
  task: Omit<ServiceTaskProps, "id" | "planId" | "position" | "active">,
): void {
  if (task.name.trim().length === 0) throw new ServicePlanError("A task needs a name");
  if (task.everyKm === null && task.everyDays === null)
    throw new ServicePlanError(`${task.name}: give every how many km or days`);
  if (task.everyKm !== null && (task.everyKm < 1 || task.everyKm > MAX_KM))
    throw new ServicePlanError(`${task.name}: every 1 to ${MAX_KM} km`);
  if (task.everyDays !== null && (task.everyDays < 1 || task.everyDays > MAX_DAYS))
    throw new ServicePlanError(`${task.name}: every 1 to ${MAX_DAYS} days`);
  if (task.everyKm !== null && task.noticeKm >= task.everyKm)
    throw new ServicePlanError(`${task.name}: the notice must be shorter than the interval`);
  if (task.everyDays !== null && task.noticeDays >= task.everyDays)
    throw new ServicePlanError(`${task.name}: the notice must be shorter than the interval`);
}

/** Facts about a vehicle that decide which plan it follows. */
export type VehicleForPlan = Readonly<{
  vehicleId: string;
  make: string;
  model: string;
  groupIds: readonly string[];
  classId: string | null;
}>;

/** Most specific first: the vehicle itself, its make and model, its make, a group, its class. */
const SPECIFICITY = (plan: PlanScope): number => {
  switch (plan.appliesTo) {
    case "vehicle":
      return 5;
    case "make_model":
      return plan.model === null ? 3 : 4;
    case "vehicle_group":
      return 2;
    case "rental_class":
      return 1;
    case "all":
      return 0;
  }
};

const same = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base" }) === 0;

export function planCovers(plan: PlanScope, vehicle: VehicleForPlan): boolean {
  switch (plan.appliesTo) {
    case "all":
      return true;
    case "vehicle":
      return plan.vehicleId === vehicle.vehicleId;
    case "make_model":
      return (
        same(plan.make!, vehicle.make) && (plan.model === null || same(plan.model, vehicle.model))
      );
    case "vehicle_group":
      return vehicle.groupIds.includes(plan.groupId!);
    case "rental_class":
      return plan.classId === vehicle.classId;
  }
}

/**
 * The plan a vehicle follows: the most specific active plan covering it, the newest on a tie
 * (decision 377). Plans do not add up, so one oil change is never scheduled twice.
 */
export function planFor<P extends PlanScope & Readonly<{ active: boolean; createdAt: Date }>>(
  plans: readonly P[],
  vehicle: VehicleForPlan,
): P | null {
  let best: P | null = null;
  for (const plan of plans) {
    if (!plan.active || !planCovers(plan, vehicle)) continue;
    if (
      best === null ||
      SPECIFICITY(plan) > SPECIFICITY(best) ||
      (SPECIFICITY(plan) === SPECIFICITY(best) && plan.createdAt > best.createdAt)
    )
      best = plan;
  }
  return best;
}

/** Built-in templates businesses copy into their own plans and then adjust (docs/12 §2). */
export const SERVICE_TEMPLATES: Readonly<
  Record<string, Readonly<{ name: string; description: string; tasks: readonly TaskInput[] }>>
> = {
  standard: {
    name: "Standard service",
    description: "Typical service schedule for cars and light vehicles",
    tasks: [
      { name: "Engine oil and filter", everyKm: 5_000, everyDays: 90 },
      { name: "Tyre rotation and pressure check", everyKm: 10_000, everyDays: 180 },
      { name: "Brake inspection", everyKm: 10_000, everyDays: 180 },
      { name: "Air filter", everyKm: 15_000, everyDays: 365 },
      { name: "Air conditioning service", everyDays: 365, noticeDays: 30 },
      { name: "Timing belt", everyKm: 60_000, noticeKm: 2_000 },
    ],
  },
  heavy_use: {
    name: "Heavy use (taxi and ride-hailing)",
    description: "Shorter intervals for vehicles driven all day",
    tasks: [
      {
        name: "Engine oil and filter",
        everyKm: 3_000,
        everyDays: 30,
        noticeKm: 500,
        noticeDays: 7,
      },
      { name: "Tyre rotation and pressure check", everyKm: 8_000, everyDays: 90 },
      { name: "Brake inspection", everyKm: 8_000, everyDays: 90 },
      { name: "Air filter", everyKm: 10_000, everyDays: 180 },
      { name: "Timing belt", everyKm: 50_000, noticeKm: 2_000 },
    ],
  },
};

const trimmed = (value: string | null | undefined): string | null => {
  const text = value?.trim() ?? "";
  return text === "" ? null : text;
};
