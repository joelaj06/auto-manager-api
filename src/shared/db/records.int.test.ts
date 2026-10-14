import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDatabaseServices } from "../../testing/test-services.js";
import { connectAdmin } from "../../testing/test-database.js";
import { recordAuditEvent } from "./audit.js";
import { nextCounterValue } from "./counters.js";
import { decodeCursor, keysetQueryParts, toPage, type CursorValue } from "./keyset.js";
import { enqueueOutboxEvent } from "./outbox.js";
import type { TenantPoolManager } from "./tenant-pools.js";

const services = testDatabaseServices();
const tenantId = randomUUID();
let pools: TenantPoolManager;

beforeAll(async () => {
  await services.tenantDatabaseFactory.create(tenantId);
  pools = services.createTenantPools("0001");
});

afterAll(async () => {
  await pools.closeAll();
});

describe("nextCounterValue", () => {
  it("hands out distinct, gap-free values under concurrency", async () => {
    const values = await Promise.all(
      Array.from({ length: 25 }, () =>
        pools.withTransaction(tenantId, (tx) => nextCounterValue(tx, "rental:2026")),
      ),
    );
    expect([...values].sort((a, b) => a - b)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
  });

  it("gives the number back when the transaction rolls back", async () => {
    const first = await pools.withTransaction(tenantId, (tx) => nextCounterValue(tx, "deal"));
    await expect(
      pools.withTransaction(tenantId, async (tx) => {
        await nextCounterValue(tx, "deal");
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");
    const next = await pools.withTransaction(tenantId, (tx) => nextCounterValue(tx, "deal"));
    expect(next).toBe(first + 1);
  });

  it("keeps separate sequences per key", async () => {
    const a = await pools.withTransaction(tenantId, (tx) => nextCounterValue(tx, "key-a"));
    const b = await pools.withTransaction(tenantId, (tx) => nextCounterValue(tx, "key-b"));
    expect([a, b]).toEqual([1, 1]);
  });

  it("rejects invalid keys", async () => {
    await expect(
      pools.withTransaction(tenantId, (tx) => nextCounterValue(tx, "Bad Key")),
    ).rejects.toThrow(/Invalid counter key/);
  });
});

describe("recordAuditEvent", () => {
  it("stores the event with JSON before/after", async () => {
    const actorId = randomUUID();
    const id = await pools.withTransaction(tenantId, (tx) =>
      recordAuditEvent(tx, {
        actorType: "user",
        actorId,
        action: "vehicle.status_changed",
        entityType: "vehicle",
        entityId: "VE-000001",
        before: { status: "available" },
        after: { status: "on_rent" },
        requestId: "req-1",
        ip: "203.0.113.7",
      }),
    );

    const { rows } = await pools.withTransaction(tenantId, (tx) =>
      tx.query<{ action: string; before: unknown; after: unknown; ip: string }>(
        "select action, before, after, host(ip) as ip from audit_logs where id = $1",
        [id],
      ),
    );
    expect(rows[0]).toEqual({
      action: "vehicle.status_changed",
      before: { status: "available" },
      after: { status: "on_rent" },
      ip: "203.0.113.7",
    });
  });

  it("is append-only even for the owner role", async () => {
    const owner = await services.connectAsMigrator(services.databaseNameFor(tenantId));
    try {
      await expect(owner.query("delete from audit_logs")).rejects.toThrow(/append-only/);
    } finally {
      await owner.end();
    }
  });

  it("rejects malformed action names", async () => {
    await expect(
      pools.withTransaction(tenantId, (tx) =>
        recordAuditEvent(tx, { actorType: "system", action: "Deleted!", entityType: "x" }),
      ),
    ).rejects.toThrow(/Invalid audit action/);
  });
});

describe("enqueueOutboxEvent", () => {
  it("stores the event as pending and only when the transaction commits", async () => {
    const committed = await pools.withTransaction(tenantId, (tx) =>
      enqueueOutboxEvent(tx, {
        eventType: "rental.checked_in",
        aggregateType: "rental",
        aggregateId: "RT-000001",
        payload: { odometer: 120_345 },
      }),
    );
    await expect(
      pools.withTransaction(tenantId, async (tx) => {
        await enqueueOutboxEvent(tx, { eventType: "rental.cancelled", payload: {} });
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");

    const { rows } = await pools.withTransaction(tenantId, (tx) =>
      tx.query<{ id: string; published_at: Date | null; payload: unknown }>(
        "select id, published_at, payload from outbox order by occurred_at",
      ),
    );
    expect(rows).toEqual([{ id: committed, published_at: null, payload: { odometer: 120_345 } }]);
  });
});

describe("keyset pagination on real rows", () => {
  it("pages through every row exactly once, newest first", async () => {
    const admin = await connectAdmin(services.databaseNameFor(tenantId));
    await admin.query(
      `insert into outbox (event_type, payload, available_at)
       select 'paging.test', jsonb_build_object('n', n), timestamp '2026-01-01' + (n % 5) * interval '1 day'
       from generate_series(1, 23) as n`,
    );
    await admin.end();

    const columns = [
      { column: "available_at", direction: "desc" as const },
      { column: "id", direction: "desc" as const },
    ];
    type Row = { id: string; available_at: Date };
    const seen: string[] = [];
    let cursor: CursorValue[] | null = null;

    for (let page = 0; page < 10; page += 1) {
      const parts = keysetQueryParts(columns, cursor, 2);
      const { rows } = await pools.withTransaction(tenantId, (tx) =>
        tx.query<Row>(
          `select id, available_at from outbox
           where event_type = $1 and ${parts.where}
           order by ${parts.orderBy} limit 6`,
          ["paging.test", ...parts.params],
        ),
      );
      const result = toPage(rows, 5, (row) => [row.available_at.toISOString(), row.id]);
      seen.push(...result.items.map((row) => row.id));
      if (result.nextCursor === null) break;
      cursor = decodeCursor(result.nextCursor, 2);
    }

    expect(seen).toHaveLength(23);
    expect(new Set(seen).size).toBe(23);
  });
});

describe("withTransaction connection hygiene", () => {
  it("returns a healthy connection to the pool after a failed statement", async () => {
    await expect(
      pools.withTransaction(tenantId, (tx) => tx.query("select * from no_such_table")),
    ).rejects.toBeInstanceOf(pg.DatabaseError);
    const { rows } = await pools.withTransaction(tenantId, (tx) => tx.query("select 1 as ok"));
    expect(rows).toEqual([{ ok: 1 }]);
  });
});
