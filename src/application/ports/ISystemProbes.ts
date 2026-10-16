export type DatabaseProbe = Readonly<{
  reachable: boolean;
  latencyMs: number | null;
  connections: number | null;
  maxConnections: number | null;
  platformDatabaseBytes: number | null;
  tenantDatabases: number | null;
  error: string | null;
}>;

export type QueueProbe = Readonly<{
  name: string;
  ready: number;
  deferred: number;
  active: number;
  failedLast24Hours: number;
  oldestReadyAt: Date | null;
}>;

export type EmailProbe = Readonly<{
  pending: number;
  failedLast24Hours: number;
  oldestPendingAt: Date | null;
}>;

export type RuntimeProbe = Readonly<{
  version: string;
  nodeVersion: string;
  uptimeSeconds: number;
  memoryRssBytes: number;
  startedAt: Date;
}>;

/** Raw measurements for the system health summary; judging them is the use case's job. */
export interface ISystemProbes {
  database(): Promise<DatabaseProbe>;
  queues(now: Date): Promise<QueueProbe[]>;
  email(now: Date): Promise<EmailProbe>;
  runtime(): RuntimeProbe;
}
