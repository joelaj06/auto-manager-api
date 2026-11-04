import { describe, expect, it } from "vitest";
import {
  checkDedication,
  checkMove,
  checkNewCluster,
  checkStatusChange,
  ClusterRuleError,
  droppable,
  fillPercent,
  pickCluster,
  type ClusterLoad,
} from "./Clusters.js";

const load = (id: string, tenants: number, maxTenants = 100, status = "active"): ClusterLoad => ({
  id,
  tenants,
  maxTenants,
  status: status as ClusterLoad["status"],
});
const DAY = 86_400_000;

describe("clusters", () => {
  it("places a new tenant on the least full active cluster with room", () => {
    expect(pickCluster([load("main", 50), load("c2", 10, 20), load("c3", 20, 100)])).toBe("c3");
    expect(pickCluster([load("main", 50), load("c2", 50)])).toBe("c2");
    expect(pickCluster([load("main", 100), load("c2", 0, 100, "draining")])).toBeNull();
    expect(fillPercent(load("c2", 1, 3))).toBe(33.3);
  });

  it("keeps a dedicated cluster for its tenant", () => {
    const kept = { id: "acme", status: "active" as const, maxTenants: 10, tenants: 0 };
    const open = { id: "main", status: "active" as const, maxTenants: 10, tenants: 9 };
    const loads = [{ ...kept, dedicatedTo: "tenant-a" }, open];
    expect(pickCluster(loads)).toBe("main");
    expect(pickCluster(loads, "tenant-b")).toBe("main");
    expect(pickCluster(loads, "tenant-a")).toBe("acme");
    expect(pickCluster([{ ...kept, dedicatedTo: "tenant-a" }])).toBeNull();
    const tenant = { clusterId: "main", hasDatabase: true, status: "active", moving: false };
    expect(() => checkMove({ ...tenant, tenantId: "tenant-b" }, loads[0]!, false)).toThrow(
      ClusterRuleError,
    );
    expect(() => checkMove({ ...tenant, tenantId: "tenant-a" }, loads[0]!, false)).not.toThrow();
  });

  it("dedicates only a cluster nobody else is on", () => {
    const c2 = { id: "c2", status: "active" as const };
    expect(() => checkDedication(c2, 0)).not.toThrow();
    expect(() => checkDedication(c2, 1)).toThrow(ClusterRuleError);
    expect(() => checkDedication({ ...c2, id: "main" }, 0)).toThrow(ClusterRuleError);
    expect(() => checkDedication({ ...c2, status: "retired" }, 0)).toThrow(ClusterRuleError);
  });

  it("checks a new cluster", () => {
    const base = { id: "c2", name: " Second ", host: "db2.internal", port: 5432, maxTenants: 500 };
    expect(checkNewCluster({ ...base, notes: "  " })).toMatchObject({
      name: "Second",
      notes: null,
    });
    for (const bad of [
      { id: "main" },
      { id: "C2" },
      { name: " " },
      { host: "db2; drop" },
      { maxTenants: 0 },
    ])
      expect(() => checkNewCluster({ ...base, notes: null, ...bad })).toThrow(ClusterRuleError);
  });

  it("retires only an empty cluster that is not the main one", () => {
    expect(() => checkStatusChange(load("main", 0), "retired")).toThrow(/main cluster/);
    expect(() => checkStatusChange(load("c2", 3), "retired")).toThrow(/3 tenants/);
    expect(() => checkStatusChange(load("c2", 0), "retired")).not.toThrow();
    expect(() => checkStatusChange(load("main", 5), "draining")).not.toThrow();
  });

  it("moves a tenant with a database to another cluster with room", () => {
    const tenant = { clusterId: "main", hasDatabase: true, status: "active", moving: false };
    expect(() => checkMove(tenant, load("c2", 0), false)).not.toThrow();
    expect(() => checkMove({ ...tenant, hasDatabase: false }, load("c2", 0), false)).toThrow();
    expect(() => checkMove({ ...tenant, status: "archived" }, load("c2", 0), false)).toThrow();
    expect(() => checkMove(tenant, load("c2", 0), true)).toThrow(/already being moved/);
    expect(() => checkMove(tenant, null, false)).toThrow(/Unknown/);
    expect(() => checkMove(tenant, load("main", 0), false)).toThrow(/already on main/);
    expect(() => checkMove(tenant, load("c2", 5, 5), false)).toThrow(/full/);
    expect(() => checkMove(tenant, load("c2", 0, 5, "draining"), false)).toThrow(/draining/);
  });

  it("lets a found database be dropped only once it has waited long enough", () => {
    const now = new Date("2026-11-20T10:00:00Z");
    const seen = (days: number) => new Date(now.getTime() - days * DAY);
    expect(droppable({ kind: "no_tenant", firstSeenAt: seen(13), retainedUntil: null }, now)).toBe(
      false,
    );
    expect(droppable({ kind: "stray_copy", firstSeenAt: seen(14), retainedUntil: null }, now)).toBe(
      true,
    );
    expect(
      droppable({ kind: "moved_away", firstSeenAt: seen(30), retainedUntil: "2026-11-20" }, now),
    ).toBe(false);
    expect(
      droppable({ kind: "moved_away", firstSeenAt: seen(1), retainedUntil: "2026-11-19" }, now),
    ).toBe(true);
    expect(droppable({ kind: "moved_away", firstSeenAt: seen(30), retainedUntil: null }, now)).toBe(
      false,
    );
    expect(droppable({ kind: "missing", firstSeenAt: seen(90), retainedUntil: null }, now)).toBe(
      false,
    );
  });
});
