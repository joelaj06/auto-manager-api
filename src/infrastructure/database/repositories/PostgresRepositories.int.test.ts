import { randomUUID } from "node:crypto";
import type { Container } from "inversify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MissingTenantContextError,
  NoActiveTransactionError,
} from "../../../application/errors/TenantDatabaseErrors.js";
import type { IAuditTrail } from "../../../application/ports/IAuditTrail.js";
import type { IOutbox } from "../../../application/ports/IOutbox.js";
import type { ISequenceGenerator } from "../../../application/ports/ISequenceGenerator.js";
import type { ITenantContext } from "../../../application/ports/ITenantContext.js";
import type { ITenantDatabaseProvisioner } from "../../../application/ports/ITenantDatabaseProvisioner.js";
import type { IUnitOfWork } from "../../../application/ports/IUnitOfWork.js";
import { PageCursor, type CursorValue } from "../../../application/services/PageCursor.js";
import { TenantId } from "../../../domain/value-objects/TenantId.js";
import { disposeContainer } from "../../../framework/dependency-injection/container.js";
import { TYPES } from "../../../framework/dependency-injection/types.js";
import { createTestContainer } from "../../../testing/testContainer.js";
import { connectAdmin } from "../../../testing/testDatabase.js";
import { KeysetQuery } from "../postgres/KeysetQuery.js";
import type { PostgresTransactionContext } from "../postgres/PostgresTransactionContext.js";
import type { TenantDatabaseNaming } from "../postgres/TenantDatabaseNaming.js";

const tenantId = TenantId.from(randomUUID());
let container: Container;
let tenantContext: ITenantContext;
let unitOfWork: IUnitOfWork;
let sequences: ISequenceGenerator;
let auditTrail: IAuditTrail;
let outbox: IOutbox;
let transactions: PostgresTransactionContext;

/** Runs `work` as the test tenant, inside one unit of work. */
const inTenant = <T>(work: () => Promise<T>) =>
  tenantContext.runAs(tenantId, () => unitOfWork.run(work));

beforeAll(async () => {
  container = await createTestContainer();
  await container
    .get<ITenantDatabaseProvisioner>(TYPES.TenantDatabaseProvisioner)
    .provision(tenantId);
  tenantContext = container.get<ITenantContext>(TYPES.TenantContext);
  unitOfWork = container.get<IUnitOfWork>(TYPES.UnitOfWork);
  sequences = container.get<ISequenceGenerator>(TYPES.SequenceGenerator);
  auditTrail = container.get<IAuditTrail>(TYPES.AuditTrail);
  outbox = container.get<IOutbox>(TYPES.Outbox);
  transactions = container.get<PostgresTransactionContext>(TYPES.PostgresTransactionContext);
});

afterAll(async () => {
  await disposeContainer(container);
});

describe("PostgresTenantUnitOfWork", () => {
  it("requires a tenant context", async () => {
    await expect(unitOfWork.run(() => Promise.resolve(1))).rejects.toBeInstanceOf(
      MissingTenantContextError,
    );
  });

  it("refuses repository use outside a unit of work", async () => {
    await expect(tenantContext.runAs(tenantId, () => sequences.next("x"))).rejects.toBeInstanceOf(
      NoActiveTransactionError,
    );
  });

  it("joins an outer unit of work instead of opening a second transaction", async () => {
    await expect(
      inTenant(async () => {
        await sequences.next("nested");
        await unitOfWork.run(() => sequences.next("nested"));
        throw new Error("abort everything");
      }),
    ).rejects.toThrow("abort everything");

    // Both increments rolled back together.
    expect(await inTenant(() => sequences.next("nested"))).toBe(1);
  });
});

describe("PostgresSequenceGenerator", () => {
  it("hands out distinct, gap-free values under concurrency", async () => {
    const values = await Promise.all(
      Array.from({ length: 25 }, () => inTenant(() => sequences.next("rental:2026"))),
    );
    expect([...values].sort((a, b) => a - b)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
  });

  it("gives the number back when the unit of work rolls back", async () => {
    const first = await inTenant(() => sequences.next("deal"));
    await expect(
      inTenant(async () => {
        await sequences.next("deal");
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");
    expect(await inTenant(() => sequences.next("deal"))).toBe(first + 1);
  });

  it("keeps separate sequences per key and rejects invalid keys", async () => {
    expect(await inTenant(() => sequences.next("key-a"))).toBe(1);
    expect(await inTenant(() => sequences.next("key-b"))).toBe(1);
    await expect(inTenant(() => sequences.next("Bad Key"))).rejects.toThrow(/Invalid counter key/);
  });
});

describe("PostgresAuditTrail", () => {
  it("stores the entry with JSON before/after", async () => {
    const id = await inTenant(() =>
      auditTrail.record({
        actorType: "user",
        actorId: randomUUID(),
        action: "vehicle.status_changed",
        entityType: "vehicle",
        entityId: "VE-000001",
        before: { status: "available" },
        after: { status: "on_rent" },
        requestId: "req-1",
        ip: "203.0.113.7",
      }),
    );

    const { rows } = await inTenant(() =>
      transactions
        .current()
        .query<{ action: string; before: unknown; after: unknown; ip: string }>(
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
    const naming = container.get<TenantDatabaseNaming>(TYPES.TenantDatabaseNaming);
    const owner = await connectAdmin(naming.databaseNameFor(tenantId));
    try {
      await expect(owner.query("delete from audit_logs")).rejects.toThrow(/append-only/);
    } finally {
      await owner.end();
    }
  });

  it("rejects malformed action names", async () => {
    await expect(
      inTenant(() =>
        auditTrail.record({ actorType: "system", action: "Deleted!", entityType: "x" }),
      ),
    ).rejects.toThrow(/Invalid audit action/);
  });
});

describe("PostgresOutbox", () => {
  it("stores the event as pending and only when the unit of work commits", async () => {
    const committed = await inTenant(() =>
      outbox.enqueue({
        eventType: "rental.checked_in",
        aggregateType: "rental",
        aggregateId: "RT-000001",
        payload: { odometer: 120_345 },
      }),
    );
    await expect(
      inTenant(async () => {
        await outbox.enqueue({ eventType: "rental.cancelled", payload: {} });
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");

    const { rows } = await inTenant(() =>
      transactions
        .current()
        .query<{ id: string; published_at: Date | null; payload: unknown }>(
          "select id, published_at, payload from outbox where event_type like 'rental.%'",
        ),
    );
    expect(rows).toEqual([{ id: committed, published_at: null, payload: { odometer: 120_345 } }]);
  });
});

describe("keyset pagination on real rows", () => {
  it("pages through every row exactly once, newest first", async () => {
    const naming = container.get<TenantDatabaseNaming>(TYPES.TenantDatabaseNaming);
    const admin = await connectAdmin(naming.databaseNameFor(tenantId));
    await admin.query(
      `insert into outbox (event_type, payload, available_at)
       select 'paging.test', jsonb_build_object('n', n), timestamp '2026-01-01' + (n % 5) * interval '1 day'
       from generate_series(1, 23) as n`,
    );
    await admin.end();

    const query = new KeysetQuery([
      { column: "available_at", direction: "desc" },
      { column: "id", direction: "desc" },
    ]);
    type Row = { id: string; available_at: Date };
    const seen: string[] = [];
    let cursor: readonly CursorValue[] | null = null;

    for (let page = 0; page < 10; page += 1) {
      const parts = query.build(cursor, 2);
      const { rows } = await inTenant(() =>
        transactions.current().query<Row>(
          `select id, available_at from outbox
           where event_type = $1 and ${parts.where}
           order by ${parts.orderBy} limit 6`,
          ["paging.test", ...parts.params],
        ),
      );
      const result = PageCursor.paginate(rows, 5, (row) => [
        row.available_at.toISOString(),
        row.id,
      ]);
      seen.push(...result.items.map((row) => row.id));
      if (result.nextCursor === null) break;
      cursor = PageCursor.parse(result.nextCursor, query.size).values;
    }

    expect(seen).toHaveLength(23);
    expect(new Set(seen).size).toBe(23);
  });
});
