import { ReportRuleError } from "./Report.js";

/** The roles with a dashboard of their own (docs/14 §4). */
export const DASHBOARD_ROLES = [
  "owner",
  "fleet_manager",
  "rental_agent",
  "sales_executive",
  "accountant",
] as const;
export type DashboardRole = (typeof DASHBOARD_ROLES)[number];

export const MAX_WIDGETS = 20;

/** The widgets of a role's dashboard, in order: known keys, each once, 1 to 20. */
export function checkWidgets(widgets: readonly string[], known: readonly string[]): string[] {
  const unique = [...new Set(widgets)];
  if (unique.length !== widgets.length) throw new ReportRuleError("A widget is shown once");
  if (unique.length < 1 || unique.length > MAX_WIDGETS)
    throw new ReportRuleError(`A dashboard has 1 to ${MAX_WIDGETS} widgets`);
  for (const key of unique)
    if (!known.includes(key)) throw new ReportRuleError(`There is no widget "${key}"`);
  return unique;
}
