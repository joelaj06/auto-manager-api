import type { TenantStatus } from "./ITenantDirectory.js";

export type RosterTenant = Readonly<{ id: string; status: TenantStatus; timezone: string }>;

/** Iterates over tenants for platform-wide jobs (uncached, ordered by id). */
export interface ITenantRoster {
  /** Tenants whose users may use the system, after `afterId` (exclusive), at most `limit`. */
  listUsable(afterId: string | null, limit: number): Promise<RosterTenant[]>;
}
