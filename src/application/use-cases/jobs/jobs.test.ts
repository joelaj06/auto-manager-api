import { describe, expect, it, vi } from "vitest";
import { EventHandlerRegistry } from "../../events/EventHandlerRegistry.js";
import type { DeliveredEvent, IEventHandler } from "../../events/IEventHandler.js";
import type { JobName, JobPayloads } from "../../jobs/jobCatalog.js";
import { JOB_CATALOG } from "../../jobs/jobCatalog.js";
import { NotificationService } from "../../notifications/NotificationService.js";
import { escapeHtml, renderEmail } from "../../notifications/emailTemplates.js";
import type {
  EmailDelivery,
  IEmailDeliveries,
  NewEmailDelivery,
} from "../../ports/IEmailDeliveries.js";
import type { IEmailSender } from "../../ports/IEmailSender.js";
import type { EnqueueOptions, IJobQueue } from "../../ports/IJobQueue.js";
import type { ILogger } from "../../ports/ILogger.js";
import type { IOutboxStore, PendingOutboxEvent } from "../../ports/IOutboxStore.js";
import type { ITenantRoster, RosterTenant } from "../../ports/ITenantRoster.js";
import { localDateTime } from "../../services/TenantLocalTime.js";
import { DeliverEvent } from "./DeliverEvent.js";
import { DrainOutbox } from "./DrainOutbox.js";
import { RunTenantSchedules } from "./RunTenantSchedules.js";
import { SendQueuedEmail } from "./SendQueuedEmail.js";
import { SweepOutboxes } from "./SweepOutboxes.js";

const TENANT = "0198f0e0-0000-7000-8000-00000000000a";
const now = new Date("2026-10-16T10:00:00Z");
const clock = { now: () => now };
const unitOfWork = { run: <T>(work: () => Promise<T>) => work() };

function silentLogger(): ILogger {
  const logger: ILogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => logger,
  };
  return logger;
}

class RecordingQueue implements IJobQueue {
  readonly sent: { name: JobName; payload: unknown; options: EnqueueOptions | undefined }[] = [];
  failFor: JobName | null = null;
  enqueue<N extends JobName>(name: N, payload: JobPayloads[N], options?: EnqueueOptions) {
    if (name === this.failFor) return Promise.reject(new Error("queue down"));
    this.sent.push({ name, payload, options });
    return Promise.resolve(`job-${this.sent.length}`);
  }
}

class MemoryOutbox implements IOutboxStore {
  readonly published: string[] = [];
  readonly failed: { id: string; retryAt: Date }[] = [];
  constructor(private pending: PendingOutboxEvent[]) {}
  claimDue(limit: number) {
    const batch = this.pending.slice(0, limit);
    this.pending = this.pending.slice(limit);
    return Promise.resolve(batch);
  }
  markPublished(id: string) {
    this.published.push(id);
    return Promise.resolve();
  }
  markFailed(id: string, _error: string, retryAt: Date) {
    this.failed.push({ id, retryAt });
    return Promise.resolve();
  }
}

const event = (id: string, eventType = "rental.checked_in", attempts = 0): PendingOutboxEvent => ({
  id,
  eventType,
  aggregateType: "rental",
  aggregateId: "r1",
  payload: { amountMinor: 1000 },
  occurredAt: now,
  attempts,
});

const handler = (name: string, eventTypes: string[], handle = vi.fn(() => Promise.resolve())) =>
  ({ name, eventTypes, handle }) satisfies IEventHandler;

describe("EventHandlerRegistry", () => {
  it("indexes handlers by event type and name", () => {
    const a = handler("billing.on_checkin", ["rental.checked_in"]);
    const b = handler("notifications.receipt", ["rental.checked_in", "payment.recorded"]);
    const registry = new EventHandlerRegistry([a, b]);
    expect(registry.handlersFor("rental.checked_in")).toEqual([a, b]);
    expect(registry.handlersFor("payment.recorded")).toEqual([b]);
    expect(registry.handlersFor("nothing")).toEqual([]);
    expect(registry.byHandlerName("billing.on_checkin")).toBe(a);
  });

  it("rejects duplicate or malformed names", () => {
    expect(() => new EventHandlerRegistry([handler("a.b", []), handler("a.b", [])])).toThrow(
      /Duplicate/,
    );
    expect(() => new EventHandlerRegistry([handler("Bad Name", [])])).toThrow(/Invalid/);
  });
});

describe("DrainOutbox", () => {
  const registry = new EventHandlerRegistry([
    handler("billing.on_checkin", ["rental.checked_in"]),
    handler("notifications.receipt", ["rental.checked_in"]),
  ]);

  it("enqueues one delivery per subscribed handler and marks events published", async () => {
    const outbox = new MemoryOutbox([event("e1"), event("e2", "vehicle.created")]);
    const queue = new RecordingQueue();
    await new DrainOutbox({ unitOfWork, outbox, handlers: registry, queue, clock }).handle({
      tenantId: TENANT,
    });

    expect(queue.sent.map((s) => [s.name, (s.payload as { handler: string }).handler])).toEqual([
      ["event.deliver", "billing.on_checkin"],
      ["event.deliver", "notifications.receipt"],
    ]);
    expect(queue.sent[0]?.payload).toMatchObject({
      tenantId: TENANT,
      eventId: "e1",
      payload: { amountMinor: 1000 },
      occurredAt: now.toISOString(),
    });
    // Events nobody subscribes to are published too.
    expect(outbox.published).toEqual(["e1", "e2"]);
  });

  it("backs off failed events and schedules a delayed drain", async () => {
    const outbox = new MemoryOutbox([event("e1", "rental.checked_in", 2)]);
    const queue = new RecordingQueue();
    queue.failFor = "event.deliver";
    await new DrainOutbox({ unitOfWork, outbox, handlers: registry, queue, clock }).handle({
      tenantId: TENANT,
    });

    expect(outbox.published).toEqual([]);
    expect(outbox.failed).toEqual([{ id: "e1", retryAt: new Date(now.getTime() + 40_000) }]);
    expect(queue.sent).toEqual([
      {
        name: "outbox.drain",
        payload: { tenantId: TENANT },
        options: { singletonKey: TENANT, startAfter: new Date(now.getTime() + 40_000) },
      },
    ]);
  });

  it("continues with another drain when the batch was full", async () => {
    const outbox = new MemoryOutbox(Array.from({ length: 150 }, (_, i) => event(`e${i}`, "x.y")));
    const queue = new RecordingQueue();
    await new DrainOutbox({ unitOfWork, outbox, handlers: registry, queue, clock }).handle({
      tenantId: TENANT,
    });
    expect(outbox.published).toHaveLength(100);
    expect(queue.sent).toEqual([
      { name: "outbox.drain", payload: { tenantId: TENANT }, options: { singletonKey: TENANT } },
    ]);
  });
});

describe("DeliverEvent", () => {
  const payload: JobPayloads["event.deliver"] = {
    tenantId: TENANT,
    eventId: "e1",
    eventType: "rental.checked_in",
    handler: "billing.on_checkin",
    aggregateType: "rental",
    aggregateId: "r1",
    payload: { amountMinor: 1000 },
    occurredAt: now.toISOString(),
  };

  it("runs the handler once per (handler, event)", async () => {
    const keys = new Set<string>();
    const processed = {
      markProcessed: (key: string) => Promise.resolve(keys.size !== keys.add(key).size),
    };
    const h = handler("billing.on_checkin", ["rental.checked_in"]);
    const deliver = new DeliverEvent({
      unitOfWork,
      processed,
      handlers: new EventHandlerRegistry([h]),
      logger: silentLogger(),
    });

    await deliver.handle(payload);
    await deliver.handle(payload);
    expect(h.handle).toHaveBeenCalledTimes(1);
    expect(keys).toEqual(new Set(["event:billing.on_checkin:e1"]));
    const delivered = h.handle.mock.calls[0] as unknown as [DeliveredEvent];
    expect(delivered[0]).toMatchObject({ id: "e1", tenantId: TENANT, occurredAt: now });
  });

  it("skips handlers that no longer exist", async () => {
    const logger = silentLogger();
    const processed = { markProcessed: vi.fn(() => Promise.resolve(true)) };
    await new DeliverEvent({
      unitOfWork,
      processed,
      handlers: new EventHandlerRegistry([]),
      logger,
    }).handle(payload);
    expect(processed.markProcessed).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });
});

class PagedRoster implements ITenantRoster {
  constructor(private readonly tenants: RosterTenant[]) {}
  listUsable(afterId: string | null, limit: number) {
    const start = afterId === null ? 0 : this.tenants.findIndex((t) => t.id === afterId) + 1;
    return Promise.resolve(this.tenants.slice(start, start + limit));
  }
}

const tenantNo = (n: number, timezone = "Africa/Accra"): RosterTenant => ({
  id: `0198f0e0-0000-7000-8000-${n.toString().padStart(12, "0")}`,
  status: "active",
  timezone,
});

describe("SweepOutboxes", () => {
  it("enqueues a drain for every usable tenant across pages", async () => {
    const tenants = Array.from({ length: 1_203 }, (_, i) => tenantNo(i));
    const queue = new RecordingQueue();
    await new SweepOutboxes({ roster: new PagedRoster(tenants), queue }).handle();
    expect(queue.sent).toHaveLength(1_203);
    expect(new Set(queue.sent.map((s) => s.options?.singletonKey)).size).toBe(1_203);
  });
});

describe("RunTenantSchedules", () => {
  it("enqueues daily jobs once the tenant's local hour is reached", async () => {
    const enqueued: string[] = [];
    const ledger = {
      enqueueOnce: (tenantId: string, job: string, localDate: string) => {
        enqueued.push(`${tenantId.slice(-2)}:${job}:${localDate}`);
        return Promise.resolve(true);
      },
    };
    // 02:30 UTC: 02:30 in Accra, 19:30 the previous day in Los Angeles.
    const at = new Date("2026-10-16T02:30:00Z");
    await new RunTenantSchedules({
      roster: new PagedRoster([
        tenantNo(1, "Africa/Accra"),
        tenantNo(2, "America/Los_Angeles"),
        tenantNo(3, "Not/AZone"),
      ]),
      ledger,
      clock: { now: () => at },
      logger: silentLogger(),
      dailyJobs: [{ job: "tenant.daily_maintenance", localHour: 2 }],
    }).handle();

    // Accra: 02:30 ≥ 02 → today. Los Angeles: 19:30 on the 15th ≥ 02 → the 15th. Bad zone skipped.
    expect(enqueued).toEqual([
      "01:tenant.daily_maintenance:2026-10-16",
      "02:tenant.daily_maintenance:2026-10-15",
    ]);
  });

  it("waits until the local hour", async () => {
    const ledger = { enqueueOnce: vi.fn(() => Promise.resolve(true)) };
    await new RunTenantSchedules({
      roster: new PagedRoster([tenantNo(1)]),
      ledger,
      clock: { now: () => new Date("2026-10-16T01:59:00Z") },
      logger: silentLogger(),
    }).handle();
    // Only the remittance cut-off (from midnight; it waits for its time itself) is due at 01:59.
    expect(ledger.enqueueOnce.mock.calls.map((call: unknown[]) => call[1])).toEqual([
      "tenant.remittance_cutoff",
    ]);
  });
});

describe("localDateTime", () => {
  it("gives the date, hour and minute in the timezone", () => {
    const instant = new Date("2026-12-31T23:30:00Z");
    expect(localDateTime(instant, "Africa/Accra")).toEqual({
      date: "2026-12-31",
      hour: 23,
      minute: 30,
    });
    expect(localDateTime(instant, "Africa/Lagos")).toEqual({
      date: "2027-01-01",
      hour: 0,
      minute: 30,
    });
    expect(() => localDateTime(instant, "Mars/Base")).toThrow(RangeError);
  });
});

class MemoryDeliveries implements IEmailDeliveries {
  readonly rows = new Map<string, EmailDelivery & { key: string; error?: string }>();
  queue(d: NewEmailDelivery) {
    for (const row of this.rows.values()) {
      if (row.key === d.idempotencyKey) return Promise.resolve({ id: row.id, created: false });
    }
    const id = `d${this.rows.size + 1}`;
    this.rows.set(id, {
      id,
      key: d.idempotencyKey,
      status: "queued",
      recipient: d.recipient,
      attempts: 0,
      content: d.content,
    });
    return Promise.resolve({ id, created: true });
  }
  find(id: string) {
    return Promise.resolve(this.rows.get(id) ?? null);
  }
  markSent(id: string) {
    const row = this.rows.get(id)!;
    this.rows.set(id, { ...row, status: "sent", content: null, attempts: row.attempts + 1 });
    return Promise.resolve();
  }
  markAttemptFailed(id: string, error: string, final: boolean) {
    const row = this.rows.get(id)!;
    this.rows.set(id, {
      ...row,
      error,
      attempts: row.attempts + 1,
      status: final ? "failed" : row.status,
    });
    return Promise.resolve();
  }
}

describe("email notifications", () => {
  const otpData = {
    recipientName: "Ama <script>",
    code: "123456",
    purpose: "password_reset",
    expiresInMinutes: 10,
    businessName: "Kofi & Sons",
  };

  it("renders templates with escaped HTML", () => {
    const email = renderEmail("auth.otp_code", otpData);
    expect(email.subject).toBe("123456 is your Autoforce Manager code");
    expect(email.text).toContain("reset your password");
    expect(email.html).toContain("Ama &lt;script&gt;");
    expect(email.html).toContain("Kofi &amp; Sons");
    expect(email.html).not.toContain("<script>");
    expect(escapeHtml(`"'`)).toBe("&quot;&#39;");
  });

  it("queues once per idempotency key and sends once", async () => {
    const deliveries = new MemoryDeliveries();
    const notifications = new NotificationService(deliveries);
    const request = {
      to: " Ama@Example.com ",
      template: "auth.otp_code" as const,
      data: otpData,
      idempotencyKey: "otp:c1",
    };
    const id = await notifications.sendEmail(request);
    expect(await notifications.sendEmail(request)).toBe(id);
    expect(deliveries.rows.get(id)?.recipient).toBe("ama@example.com");

    const sender: IEmailSender = { send: vi.fn(() => Promise.resolve("<msg-1>")) };
    const send = new SendQueuedEmail({ deliveries, sender, clock, logger: silentLogger() });
    await send.handle({ deliveryId: id }, { jobId: "j1", attempt: 1 });
    await send.handle({ deliveryId: id }, { jobId: "j1", attempt: 2 });
    expect(sender.send).toHaveBeenCalledTimes(1);
    expect(deliveries.rows.get(id)).toMatchObject({ status: "sent", content: null });
  });

  it("rejects invalid recipients", async () => {
    const notifications = new NotificationService(new MemoryDeliveries());
    await expect(
      notifications.sendEmail({
        to: "not-an-email",
        template: "auth.otp_code",
        data: otpData,
        idempotencyKey: "k",
      }),
    ).rejects.toThrow(/recipient/);
  });

  it("records failed attempts and gives up after the retry limit", async () => {
    const deliveries = new MemoryDeliveries();
    const { id } = await deliveries.queue({
      idempotencyKey: "k",
      tenantId: null,
      template: "auth.otp_code",
      recipient: "a@b.co",
      content: { subject: "s", text: "t", html: "h" },
    });
    const sender: IEmailSender = { send: () => Promise.reject(new Error("SMTP 451")) };
    const send = new SendQueuedEmail({ deliveries, sender, clock, logger: silentLogger() });

    await expect(send.handle({ deliveryId: id }, { jobId: "j", attempt: 1 })).rejects.toThrow();
    expect(deliveries.rows.get(id)).toMatchObject({ status: "queued", attempts: 1 });

    const lastAttempt = JOB_CATALOG["email.send"].retryLimit + 1;
    await expect(
      send.handle({ deliveryId: id }, { jobId: "j", attempt: lastAttempt }),
    ).rejects.toThrow();
    expect(deliveries.rows.get(id)).toMatchObject({ status: "failed", error: "SMTP 451" });
  });
});

describe("job catalogue", () => {
  it("defines sane retry and expiry settings and valid cron expressions", () => {
    for (const [name, job] of Object.entries(JOB_CATALOG)) {
      expect(name, name).toMatch(/^[a-z_]+\.[a-z_]+$/);
      expect(job.retryLimit, name).toBeGreaterThanOrEqual(0);
      expect(job.expireInSeconds, name).toBeGreaterThan(0);
      if (job.cron !== undefined) expect(job.cron, name).toMatch(/^(\S+\s){4}\S+$/);
    }
  });
});
