import { describe, expect, it } from "vitest";
import type { ClusterMove, IClusterRegistry, MoveChanges } from "../../ports/IClusterRegistry.js";
import type { ILogger } from "../../ports/ILogger.js";
import type { IPlatformAuditTrail } from "../../ports/IPlatformAuditTrail.js";
import type { ITenantDatabaseMover } from "../../ports/ITenantDatabaseMover.js";
import type { ITenantDirectory } from "../../ports/ITenantDirectory.js";
import { MoveTenantToCluster } from "./MoveTenantToCluster.js";

const now = new Date("2026-11-02T12:00:00Z");
const TENANT = "11111111-1111-4111-8111-111111111111";
const MOVE = "22222222-2222-4222-8222-222222222222";
const silent = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as ILogger;

function setup(options: { failCopy?: boolean; clusterId?: string } = {}) {
  const steps: string[] = [];
  let move: ClusterMove = {
    id: MOVE,
    tenantId: TENANT,
    slug: "acme",
    from: "main",
    to: "c2",
    status: "queued",
    reason: "Rebalancing",
    report: {},
    error: null,
    approvalId: null,
    requestedBy: "staff",
    requestedAt: now,
    startedAt: null,
    finishedAt: null,
    sourceRetainedUntil: null,
  };
  let clusterId = options.clusterId ?? "main";
  const registry = {
    findMove: () => Promise.resolve(move),
    placement: () =>
      Promise.resolve({
        tenantId: TENANT,
        slug: "acme",
        status: "active",
        clusterId,
        hasDatabase: true,
        moving: false,
      }),
    updateMove: (_id: string, changes: MoveChanges) => {
      if (changes.status !== undefined) steps.push(changes.status);
      move = { ...move, ...changes, report: changes.report ?? move.report };
      return Promise.resolve();
    },
    setMoving: (_id: string, since: Date | null) => {
      steps.push(since === null ? "back" : "offline");
      return Promise.resolve();
    },
    switchTenant: (_id: string, to: string) => {
      steps.push(`switch:${to}`);
      clusterId = to;
      return Promise.resolve();
    },
  } as unknown as IClusterRegistry;
  const mover: ITenantDatabaseMover = {
    close: (_t, c) => (steps.push(`close:${c}`), Promise.resolve()),
    open: (_t, c) => (steps.push(`open:${c}`), Promise.resolve()),
    discard: (_t, c) => (steps.push(`discard:${c}`), Promise.resolve()),
    copy: () =>
      options.failCopy === true
        ? Promise.reject(new Error("Row counts differ on vehicles"))
        : Promise.resolve({ tables: 3, rows: 10, schemaVersion: "0046", sizeBytes: 1, checks: [] }),
  };
  const audits: string[] = [];
  const alerts: string[] = [];
  const handler = new MoveTenantToCluster({
    registry,
    mover,
    directory: { invalidate: () => undefined } as unknown as ITenantDirectory,
    routing: { forget: () => undefined },
    audit: {
      record: (e: { action: string }) => (audits.push(e.action), Promise.resolve()),
    } as unknown as IPlatformAuditTrail,
    alerts: {
      raise: (a: { key: string }) => (alerts.push(a.key), Promise.resolve()),
    },
    clock: { now: () => now },
    logger: silent,
    settleMs: 0,
    wait: () => Promise.resolve(),
  });
  return { handler, steps, audits, alerts, current: () => move };
}

describe("moving a tenant to another cluster", () => {
  it("takes the tenant offline, copies, switches and brings it back", async () => {
    const { handler, steps, audits, current } = setup();
    await handler.handle({ moveId: MOVE });
    expect(steps).toEqual([
      "blocking",
      "offline",
      "close:main",
      "copying",
      "open:c2",
      "switching",
      "switch:c2",
      "back",
      "completed",
    ]);
    expect(current()).toMatchObject({ status: "completed", sourceRetainedUntil: "2026-11-16" });
    expect(current().report).toMatchObject({ rows: 10, offlineSeconds: 0 });
    expect(audits).toEqual(["tenant.cluster_moved"]);
  });

  it("undoes a failed copy and leaves the tenant where it was", async () => {
    const { handler, steps, audits, alerts, current } = setup({ failCopy: true });
    await handler.handle({ moveId: MOVE });
    expect(steps).toEqual([
      "blocking",
      "offline",
      "close:main",
      "copying",
      "open:main",
      "discard:c2",
      "back",
      "failed",
    ]);
    expect(current()).toMatchObject({ status: "failed", error: "Row counts differ on vehicles" });
    expect(audits).toEqual(["tenant.cluster_move_failed"]);
    expect(alerts).toEqual([`cluster.move_failed:${MOVE}`]);
  });

  it("finishes a move whose switch was made before the worker was lost", async () => {
    const { handler, steps } = setup({ clusterId: "c2" });
    await handler.handle({ moveId: MOVE });
    expect(steps).toEqual(["back", "completed"]);
  });
});
