import { DomainError } from "../errors/DomainError.js";

export class DemoRuleError extends DomainError {
  readonly code = "DEMO_RULE";
  constructor(message: string) {
    super(message);
  }
}

const DAY_MS = 86_400_000;

/** How long a demo lives (docs/27 §5.2): 14 days unless asked, up to 90 in one go. */
export const DEMO_DEFAULT_DAYS = 14;
export const DEMO_MAX_DAYS = 90;
/** An expired demo is kept deactivated this long (to extend it) before its database is dropped. */
export const DEMO_PURGE_AFTER_DAYS = 7;
/** At most this many demos live at once, so they never crowd out real tenants. */
export const DEMO_MAX_LIVE = 50;

export const DEMO_PURPOSES = ["sales_demo", "training"] as const;
export type DemoPurpose = (typeof DEMO_PURPOSES)[number];
export type SampleDataStatus = "pending" | "seeding" | "seeded" | "failed" | "none";

export function demoDays(days: number | undefined): number {
  const value = days ?? DEMO_DEFAULT_DAYS;
  if (!Number.isInteger(value) || value < 1 || value > DEMO_MAX_DAYS)
    throw new DemoRuleError(`A demo lasts 1 to ${DEMO_MAX_DAYS} days`);
  return value;
}

/** Where a demo is: live, expired (deactivated, can be extended) or purged (its data gone). */
export function demoState(
  demo: Readonly<{ expiresAt: Date; expiredAt: Date | null; purgedAt: Date | null }>,
  now: Date,
): "live" | "expiring" | "expired" | "purge_due" | "purged" {
  if (demo.purgedAt !== null) return "purged";
  if (demo.expiredAt !== null)
    return now.getTime() - demo.expiredAt.getTime() >= DEMO_PURGE_AFTER_DAYS * DAY_MS
      ? "purge_due"
      : "expired";
  return now >= demo.expiresAt ? "expiring" : "live";
}

/** A demo gets more days from today (or its current end, if later); never once purged. */
export function extendDemo(
  demo: Readonly<{ expiresAt: Date; purgedAt: Date | null }>,
  days: number,
  now: Date,
): Date {
  if (demo.purgedAt !== null)
    throw new DemoRuleError("This demo's data is gone; create a new demo");
  const from = Math.max(now.getTime(), demo.expiresAt.getTime());
  const until = new Date(from + demoDays(days) * DAY_MS);
  if (until.getTime() - now.getTime() > DEMO_MAX_DAYS * DAY_MS)
    throw new DemoRuleError(`A demo runs at most ${DEMO_MAX_DAYS} days ahead`);
  return until;
}

/** A free slug for a demo: `demo-` and six letters or digits. */
export function demoSlug(random: string): string {
  const tail = random
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 6);
  if (tail.length < 6) throw new Error("Not enough random characters for a demo slug");
  return `demo-${tail}`;
}
