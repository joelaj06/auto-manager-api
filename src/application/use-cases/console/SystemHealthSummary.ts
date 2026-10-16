import type { IClock } from "../../ports/IClock.js";
import type { BackupOverview } from "../../ports/IDataOperationsQueries.js";
import type { ISystemProbes, RuntimeProbe } from "../../ports/ISystemProbes.js";
import type { DataOperationsConsole, MigrationStatus } from "./DataOperationsConsole.js";

export type HealthLevel = "ok" | "warning" | "critical";

export type HealthCheck = Readonly<{
  name: "database" | "jobs" | "email" | "backups" | "migrations";
  status: HealthLevel;
  /** Plain-language findings; empty when everything is fine. */
  findings: readonly string[];
  metrics: Readonly<Record<string, unknown>>;
}>;

export type HealthSummary = Readonly<{
  status: HealthLevel;
  checkedAt: Date;
  runtime: RuntimeProbe;
  checks: readonly HealthCheck[];
}>;

/** Thresholds for the health summary. */
export const HEALTH_THRESHOLDS = Object.freeze({
  databaseLatencyWarningMs: 200,
  connectionsWarningRatio: 0.8,
  jobWaitWarningMinutes: 5,
  jobWaitCriticalMinutes: 30,
  emailWaitWarningMinutes: 15,
  platformBackupCriticalHours: 26,
  verificationWarningDays: 8,
});

const worst = (levels: readonly HealthLevel[]): HealthLevel =>
  levels.includes("critical") ? "critical" : levels.includes("warning") ? "warning" : "ok";

const minutesSince = (date: Date | null, now: Date) =>
  date === null ? 0 : (now.getTime() - date.getTime()) / 60_000;

/**
 * System health summary for the console (docs/27 §3.1): database, background jobs, email,
 * backups and migrations, each judged against fixed thresholds. A failing probe is reported as
 * critical rather than failing the whole summary.
 */
export class SystemHealthSummary {
  constructor(
    private readonly deps: Readonly<{
      probes: ISystemProbes;
      dataOperations: DataOperationsConsole;
      clock: IClock;
    }>,
  ) {}

  async summary(): Promise<HealthSummary> {
    const now = this.deps.clock.now();
    const checks = await Promise.all([
      this.guard("database", () => this.database()),
      this.guard("jobs", () => this.jobs(now)),
      this.guard("email", () => this.email(now)),
      this.guard("backups", async () =>
        this.backups(await this.deps.dataOperations.backupOverview(), now),
      ),
      this.guard("migrations", async () =>
        this.migrations(await this.deps.dataOperations.migrations()),
      ),
    ]);
    return {
      status: worst(checks.map((c) => c.status)),
      checkedAt: now,
      runtime: this.deps.probes.runtime(),
      checks,
    };
  }

  private async database(): Promise<HealthCheck> {
    const db = await this.deps.probes.database();
    const t = HEALTH_THRESHOLDS;
    const findings: string[] = [];
    let status: HealthLevel = "ok";
    if (!db.reachable) {
      findings.push(`The platform database cannot be reached: ${db.error ?? "unknown error"}`);
      status = "critical";
    } else {
      if (db.latencyMs !== null && db.latencyMs > t.databaseLatencyWarningMs) {
        findings.push(`Database round trip took ${db.latencyMs} ms`);
        status = "warning";
      }
      if (
        db.connections !== null &&
        db.maxConnections !== null &&
        db.connections >= db.maxConnections * t.connectionsWarningRatio
      ) {
        findings.push(`${db.connections} of ${db.maxConnections} database connections in use`);
        status = "warning";
      }
    }
    return { name: "database", status, findings, metrics: db };
  }

  private async jobs(now: Date): Promise<HealthCheck> {
    const queues = await this.deps.probes.queues(now);
    const t = HEALTH_THRESHOLDS;
    const findings: string[] = [];
    const levels: HealthLevel[] = [];
    for (const queue of queues) {
      const waited = minutesSince(queue.oldestReadyAt, now);
      if (waited >= t.jobWaitCriticalMinutes) levels.push("critical");
      else if (waited >= t.jobWaitWarningMinutes) levels.push("warning");
      if (waited >= t.jobWaitWarningMinutes)
        findings.push(`${queue.name}: oldest job has waited ${Math.round(waited)} min`);
      if (queue.failedLast24Hours > 0) {
        levels.push("warning");
        findings.push(`${queue.name}: ${queue.failedLast24Hours} failed in the last 24 h`);
      }
    }
    return {
      name: "jobs",
      status: worst(levels),
      findings,
      metrics: {
        ready: queues.reduce((n, q) => n + q.ready, 0),
        active: queues.reduce((n, q) => n + q.active, 0),
        failedLast24Hours: queues.reduce((n, q) => n + q.failedLast24Hours, 0),
        queues,
      },
    };
  }

  private async email(now: Date): Promise<HealthCheck> {
    const email = await this.deps.probes.email(now);
    const findings: string[] = [];
    const levels: HealthLevel[] = [];
    const waited = minutesSince(email.oldestPendingAt, now);
    if (waited >= HEALTH_THRESHOLDS.emailWaitWarningMinutes) {
      levels.push("warning");
      findings.push(`Oldest unsent email has waited ${Math.round(waited)} min`);
    }
    if (email.failedLast24Hours > 0) {
      levels.push("warning");
      findings.push(`${email.failedLast24Hours} emails failed in the last 24 h`);
    }
    return { name: "email", status: worst(levels), findings, metrics: email };
  }

  private backups(overview: BackupOverview, now: Date): HealthCheck {
    const t = HEALTH_THRESHOLDS;
    const findings: string[] = [];
    const levels: HealthLevel[] = [];
    const platformAge = overview.lastPlatform.succeededAt;
    if (
      platformAge === null ||
      minutesSince(platformAge, now) > t.platformBackupCriticalHours * 60
    ) {
      levels.push("critical");
      findings.push(
        platformAge === null
          ? "The platform database has never been backed up"
          : `No platform backup for more than ${t.platformBackupCriticalHours} h`,
      );
    }
    const missing = overview.tenantsWithoutRecentBackup.count;
    if (missing > 0) {
      levels.push("warning");
      findings.push(`${missing} tenant(s) without a recent successful backup`);
    }
    if (overview.failedLast24Hours > 0) {
      levels.push("warning");
      findings.push(`${overview.failedLast24Hours} backup(s) failed in the last 24 h`);
    }
    const verification = overview.lastVerification;
    if (verification === null) {
      levels.push("warning");
      findings.push("No backup has been restore-tested yet");
    } else if (!verification.passed) {
      levels.push("critical");
      findings.push("The latest restore test failed");
    } else if (minutesSince(verification.at, now) > t.verificationWarningDays * 24 * 60) {
      levels.push("warning");
      findings.push(`No restore test for more than ${t.verificationWarningDays} days`);
    }
    return { name: "backups", status: worst(levels), findings, metrics: overview };
  }

  private migrations(status: MigrationStatus): HealthCheck {
    const findings: string[] = [];
    const levels: HealthLevel[] = [];
    if (!status.platform.upToDate) {
      levels.push("critical");
      findings.push(
        `Platform database is at ${status.platform.current ?? "(none)"}, this build expects ${status.platform.latest ?? "(none)"}`,
      );
    }
    if (status.tenants.failed > 0) {
      levels.push("critical");
      findings.push(`${status.tenants.failed} tenant database(s) failed to migrate`);
    }
    if (status.tenants.behind > 0) {
      levels.push("warning");
      findings.push(`${status.tenants.behind} tenant database(s) behind ${status.tenants.latest}`);
    }
    if (status.tenants.neverMigrated > 0) {
      levels.push("warning");
      findings.push(
        `${status.tenants.neverMigrated} tenant database(s) with unknown schema version`,
      );
    }
    const { failures: _failures, byVersion: _byVersion, ...tenants } = status.tenants;
    return {
      name: "migrations",
      status: worst(levels),
      findings,
      metrics: { platform: status.platform, tenants },
    };
  }

  private async guard(
    name: HealthCheck["name"],
    check: () => Promise<HealthCheck> | HealthCheck,
  ): Promise<HealthCheck> {
    try {
      return await check();
    } catch (error) {
      return {
        name,
        status: "critical",
        findings: [`Check failed: ${error instanceof Error ? error.message : String(error)}`],
        metrics: {},
      };
    }
  }
}
