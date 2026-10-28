/** A stretch of time a vehicle was off the road; `end` null while it still is. */
export type OffRoadSpell = Readonly<{ start: Date; end: Date | null }>;

/**
 * Seconds of `[from, to)` a vehicle was off the road (decision 404): its spells cut to the period,
 * an open spell running to `now`, and spells that overlap counted once — a work order and the
 * incident behind it are one stay in the workshop, not two.
 */
export function offRoadSeconds(
  spells: readonly OffRoadSpell[],
  from: Date,
  to: Date,
  now: Date,
): number {
  const limit = Math.min(to.getTime(), now.getTime());
  const cut = spells
    .map((s) => ({
      start: Math.max(s.start.getTime(), from.getTime()),
      end: Math.min((s.end ?? now).getTime(), limit),
    }))
    .filter((s) => s.end > s.start)
    .sort((a, b) => a.start - b.start);
  let total = 0;
  let current: { start: number; end: number } | null = null;
  for (const spell of cut) {
    if (current !== null && spell.start <= current.end) {
      current.end = Math.max(current.end, spell.end);
      continue;
    }
    if (current !== null) total += current.end - current.start;
    current = { ...spell };
  }
  if (current !== null) total += current.end - current.start;
  return total / 1_000;
}

/** Seconds of `[from, to)` up to `now` a vehicle was in the fleet: from added until it left. */
export function inServiceSeconds(
  vehicle: Readonly<{ addedAt: Date; leftAt: Date | null }>,
  from: Date,
  to: Date,
  now: Date,
): number {
  const start = Math.max(vehicle.addedAt.getTime(), from.getTime());
  const end = Math.min(to.getTime(), now.getTime(), (vehicle.leftAt ?? to).getTime());
  return Math.max(0, (end - start) / 1_000);
}

/** Share of `whole` that `part` is, in percent with one decimal; null without a whole. */
export function percentOf(part: number, whole: number): number | null {
  if (whole <= 0) return null;
  return Math.round((part / whole) * 1_000) / 10;
}

/** Days in service per failure (decision 405); null before the first failure. */
export function meanDaysBetweenFailures(inService: number, failures: number): number | null {
  if (failures <= 0) return null;
  return Math.round((inService / 86_400 / failures) * 10) / 10;
}

/** Minor units per km (or mile), rounded; null without distance. */
export function costPerDistance(costMinor: number, distance: number): number | null {
  return distance > 0 ? Math.round(costMinor / distance) : null;
}

export type ComplianceLevel = "red" | "amber" | "green";

/**
 * Where a vehicle stands (docs/15 §2, decision 406): red with a document expired or a service
 * overdue, amber with a document expiring soon, a service due or a fine past its date, green
 * otherwise.
 */
export function complianceLevel(
  counts: Readonly<{
    documentsExpired: number;
    documentsExpiring: number;
    servicesOverdue: number;
    servicesDue: number;
    finesOverdue: number;
  }>,
): ComplianceLevel {
  if (counts.documentsExpired > 0 || counts.servicesOverdue > 0) return "red";
  if (counts.documentsExpiring > 0 || counts.servicesDue > 0 || counts.finesOverdue > 0)
    return "amber";
  return "green";
}
