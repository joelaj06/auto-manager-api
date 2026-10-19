import { ExpenseRuleError } from "./Expense.js";

export type ApprovalAction = "auto_approve" | "require_approval";

export type ApprovalRule = Readonly<{
  id: string;
  name: string;
  priority: number;
  categoryId: string | null;
  branchId: string | null;
  minAmountMinor: number;
  maxAmountMinor: number | null;
  action: ApprovalAction;
  active: boolean;
}>;

/**
 * The rule that decides an expense (docs/12 §8 "rules by amount/category/branch"): the first
 * active rule by priority whose category (or its parent), branch and amount range match.
 * Null: no rule — a person approves.
 */
export function matchingRule(
  rules: readonly ApprovalRule[],
  expense: Readonly<{
    amountMinor: number;
    branchId: string;
    /** The expense's category and its parent. */
    categoryIds: readonly string[];
  }>,
): ApprovalRule | null {
  return (
    [...rules]
      .filter((r) => r.active)
      .sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name))
      .find(
        (r) =>
          (r.categoryId === null || expense.categoryIds.includes(r.categoryId)) &&
          (r.branchId === null || r.branchId === expense.branchId) &&
          expense.amountMinor >= r.minAmountMinor &&
          (r.maxAmountMinor === null || expense.amountMinor <= r.maxAmountMinor),
      ) ?? null
  );
}

export function checkRule(rule: ApprovalRule): ApprovalRule {
  const name = rule.name.trim();
  if (name === "" || name.length > 120) throw new ExpenseRuleError("A rule needs a name");
  if (rule.maxAmountMinor !== null && rule.maxAmountMinor < rule.minAmountMinor)
    throw new ExpenseRuleError("The upper amount is below the lower amount");
  return { ...rule, name };
}

export type BudgetLevel = "ok" | "warning" | "exceeded";

/** 80% spent warns, 100% is exceeded (docs/12 §8). */
export function budgetLevel(spentMinor: number, budgetMinor: number): BudgetLevel {
  if (spentMinor >= budgetMinor) return "exceeded";
  if (spentMinor * 10 >= budgetMinor * 8) return "warning";
  return "ok";
}

export type RecurringFrequency = "weekly" | "monthly" | "quarterly" | "yearly";

/**
 * The next run after `date`. Monthly runs keep the anchor day where the month has it (the 31st
 * runs on the 30th in a 30-day month, then on the 31st again).
 */
export function nextRun(date: string, frequency: RecurringFrequency, anchorDay: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  if (frequency === "weekly") {
    d.setUTCDate(d.getUTCDate() + 7);
    return d.toISOString().slice(0, 10);
  }
  const months = { monthly: 1, quarterly: 3, yearly: 12 }[frequency];
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1));
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(anchorDay, lastDay));
  return target.toISOString().slice(0, 10);
}

export type FuelFill = Readonly<{
  id: string;
  odometer: number;
  litres: number;
  fullTank: boolean;
}>;

export type FuelEfficiency = Readonly<{
  /** The full-tank fill that closes the interval. */
  fillId: string;
  distance: number;
  litres: number;
  kmPerLitre: number;
  /** Far below this vehicle's usual efficiency (possible siphoning or a leak). */
  flagged: boolean;
}>;

/**
 * Fuel efficiency between full-tank fills (docs/06 §7): distance since the previous full fill
 * divided by the litres put in since then (partial fills included). An interval below 70% of
 * the vehicle's median is flagged once there are at least three intervals.
 */
export function fuelEfficiency(fills: readonly FuelFill[]): FuelEfficiency[] {
  const ordered = [...fills].sort((a, b) => a.odometer - b.odometer);
  const intervals: Omit<FuelEfficiency, "flagged">[] = [];
  let previousFull: FuelFill | null = null;
  let litres = 0;
  for (const fill of ordered) {
    if (previousFull !== null) litres += fill.litres;
    if (!fill.fullTank) continue;
    if (previousFull !== null && fill.odometer > previousFull.odometer && litres > 0) {
      const distance = fill.odometer - previousFull.odometer;
      intervals.push({
        fillId: fill.id,
        distance,
        litres: Math.round(litres * 100) / 100,
        kmPerLitre: Math.round((distance / litres) * 100) / 100,
      });
    }
    previousFull = fill;
    litres = 0;
  }
  const sorted = intervals.map((i) => i.kmPerLitre).sort((a, b) => a - b);
  const median =
    sorted.length === 0
      ? 0
      : sorted.length % 2 === 1
        ? sorted[(sorted.length - 1) / 2]!
        : (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2;
  return intervals.map((i) => ({
    ...i,
    flagged: intervals.length >= 3 && i.kmPerLitre < median * 0.7,
  }));
}
