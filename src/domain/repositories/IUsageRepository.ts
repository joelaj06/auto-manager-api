/** One tenant's day (docs/27 §4 `usage_daily`). */
export type UsageDay = Readonly<{
  tenantId: string;
  day: string;
  activeUsers: number;
  apiCalls: number;
  recordsCreated: number;
  vehicles: number;
  branches: number;
  users: number;
  storageBytes: number;
  databaseBytes: number;
}>;

/** Daily usage and the API call counters it is built from (platform database). */
export interface IUsageRepository {
  addCalls(
    counts: readonly Readonly<{ tenantId: string; day: string; calls: number }>[],
  ): Promise<void>;
  callsOn(tenantId: string, day: string): Promise<number>;
  saveDay(day: UsageDay): Promise<void>;
  days(tenantId: string, from: string, to: string): Promise<UsageDay[]>;
}
