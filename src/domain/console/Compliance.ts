import type { Incident, IncidentImpact } from "../repositories/IComplianceRepositories.js";

/** Days to answer a data-protection request by default (confirm with counsel, doc 19 round 5). */
export const DPR_RESPONSE_DAYS = 30;

/** The last day of the quarter `date` (YYYY-MM-DD) is in. */
export function quarterEnd(date: string): string {
  const [y, m] = date.split("-").map(Number) as [number, number];
  const lastMonth = Math.ceil(m / 3) * 3;
  return new Date(Date.UTC(y, lastMonth, 0)).toISOString().slice(0, 10);
}

/** The last day of the quarter after the one `date` is in. */
export function nextQuarterEnd(date: string): string {
  const end = quarterEnd(date);
  const next = new Date(Date.parse(`${end}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  return quarterEnd(next);
}

export const STATUS_COMPONENTS = ["api", "web", "mobile", "payments", "notifications"] as const;

export type OverallStatus =
  "operational" | "degraded" | "partial_outage" | "major_outage" | "maintenance";

const BY_IMPACT: Readonly<Record<IncidentImpact, OverallStatus>> = {
  minor: "degraded",
  major: "partial_outage",
  critical: "major_outage",
};
const RANK: readonly OverallStatus[] = [
  "operational",
  "maintenance",
  "degraded",
  "partial_outage",
  "major_outage",
];

/** The status page's headline: the worst unresolved incident, or maintenance under way. */
export function overallStatus(
  incidents: readonly Incident[],
  maintenanceNow: boolean,
): OverallStatus {
  let worst: OverallStatus = maintenanceNow ? "maintenance" : "operational";
  for (const i of incidents)
    if (i.status !== "resolved" && RANK.indexOf(BY_IMPACT[i.impact]) > RANK.indexOf(worst))
      worst = BY_IMPACT[i.impact];
  return worst;
}
