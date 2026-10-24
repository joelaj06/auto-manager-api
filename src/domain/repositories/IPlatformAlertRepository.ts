export type AlertSeverity = "info" | "warning" | "critical";
export type AlertStatus = "open" | "acknowledged" | "resolved";

/** Something on-call should know about (docs/27 §3.1). The key deduplicates while open. */
export type AlertInput = Readonly<{
  key: string;
  severity: AlertSeverity;
  source: string;
  title: string;
  detail?: Readonly<Record<string, unknown>>;
  tenantId?: string | null;
  runbook?: string | null;
}>;

export type PlatformAlert = Readonly<{
  id: string;
  key: string;
  severity: AlertSeverity;
  source: string;
  title: string;
  detail: Readonly<Record<string, unknown>>;
  tenantId: string | null;
  runbook: string | null;
  status: AlertStatus;
  occurrences: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
  acknowledgedBy: string | null;
  acknowledgedAt: Date | null;
  resolvedBy: string | null;
  resolvedAt: Date | null;
  notifiedAt: Date | null;
}>;

/** The alerts centre (platform database). */
export interface IPlatformAlertRepository {
  /**
   * Opens the alert, or — while one with the same key is not resolved — counts it again and
   * raises its severity if higher. `escalated`: new, or more severe than before.
   */
  raise(
    input: AlertInput,
    now: Date,
  ): Promise<Readonly<{ alert: PlatformAlert; escalated: boolean }>>;
  find(id: string, lock?: boolean): Promise<PlatformAlert | null>;
  list(
    filter: Readonly<{
      status?: AlertStatus;
      severity?: AlertSeverity;
      source?: string;
      limit: number;
    }>,
  ): Promise<PlatformAlert[]>;
  acknowledge(id: string, staffId: string, now: Date): Promise<void>;
  resolve(id: string, staffId: string | null, now: Date): Promise<void>;
  markNotified(id: string, now: Date): Promise<void>;
  /** Open alerts by severity (dashboard). */
  openCounts(): Promise<Readonly<Record<AlertSeverity, number>>>;
}
