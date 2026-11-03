import type { Express } from "express";
import type { Container } from "inversify";
import type pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IJobHandler } from "../../application/jobs/IJobHandler.js";
import type { JobName } from "../../application/jobs/jobCatalog.js";
import type { PostgresConnectionFactory } from "../../infrastructure/database/postgres/PostgresConnectionFactory.js";
import {
  ProvisionedTenants,
  type ProvisionedTenant,
} from "../../testing/fixtures/ProvisionedTenants.js";
import { StaffFixtures, type TestStaff } from "../../testing/fixtures/StaffFixtures.js";
import { createTestContainer } from "../../testing/testContainer.js";
import { disposeContainer } from "../dependency-injection/container.js";
import { TYPES } from "../dependency-injection/types.js";

/**
 * The support desk, demo tenants and the onboarding concierge (P9-3) end to end: a ticket raised
 * in the app, answered with a canned response, escalated, reopened by the customer, resolved and
 * rated, a phone ticket breaching its SLA with an alert, a demo provisioned and filled with
 * sample data through the API, ended and purged, and a new tenant's concierge tasks completed by
 * its own progress and by staff.
 */
const BASE = "/api/platform/v1";
let container: Container;
let app: Express;
let platform: pg.Pool;
let factory: PostgresConnectionFactory;
let admin: TestStaff;
let support: TestStaff;
let sales: TestStaff;
let auditor: TestStaff;
let t: ProvisionedTenant;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- response bodies are checked by expect()
type Body = any;

const api = () => request(app);
const as = (who: { accessToken: string }) => ({ Authorization: `Bearer ${who.accessToken}` });
const owner = () => ({ Authorization: `Bearer ${t.ownerAccessToken}`, "X-Tenant": t.slug });

function handler(job: JobName): IJobHandler {
  const found = container.get<IJobHandler[]>(TYPES.JobHandlers).find((h) => h.job === job);
  if (found === undefined) throw new Error(`No handler for ${job}`);
  return found;
}

const run = (job: JobName, payload: object = {}) =>
  handler(job).handle(payload as never, { jobId: "test", attempt: 1 });

const pluck = (list: Body, key: string): unknown[] =>
  (list as Record<string, unknown>[]).map((x) => x[key]);

function ok(res: request.Response, status = 200): Body {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res.body.data;
}

beforeAll(async () => {
  container = await createTestContainer({ AUTH_RATE_LIMIT_MAX: "10000", RATE_LIMIT_MAX: "100000" });
  app = container.get<Express>(TYPES.HttpApp);
  platform = container.get<pg.Pool>(TYPES.PlatformDatabasePool);
  factory = container.get<PostgresConnectionFactory>(TYPES.PostgresConnectionFactory);
  const fixtures = new StaffFixtures(container);
  admin = await fixtures.create(["super_admin"]);
  support = await fixtures.create(["support"]);
  sales = await fixtures.create(["sales"]);
  auditor = await fixtures.create(["auditor"]);
  t = await new ProvisionedTenants(container, app, admin).create();
}, 120_000);

afterAll(async () => {
  await disposeContainer(container);
});

describe("support desk", () => {
  let ticketId: string;
  let cannedId: string;

  it("takes a ticket raised in the app and acknowledges it by email", async () => {
    const { ticket } = ok(
      await api().post("/api/v1/support/tickets").set(owner()).send({
        subject: "Remittance not showing",
        category: "technical",
        priority: "high",
        body: "Kwame paid this morning but it is not on the board.",
      }),
      201,
    );
    ticketId = ticket.id;
    expect(ticket.number).toMatch(/^AF-SUP-\d{4}-\d{6}$/);
    expect(ticket).toMatchObject({ status: "open", channel: "app", tenantId: t.tenantId });
    expect(ticket.requesterEmail).toBe(t.ownerEmail);

    const { rows } = await platform.query(
      "select 1 from email_deliveries where recipient = $1 and template = 'support.ticket_received'",
      [t.ownerEmail],
    );
    expect(rows).toHaveLength(1);

    const mine = ok(await api().get("/api/v1/support/tickets").set(owner()));
    expect(pluck(mine, "id")).toContain(ticketId);
    // Urgent is for staff to set.
    const urgent = await api()
      .post("/api/v1/support/tickets")
      .set(owner())
      .send({ subject: "Help", category: "other", priority: "urgent", body: "Now" });
    expect(urgent.status).toBe(400);
  });

  it("answers with a canned response, keeps internal notes from the customer and escalates", async () => {
    const canned = ok(
      await api()
        .post(`${BASE}/support/canned-responses`)
        .set(as(support))
        .send({
          title: `Looking into it ${ticketId.slice(0, 6)}`,
          body: "Hi {{requesterName}}, we are looking into {{ticketNumber}} for {{businessName}}. — {{staffName}}",
          category: "technical",
        }),
      201,
    );
    cannedId = canned.id;
    // The auditor reads but does not write.
    expect(
      (await api().post(`${BASE}/support/canned-responses`).set(as(auditor)).send(canned)).status,
    ).toBe(403);

    ok(
      await api()
        .post(`${BASE}/support/tickets/${ticketId}/messages`)
        .set(as(support))
        .send({ body: "Remittance job log shows a retry.", internal: true }),
    );
    const replied = ok(
      await api()
        .post(`${BASE}/support/tickets/${ticketId}/messages`)
        .set(as(support))
        .send({ cannedResponseId: cannedId }),
    );
    expect(replied.ticket.status).toBe("waiting_on_customer");
    expect(replied.ticket.firstRespondedAt).not.toBeNull();
    const reply = (replied.messages as Body[]).find((m) => m.cannedResponseId === cannedId);
    expect(reply.body).toContain("Hi Test Owner");
    expect(reply.body).toContain(replied.ticket.number);
    expect(reply.body).not.toContain("{{");

    const customer = ok(await api().get(`/api/v1/support/tickets/${ticketId}`).set(owner()));
    expect((customer.messages as Body[]).some((m) => m.internal)).toBe(false);
    expect((customer.messages as Body[]).length).toBe(2);

    const bad = await api()
      .post(`${BASE}/support/tickets/${ticketId}/escalate`)
      .set(as(support))
      .send({
        requestId: "req-1",
        sentryUrl: "http://sentry.example.com/1",
        note: "Remittance job",
      });
    expect(bad.status).toBe(422);
    const escalated = ok(
      await api().post(`${BASE}/support/tickets/${ticketId}/escalate`).set(as(support)).send({
        requestId: "req-7f3a",
        sentryUrl: "https://sentry.example.com/issues/42",
        note: "Remittance posted but the board read is stale",
      }),
    );
    expect(escalated.status).toBe("escalated");
    expect(escalated.escalation).toMatchObject({ requestId: "req-7f3a" });

    const escalatedList = ok(
      await api()
        .get(`${BASE}/support/tickets?status=escalated&tenantId=${t.tenantId}`)
        .set(as(auditor)),
    );
    expect(pluck(escalatedList, "id")).toEqual([ticketId]);
  });

  it("is resolved, reopened by the customer, resolved again and rated once", async () => {
    const resolved = ok(
      await api()
        .post(`${BASE}/support/tickets/${ticketId}/status`)
        .set(as(support))
        .send({ status: "resolved", note: "Fixed in the release" }),
    );
    expect(resolved.status).toBe("resolved");
    const { rows } = await platform.query(
      "select 1 from email_deliveries where recipient = $1 and template = 'support.ticket_resolved'",
      [t.ownerEmail],
    );
    expect(rows).toHaveLength(1);

    const reopened = ok(
      await api()
        .post(`/api/v1/support/tickets/${ticketId}/messages`)
        .set(owner())
        .send({ body: "Still missing for Ama." }),
    );
    expect(reopened.ticket.status).toBe("open");
    ok(
      await api()
        .post(`${BASE}/support/tickets/${ticketId}/status`)
        .set(as(support))
        .send({ status: "resolved" }),
    );
    const rated = ok(
      await api()
        .post(`/api/v1/support/tickets/${ticketId}/rating`)
        .set(owner())
        .send({ score: 5, comment: "Thanks" }),
    );
    expect(rated.satisfaction).toBe(5);
    const again = await api()
      .post(`/api/v1/support/tickets/${ticketId}/rating`)
      .set(owner())
      .send({ score: 1 });
    expect(again.status).toBe(422);

    const used = ok(await api().get(`${BASE}/support/canned-responses`).set(as(support)));
    expect((used as Body[]).find((c) => c.id === cannedId).uses).toBe(1);
  });

  it("records an SLA breach on a phone ticket once and raises an alert", async () => {
    const logged = ok(
      await api().post(`${BASE}/support/tickets`).set(as(support)).send({
        tenantId: t.tenantId,
        requesterName: "Kofi Boateng",
        requesterPhone: "+233241234567",
        channel: "phone",
        subject: "Cannot sign in on the driver app",
        category: "account",
        priority: "urgent",
        body: "Called in: the driver app says the password is wrong.",
      }),
      201,
    );
    expect(logged.businessHours).toBe(false);
    await platform.query(
      `update support_tickets set first_response_due_at = now() - interval '1 minute',
              resolution_due_at = now() + interval '1 hour' where id = $1`,
      [logged.id],
    );
    await run("support.sweep");
    await run("support.sweep");
    const ticket = ok(await api().get(`${BASE}/support/tickets/${logged.id}`).set(as(support)));
    expect(ticket.ticket.firstResponseBreachedAt).not.toBeNull();
    const { rows } = await platform.query<{ severity: string; occurrences: number }>(
      "select severity, occurrences from platform_alerts where key = $1",
      [`support.sla:${logged.id}`],
    );
    expect(rows).toEqual([{ severity: "critical", occurrences: 1 }]);

    const breached = ok(await api().get(`${BASE}/support/tickets?breached=true`).set(as(support)));
    expect(pluck(breached, "id")).toContain(logged.id);
    const summary = ok(await api().get(`${BASE}/support/summary?days=7`).set(as(support)));
    expect(summary.breached).toBeGreaterThanOrEqual(1);
    expect(summary.period.satisfactionAverage).not.toBeNull();
  });

  it("lets operations set the SLA targets, not support", async () => {
    const target = { firstResponseMinutes: 90, resolutionMinutes: 600, businessHours: true };
    expect((await api().put(`${BASE}/support/sla/high`).set(as(support)).send(target)).status).toBe(
      403,
    );
    const targets = ok(await api().put(`${BASE}/support/sla/high`).set(as(admin)).send(target));
    expect(targets.high.firstResponseMinutes).toBe(90);
    await api()
      .put(`${BASE}/support/sla/high`)
      .set(as(admin))
      .send({ ...target, firstResponseMinutes: 120 })
      .expect(200);
  });
});

describe("demo tenants", () => {
  let demoId: string;
  let database: string;

  it("are created by sales, provisioned with the demo welcome and filled with sample data", async () => {
    const created = ok(
      await api()
        .post(`${BASE}/demo-tenants`)
        .set(as(sales))
        .send({
          businessName: "Accra Demo Motors",
          businessType: "mixed",
          contactName: "Yaw Darko",
          contactEmail: `yaw-${Date.now()}@example.com`,
          contactPhone: "+233201234567",
          prospect: "Kumasi Cabs",
          days: 10,
        }),
      201,
    );
    demoId = created.tenantId;
    expect(created.slug).toMatch(/^demo-[a-z0-9]{6}$/);
    expect(created).toMatchObject({ purpose: "sales_demo", sampleData: "pending" });
    expect((await api().post(`${BASE}/demo-tenants`).set(as(support)).send({})).status).toBe(403);

    await run("tenant.provision", { tenantId: demoId });
    const { rows: emails } = await platform.query(
      "select 1 from email_deliveries where recipient = $1 and template = 'tenant.welcome_demo'",
      [created.contactEmail],
    );
    expect(emails).toHaveLength(1);
    const { rows } = await platform.query<{ demo: boolean; database_name: string }>(
      "select demo, database_name from tenants where id = $1",
      [demoId],
    );
    expect(rows[0]!.demo).toBe(true);
    database = rows[0]!.database_name;
    // No concierge tasks for a demo.
    const { rows: tasks } = await platform.query(
      "select 1 from onboarding_tasks where tenant_id = $1",
      [demoId],
    );
    expect(tasks).toHaveLength(0);

    await run("tenant.demo_seed", { tenantId: demoId });
    const demo = ok(await api().get(`${BASE}/demo-tenants/${demoId}`).set(as(sales)));
    expect(demo.sampleData, demo.sampleError).toBe("seeded");
    const client = await factory.connect("migrator", database);
    try {
      const counts = await client.query<{ vehicles: number; drivers: number; customers: number }>(
        `select (select count(*)::int from vehicles) as vehicles,
                (select count(*)::int from drivers) as drivers,
                (select count(*)::int from customers) as customers`,
      );
      expect(counts.rows[0]!.vehicles).toBe(10);
      expect(counts.rows[0]!.drivers).toBe(6);
      expect(counts.rows[0]!.customers).toBeGreaterThanOrEqual(5);
    } finally {
      await client.end();
    }
    // Running again does nothing more.
    await run("tenant.demo_seed", { tenantId: demoId });

    const listed = ok(await api().get(`${BASE}/tenants?q=${created.slug}`).set(as(admin)));
    expect(JSON.stringify(listed)).toContain('"demo":true');
  }, 180_000);

  it("are extended, ended, and purged a week after they end", async () => {
    const extended = ok(
      await api().post(`${BASE}/demo-tenants/${demoId}/extend`).set(as(sales)).send({ days: 5 }),
    );
    expect(extended.extensions).toBe(1);
    const ended = ok(await api().post(`${BASE}/demo-tenants/${demoId}/end`).set(as(sales)));
    expect(ended.expiredAt).not.toBeNull();
    expect(ended.tenantStatus).toBe("deactivated");

    await run("demos.sweep");
    expect(
      (await platform.query("select 1 from pg_database where datname = $1", [database])).rowCount,
    ).toBe(1);
    await platform.query(
      "update demo_tenants set expired_at = now() - interval '8 days' where tenant_id = $1",
      [demoId],
    );
    await run("demos.sweep");
    const purged = ok(await api().get(`${BASE}/demo-tenants/${demoId}`).set(as(sales)));
    expect(purged.purgedAt).not.toBeNull();
    expect(purged.hasDatabase).toBe(false);
    expect(
      (await platform.query("select 1 from pg_database where datname = $1", [database])).rowCount,
    ).toBe(0);
    const again = await api()
      .post(`${BASE}/demo-tenants/${demoId}/extend`)
      .set(as(sales))
      .send({ days: 5 });
    expect(again.status).toBe(422);
  });

  it("are never invoiced", async () => {
    const { rows } = await platform.query("select 1 from billing_invoices where tenant_id = $1", [
      demoId,
    ]);
    expect(rows).toHaveLength(0);
  });
});

describe("onboarding concierge", () => {
  it("gives a new tenant its task list, completed by its own progress and by staff", async () => {
    const tasks = ok(
      await api().get(`${BASE}/tenants/${t.tenantId}/onboarding-tasks`).set(as(support)),
    );
    expect(pluck(tasks, "templateKey")).toEqual(
      expect.arrayContaining(["welcome_call", "vehicles_imported", "check_in_call"]),
    );
    expect((tasks as Body[]).every((x) => x.status === "open")).toBe(true);

    await platform.query(
      `insert into tenant_onboarding (tenant_id, steps) values ($1, $2::jsonb)
       on conflict (tenant_id) do update set steps = tenant_onboarding.steps || excluded.steps`,
      [t.tenantId, JSON.stringify({ vehicle_added: new Date().toISOString() })],
    );
    await run("onboarding.sweep");
    const after = ok(
      await api().get(`${BASE}/tenants/${t.tenantId}/onboarding-tasks`).set(as(support)),
    );
    const vehicles = (after as Body[]).find((x) => x.templateKey === "vehicles_imported");
    expect(vehicles).toMatchObject({ status: "done", doneAutomatically: true });

    const welcome = (after as Body[]).find((x) => x.templateKey === "welcome_call");
    const call = (after as Body[]).find((x) => x.templateKey === "check_in_call");
    ok(
      await api()
        .put(`${BASE}/tenants/${t.tenantId}/onboarding-tasks/assignee`)
        .set(as(support))
        .send({ assigneeId: support.id }),
    );
    const mine = ok(
      await api().get(`${BASE}/onboarding/tasks?assigneeId=me&status=open`).set(as(support)),
    );
    expect(pluck(mine, "id")).toContain(welcome.id);

    const done = ok(
      await api()
        .post(`${BASE}/onboarding/tasks/${welcome.id}/complete`)
        .set(as(support))
        .send({ note: "Walked the owner through the setup" }),
    );
    expect(done).toMatchObject({ status: "done", doneAutomatically: false, doneBy: support.id });
    expect(
      (await api().post(`${BASE}/onboarding/tasks/${call.id}/skip`).set(as(support)).send({}))
        .status,
    ).toBe(422);
    ok(
      await api()
        .post(`${BASE}/onboarding/tasks/${call.id}/skip`)
        .set(as(support))
        .send({ note: "Owner asked for email only" }),
    );
    const reopened = ok(
      await api().post(`${BASE}/onboarding/tasks/${call.id}/reopen`).set(as(support)).send({}),
    );
    expect(reopened.status).toBe("open");

    const own = ok(
      await api()
        .post(`${BASE}/tenants/${t.tenantId}/onboarding-tasks`)
        .set(as(support))
        .send({
          title: "Import the old spreadsheet",
          dueAt: new Date(Date.now() + 86_400_000).toISOString(),
        }),
      201,
    );
    expect(own.templateKey).toBeNull();
    // Starting again leaves the list as it is.
    await run("onboarding.sweep");
    const final = ok(
      await api().get(`${BASE}/tenants/${t.tenantId}/onboarding-tasks`).set(as(support)),
    );
    expect((final as Body[]).length).toBe((after as Body[]).length + 1);
  });
});
