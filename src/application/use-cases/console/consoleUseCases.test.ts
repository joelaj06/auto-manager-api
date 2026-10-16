import { describe, expect, it } from "vitest";
import type {
  BackupOverview,
  IDataOperationsQueries,
  SchemaVersionCount,
} from "../../ports/IDataOperationsQueries.js";
import type { DatabaseProbe, ISystemProbes, QueueProbe } from "../../ports/ISystemProbes.js";
import { DataOperationsConsole } from "./DataOperationsConsole.js";
import { SystemHealthSummary } from "./SystemHealthSummary.js";

const now = new Date("2026-10-16T12:00:00Z");
const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000);
const clock = { now: () => now };

const healthyBackups: BackupOverview = {
  lastPlatform: { succeededAt: minutesAgo(60), failedAt: null },
  lastVerification: { at: minutesAgo(60 * 24), passed: true, backupId: "b" },
  failedLast24Hours: 0,
  tenantsWithoutRecentBackup: { count: 0, sample: [] },
};

function setup(
  overrides: Partial<{
    database: DatabaseProbe;
    queues: QueueProbe[];
    backups: BackupOverview;
    versions: SchemaVersionCount[];
    platformVersion: string | null;
    failQueues: boolean;
  }> = {},
) {
  const queries: IDataOperationsQueries = {
    backups: () => Promise.resolve([]),
    backupOverview: () => Promise.resolve(overrides.backups ?? healthyBackups),
    schemaVersions: () =>
      Promise.resolve(overrides.versions ?? [{ version: "0006", status: "ok", tenants: 3 }]),
    schemaFailures: () => Promise.resolve([]),
    platformSchemaVersion: () => Promise.resolve(overrides.platformVersion ?? "0008"),
  };
  const dataOperations = new DataOperationsConsole({
    queries,
    clock,
    latest: { platform: "0008", tenant: "0006" },
  });
  const probes: ISystemProbes = {
    database: () =>
      Promise.resolve(
        overrides.database ?? {
          reachable: true,
          latencyMs: 3,
          connections: 10,
          maxConnections: 100,
          platformDatabaseBytes: 1,
          tenantDatabases: 3,
          error: null,
        },
      ),
    queues: () =>
      overrides.failQueues === true
        ? Promise.reject(new Error("relation pgboss.job does not exist"))
        : Promise.resolve(overrides.queues ?? []),
    email: () => Promise.resolve({ pending: 0, failedLast24Hours: 0, oldestPendingAt: null }),
    runtime: () => ({
      version: "2.0.0",
      nodeVersion: "v24",
      uptimeSeconds: 1,
      memoryRssBytes: 1,
      startedAt: now,
    }),
  };
  return { dataOperations, health: new SystemHealthSummary({ probes, dataOperations, clock }) };
}

const check = async (health: SystemHealthSummary, name: string) =>
  (await health.summary()).checks.find((c) => c.name === name)!;

describe("SystemHealthSummary", () => {
  it("is ok when everything is within thresholds", async () => {
    const summary = await setup().health.summary();
    expect(summary.status).toBe("ok");
    expect(summary.checks.map((c) => [c.name, c.status])).toEqual([
      ["database", "ok"],
      ["jobs", "ok"],
      ["email", "ok"],
      ["backups", "ok"],
      ["migrations", "ok"],
    ]);
  });

  it("judges job waits and failures", async () => {
    const queue = (waited: number, failed = 0): QueueProbe => ({
      name: "email.send",
      ready: 1,
      deferred: 0,
      active: 0,
      failedLast24Hours: failed,
      oldestReadyAt: minutesAgo(waited),
    });
    expect((await check(setup({ queues: [queue(1)] }).health, "jobs")).status).toBe("ok");
    expect((await check(setup({ queues: [queue(6)] }).health, "jobs")).status).toBe("warning");
    expect((await check(setup({ queues: [queue(31)] }).health, "jobs")).status).toBe("critical");
    const failed = await check(setup({ queues: [queue(0, 2)] }).health, "jobs");
    expect(failed.status).toBe("warning");
    expect(failed.findings).toEqual(["email.send: 2 failed in the last 24 h"]);
  });

  it("flags an unreachable database and a failed probe as critical", async () => {
    const down = setup({
      database: {
        reachable: false,
        latencyMs: null,
        connections: null,
        maxConnections: null,
        platformDatabaseBytes: null,
        tenantDatabases: null,
        error: "ECONNREFUSED",
      },
      failQueues: true,
    });
    const summary = await down.health.summary();
    expect(summary.status).toBe("critical");
    expect(summary.checks.find((c) => c.name === "jobs")!.findings[0]).toContain("Check failed");
  });

  it("judges backups: stale platform backup, failed restore test, missing tenants", async () => {
    const stale = await check(
      setup({
        backups: {
          ...healthyBackups,
          lastPlatform: { succeededAt: minutesAgo(27 * 60), failedAt: null },
        },
      }).health,
      "backups",
    );
    expect(stale.status).toBe("critical");
    const failedTest = await check(
      setup({
        backups: {
          ...healthyBackups,
          lastVerification: { at: minutesAgo(10), passed: false, backupId: "b" },
        },
      }).health,
      "backups",
    );
    expect(failedTest.status).toBe("critical");
    const missing = await check(
      setup({
        backups: {
          ...healthyBackups,
          tenantsWithoutRecentBackup: { count: 2, sample: [] },
        },
      }).health,
      "backups",
    );
    expect(missing.status).toBe("warning");
  });

  it("judges migrations: platform behind is critical, tenants behind a warning", async () => {
    expect((await check(setup({ platformVersion: "0007" }).health, "migrations")).status).toBe(
      "critical",
    );
    const behind = await check(
      setup({
        versions: [
          { version: "0006", status: "ok", tenants: 2 },
          { version: "0005", status: "ok", tenants: 1 },
        ],
      }).health,
      "migrations",
    );
    expect(behind.status).toBe("warning");
    expect(behind.findings).toEqual(["1 tenant database(s) behind 0006"]);
  });
});

describe("DataOperationsConsole.migrations", () => {
  it("counts tenants up to date, behind, failed and never migrated", async () => {
    const { dataOperations } = setup({
      versions: [
        { version: "0006", status: "ok", tenants: 5 },
        { version: "0005", status: "ok", tenants: 2 },
        { version: "0005", status: "failed", tenants: 1 },
        { version: null, status: null, tenants: 1 },
      ],
    });
    const status = await dataOperations.migrations();
    expect(status.platform).toEqual({ current: "0008", latest: "0008", upToDate: true });
    expect(status.tenants).toMatchObject({
      latest: "0006",
      total: 9,
      upToDate: 5,
      behind: 3,
      failed: 1,
      neverMigrated: 1,
    });
  });
});
