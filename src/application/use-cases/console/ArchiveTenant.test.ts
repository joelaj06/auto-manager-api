import { describe, expect, it } from "vitest";
import type { IColdArchiveVault } from "../../ports/IColdArchiveVault.js";
import type { ILogger } from "../../ports/ILogger.js";
import type { IPlatformAuditTrail } from "../../ports/IPlatformAuditTrail.js";
import type { IPlatformUnitOfWork } from "../../ports/IPlatformUnitOfWork.js";
import type {
  ArchivableTenant,
  ArchiveChanges,
  ITenantArchives,
  TenantArchive,
} from "../../ports/ITenantArchives.js";
import type { ITenantDatabaseMover } from "../../ports/ITenantDatabaseMover.js";
import { ArchiveTenant } from "./ArchiveTenant.js";

const now = new Date("2026-11-03T12:00:00Z");
const TENANT = "11111111-1111-4111-8111-111111111111";
const ARCHIVE = "33333333-3333-4333-8333-333333333333";
const silent = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as ILogger;

function setup(
  options: { failSeal?: boolean; status?: TenantArchive["status"]; tenantStatus?: string } = {},
) {
  const steps: string[] = [];
  let archive = {
    id: ARCHIVE,
    tenantId: TENANT,
    slug: "acme",
    status: options.status ?? "queued",
    reason: "Closed for good",
    approvalId: null,
    requestedBy: "staff",
    clusterId: null,
    backupId: null,
  } as unknown as TenantArchive;
  let tenant: ArchivableTenant = {
    tenantId: TENANT,
    slug: "acme",
    status: options.tenantStatus ?? "deactivated",
    statusChangedAt: new Date("2025-01-01T00:00:00Z"),
    clusterId: "main",
    hasDatabase: true,
    moving: false,
  };
  const archives = {
    find: () => Promise.resolve(archive),
    tenant: () => Promise.resolve(tenant),
    update: (_id: string, changes: ArchiveChanges) => {
      if (changes.status !== undefined) steps.push(changes.status);
      archive = { ...archive, ...changes };
      return Promise.resolve();
    },
    setDatabase: (_id: string, name: string | null) => {
      steps.push(`database:${name}`);
      tenant = { ...tenant, hasDatabase: name !== null };
      return Promise.resolve();
    },
  } as unknown as ITenantArchives;
  const mover = {
    close: (_t: string, c: string) => (steps.push(`close:${c}`), Promise.resolve()),
    open: (_t: string, c: string) => (steps.push(`open:${c}`), Promise.resolve()),
  } as unknown as ITenantDatabaseMover;
  const vault: IColdArchiveVault = {
    seal: () =>
      options.failSeal === true
        ? Promise.reject(new Error("Row counts differ on vehicles"))
        : Promise.resolve({
            backupId: "b1",
            sizeBytes: 100,
            schemaVersion: "0046",
            tables: 3,
            rows: 10,
            checks: [{ name: "row counts", passed: true }],
            files: { count: 2, bytes: 50, missing: 0, manifestLocation: "m" },
          }),
    databaseExists: () => Promise.resolve(true),
    dropDatabase: (_t, c) => (steps.push(`drop:${c}`), Promise.resolve(true)),
  };
  const audits: string[] = [];
  const alerts: string[] = [];
  const handler = new ArchiveTenant({
    unitOfWork: { run: <T>(work: () => Promise<T>) => work() } as unknown as IPlatformUnitOfWork,
    archives,
    mover,
    vault,
    lifecycle: {
      archive: () => {
        steps.push("tenant:archived");
        tenant = { ...tenant, status: "archived" };
        return Promise.resolve();
      },
      unarchive: () => Promise.resolve(),
    },
    routing: { forget: () => steps.push("forget") },
    audit: {
      record: (e: { action: string }) => (audits.push(e.action), Promise.resolve("a")),
    } as unknown as IPlatformAuditTrail,
    alerts: { raise: (a: { key: string }) => (alerts.push(a.key), Promise.resolve()) },
    clock: { now: () => now },
    logger: silent,
  });
  return { handler, steps, audits, alerts, archive: () => archive };
}

describe("ArchiveTenant", () => {
  it("closes, seals, archives the tenant and drops its live database", async () => {
    const s = setup();
    await s.handler.handle({ archiveId: ARCHIVE });
    expect(s.steps).toEqual([
      "archiving",
      "close:main",
      "tenant:archived",
      "database:null",
      "archived",
      "drop:main",
      "forget",
    ]);
    expect(s.archive()).toMatchObject({ backupId: "b1", archivedAt: now, clusterId: "main" });
    expect(s.audits).toEqual(["tenant.cold_archived"]);
  });

  it("reopens the database when the archive cannot be checked", async () => {
    const s = setup({ failSeal: true });
    await s.handler.handle({ archiveId: ARCHIVE });
    expect(s.steps).toEqual(["archiving", "close:main", "open:main", "failed"]);
    expect(s.archive().error).toBe("Row counts differ on vehicles");
    expect(s.audits).toEqual(["tenant.cold_archive_failed"]);
    expect(s.alerts).toEqual([`archive.failed:${ARCHIVE}`]);
  });

  it("finishes a worker lost after the tenant was archived", async () => {
    const s = setup({ status: "archiving", tenantStatus: "archived" });
    await s.handler.handle({ archiveId: ARCHIVE });
    expect(s.steps).not.toContain("tenant:archived");
    expect(s.steps.slice(-3)).toEqual(["archived", "drop:main", "forget"]);
  });

  it("only drops the database again once archived", async () => {
    const s = setup({ status: "archived", tenantStatus: "archived" });
    await s.handler.handle({ archiveId: ARCHIVE });
    expect(s.steps).toEqual(["drop:main", "forget"]);
  });

  it("fails without touching the database when the tenant was restored meanwhile", async () => {
    const s = setup({ tenantStatus: "active" });
    await s.handler.handle({ archiveId: ARCHIVE });
    expect(s.steps).toEqual(["failed"]);
  });
});
