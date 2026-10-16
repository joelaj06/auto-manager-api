import { randomUUID } from "node:crypto";
import type { Container } from "inversify";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DeliveredEvent, IEventHandler } from "../../application/events/IEventHandler.js";
import type { IJobHandler } from "../../application/jobs/IJobHandler.js";
import type { NotificationService } from "../../application/notifications/NotificationService.js";
import type { ILogger } from "../../application/ports/ILogger.js";
import type { IOutbox } from "../../application/ports/IOutbox.js";
import type { IRequestContext } from "../../application/ports/IRequestContext.js";
import type { ISequenceGenerator } from "../../application/ports/ISequenceGenerator.js";
import type { ITenantContext } from "../../application/ports/ITenantContext.js";
import type { ITenantDirectory } from "../../application/ports/ITenantDirectory.js";
import type { ITenantScheduleLedger } from "../../application/ports/ITenantScheduleLedger.js";
import type { IUnitOfWork } from "../../application/ports/IUnitOfWork.js";
import type { TenantId } from "../../domain/value-objects/TenantId.js";
import type { PgBossJobQueue } from "../../infrastructure/jobs/PgBossJobQueue.js";
import { MigrationSets } from "../../infrastructure/database/migrations/MigrationCatalog.js";
import type { PostgresConnectionFactory } from "../../infrastructure/database/postgres/PostgresConnectionFactory.js";
import type { PostgresTransactionContext } from "../../infrastructure/database/postgres/PostgresTransactionContext.js";
import { TenantFixtures } from "../../testing/fixtures/TenantFixtures.js";
import { testConfig } from "../../testing/testDatabase.js";
import { createContainer, disposeContainer } from "../dependency-injection/container.js";
import { TYPES } from "../dependency-injection/types.js";
import { JobWorker } from "./JobWorker.js";

const MAILPIT = process.env.MAILPIT_URL ?? "http://localhost:8025";
let tenantId: TenantId;
let closedTenantId: TenantId;

/** Records every delivery; counts runs inside the tenant transaction with a counter. */
const deliveries: DeliveredEvent[] = [];
let sequences: ISequenceGenerator;
const testHandler: IEventHandler = {
  name: "test.record_delivery",
  eventTypes: ["test.happened"],
  async handle(event) {
    deliveries.push(event);
    await sequences.next(`test:${event.id}`);
  },
};

let container: Container;
let platform: pg.Pool;

async function eventually<T>(probe: () => Promise<T | undefined>, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting for the worker");
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

beforeAll(async () => {
  const config = testConfig({ LOG_LEVEL: "silent" });
  container = createContainer(config, await MigrationSets.load(config.database.migrationsDir), {
    jobQueueMode: "worker",
  });
  container.rebind<IEventHandler[]>(TYPES.EventHandlers).toConstantValue([testHandler]);
  sequences = container.get<ISequenceGenerator>(TYPES.SequenceGenerator);
  platform = container.get<pg.Pool>(TYPES.PlatformDatabasePool);

  const fixtures = new TenantFixtures(container);
  tenantId = (await fixtures.create()).id;
  closedTenantId = (await fixtures.create({ status: "deactivated" })).id;

  // A fast-polling worker with the container's handlers.
  await new JobWorker({
    queue: container.get<PgBossJobQueue>(TYPES.JobQueue),
    handlers: container.get<IJobHandler[]>(TYPES.JobHandlers),
    tenantContext: container.get<ITenantContext>(TYPES.TenantContext),
    tenants: container.get<ITenantDirectory>(TYPES.TenantDirectory),
    requestContext: container.get<IRequestContext>(TYPES.RequestContext),
    logger: container.get<ILogger>(TYPES.Logger),
    concurrency: 2,
    pollingIntervalSeconds: 0.5,
  }).start();
}, 60_000);

afterAll(async () => {
  await disposeContainer(container);
});

const writeEvent = (tenant: TenantId) =>
  container.get<ITenantContext>(TYPES.TenantContext).runAs(tenant, () =>
    container.get<IUnitOfWork>(TYPES.UnitOfWork).run(() =>
      container.get<IOutbox>(TYPES.Outbox).enqueue({
        eventType: "test.happened",
        aggregateType: "test",
        aggregateId: "a1",
        payload: { n: 1 },
      }),
    ),
  );

describe("outbox → worker → event handler", () => {
  it("delivers a committed event to its handler exactly once, in the tenant's transaction", async () => {
    const eventId = await writeEvent(tenantId);

    const delivered = await eventually(async () =>
      Promise.resolve(deliveries.find((d) => d.id === eventId)),
    );
    expect(delivered).toMatchObject({
      tenantId: tenantId.value,
      eventType: "test.happened",
      payload: { n: 1 },
    });

    const tenantContext = container.get<ITenantContext>(TYPES.TenantContext);
    const uow = container.get<IUnitOfWork>(TYPES.UnitOfWork);
    // The handler's counter committed together with the processed-message key.
    const next = await tenantContext.runAs(tenantId, () =>
      uow.run(() => sequences.next(`test:${eventId}`)),
    );
    expect(next).toBe(2);

    const tx = container.get<PostgresTransactionContext>(TYPES.PostgresTransactionContext);
    const published = await eventually(async () => {
      const { rows } = await tenantContext.runAs(tenantId, () =>
        uow.run(() =>
          tx
            .current()
            .query<{ published_at: Date | null }>("select published_at from outbox where id = $1", [
              eventId,
            ]),
        ),
      );
      return rows[0]?.published_at ?? undefined;
    });
    expect(published).toBeInstanceOf(Date);
  });

  it("does not run jobs of deactivated tenants", async () => {
    const eventId = await writeEvent(closedTenantId);
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(deliveries.some((d) => d.id === eventId)).toBe(false);
  });
});

describe("tenant schedule ledger", () => {
  it("enqueues a daily job once per tenant and local date", async () => {
    const ledger = container.get<ITenantScheduleLedger>(TYPES.TenantScheduleLedger);
    expect(await ledger.enqueueOnce(tenantId.value, "tenant.daily_maintenance", "2026-10-16")).toBe(
      true,
    );
    expect(await ledger.enqueueOnce(tenantId.value, "tenant.daily_maintenance", "2026-10-16")).toBe(
      false,
    );
    const { rows } = await platform.query<{ n: string }>(
      `select count(*) as n from pgboss.job
        where name = 'tenant.daily_maintenance' and data->>'tenantId' = $1`,
      [tenantId.value],
    );
    expect(Number(rows[0]?.n)).toBe(1);
  });
});

describe("platform email", () => {
  it("renders, queues and sends through SMTP, then purges the content", async () => {
    const to = `jobs-${randomUUID()}@example.com`;
    const deliveryId = await container
      .get<NotificationService>(TYPES.NotificationService)
      .sendEmail({
        to,
        template: "auth.otp_code",
        data: {
          recipientName: "Ama",
          code: "482913",
          purpose: "email_verification",
          expiresInMinutes: 10,
          businessName: null,
        },
        idempotencyKey: `test:${to}`,
      });

    const message = await eventually(async () => {
      const res = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`);
      const body = (await res.json()) as { messages: { Subject: string; ID: string }[] };
      return body.messages[0];
    });
    expect(message.Subject).toBe("482913 is your Autoforce Manager code");

    const { rows } = await platform.query<{ status: string; body_text: string | null }>(
      "select status, body_text from email_deliveries where id = $1",
      [deliveryId],
    );
    expect(rows[0]).toEqual({ status: "sent", body_text: null });
  });
});

describe("job queue privileges", () => {
  it("lets the app role use the queue but not change its schema", async () => {
    const factory = container.get<PostgresConnectionFactory>(TYPES.PostgresConnectionFactory);
    const client = await factory.connect("platform", testConfig().database.platformDatabase);
    try {
      await expect(client.query("select count(*) from pgboss.job")).resolves.toBeDefined();
      await expect(client.query("create table pgboss.evil (id int)")).rejects.toMatchObject({
        code: "42501",
      });
      await expect(client.query("drop table pgboss.job")).rejects.toMatchObject({ code: "42501" });
    } finally {
      await client.end();
    }
  });
});
