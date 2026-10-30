import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { Container } from "inversify";
import type pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ITenantContext } from "../../application/ports/ITenantContext.js";
import type { ReportSchedules } from "../../application/use-cases/reporting/ReportSchedules.js";
import type { Reports } from "../../application/use-cases/reporting/Reports.js";
import {
  OWNER_PASSWORD,
  ProvisionedTenants,
  type ProvisionedTenant,
} from "../../testing/fixtures/ProvisionedTenants.js";
import { StaffFixtures } from "../../testing/fixtures/StaffFixtures.js";
import { createTestContainer } from "../../testing/testContainer.js";
import { disposeContainer } from "../dependency-injection/container.js";
import { TYPES } from "../dependency-injection/types.js";

/**
 * Scheduled reports and role dashboards (P8-3) end to end: a schedule checked against its
 * owner's permissions and its recipients, a due run queued by the sweep as the owner with the
 * period worked out on the day, the file sent to the recipients in the app and by email and
 * downloaded by them, someone not on the list kept out, run now, pause and resume, a schedule
 * paused when its owner is disabled, and the role dashboards with their widgets by permission
 * and the business's own layout.
 */
let container: Container;
let app: Express;
let platform: pg.Pool;
let t: ProvisionedTenant;
let branchId: string;
let accountant: Session;
let colleague: Session;
let seller: Session;

type Session = { token: string; userId: string };
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- response bodies are checked by expect()
type Body = any;

const api = () => request(app);
const as = (token: string) => ({ Authorization: `Bearer ${token}` });
const owner = () => as(t.ownerAccessToken);
const inTenant = <T>(body: () => Promise<T>) =>
  container.get<ITenantContext>(TYPES.TenantContext).runAs(t.tenant.id, body);
const runDue = () => inTenant(() => container.get<ReportSchedules>(TYPES.ReportSchedules).runDue());
const generate = (jobId: string) =>
  inTenant(() => container.get<Reports>(TYPES.Reports).generate(jobId));
const due = (id: string) =>
  t.tenant.query(
    `update report_schedules set next_run_at = now() - interval '1 minute' where id = $1`,
    [id],
  );
const lastMonthEnd = () => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 0)).toISOString().slice(0, 10);
};

async function join(roleName: string, name: string): Promise<Session> {
  const roles = await api().get("/api/v1/roles").set(owner());
  const role = (roles.body.data as { id: string; name: string }[]).find(
    (r) => r.name === roleName,
  )!;
  const email = `user-${randomUUID().slice(0, 8)}@example.com`;
  const invited = await api()
    .post("/api/v1/users/invitations")
    .set(owner())
    .send({ name, email, branchIds: [branchId], roles: [{ roleId: role.id, branchId: null }] });
  expect(invited.status, JSON.stringify(invited.body)).toBe(201);
  const { rows } = await platform.query<{ body_text: string }>(
    `select body_text from email_deliveries where recipient = $1
      and template = 'tenant.user_invitation' order by created_at desc limit 1`,
    [email],
  );
  const token = /#token=([A-Za-z0-9_-]+)/.exec(rows[0]!.body_text)![1]!;
  const accepted = await api()
    .post("/api/v1/auth/invitations/accept")
    .set("X-Tenant", t.slug)
    .send({ token, password: OWNER_PASSWORD });
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
  const me = await api()
    .get("/api/v1/me")
    .set(as(accepted.body.data.accessToken as string));
  return { token: accepted.body.data.accessToken as string, userId: me.body.data.userId as string };
}

const schedule = (change: Record<string, unknown> = {}) => ({
  name: "Month-end trial balance",
  reportId: "trial_balance",
  period: "previous_month",
  format: "csv",
  frequency: "monthly",
  monthDay: 1,
  hour: 7,
  recipients: [accountant.userId, colleague.userId],
  ...change,
});

beforeAll(async () => {
  container = await createTestContainer({ AUTH_RATE_LIMIT_MAX: "10000", RATE_LIMIT_MAX: "100000" });
  app = container.get<Express>(TYPES.HttpApp);
  platform = container.get<pg.Pool>(TYPES.PlatformDatabasePool);
  const staff = await new StaffFixtures(container).create(["super_admin"]);
  t = await new ProvisionedTenants(container, app, staff).create();
  const branches = await api().get("/api/v1/branches").set(owner());
  branchId = (branches.body.data as { id: string }[])[0]!.id;
  accountant = await join("Accountant", "Esi Books");
  colleague = await join("Accountant", "Kojo Ledger");
  seller = await join("Sales Executive", "Ama Sales");
});

afterAll(async () => {
  await disposeContainer(container);
});

describe("scheduled reports", () => {
  let id: string;

  it("checks the schedule against its owner and recipients", async () => {
    const post = (body: object, token = accountant.token) =>
      api().post("/api/v1/reports/schedules").set(as(token)).send(body);
    expect((await post(schedule(), seller.token)).status).toBe(403);
    const notAllowed = await post(schedule({ recipients: [seller.userId] }));
    expect(notAllowed.status).toBe(422);
    expect(notAllowed.body.error.message).toMatch(/may not run this report/);
    expect((await post(schedule({ frequency: "weekly" }))).status).toBe(422);
    expect((await post(schedule({ reportId: "dealer_lead_funnel" }))).status).toBe(403);
    expect((await post(schedule({ params: { asOf: "2026-10-30" }, period: null }))).status).toBe(
      201,
    );

    const created = await post(schedule());
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    id = created.body.data.id as string;
    expect(created.body.data).toMatchObject({
      status: "active",
      ownerId: accountant.userId,
      reportTitle: "Trial balance",
      params: {},
      lastJobId: null,
    });
    expect(new Date(created.body.data.nextRunAt as string).getUTCDate()).toBe(1);

    // The accountant sees their own; the owner sees every schedule.
    const mine = await api().get("/api/v1/reports/schedules").set(as(accountant.token));
    expect((mine.body.data as { id: string }[]).map((s) => s.id)).toContain(id);
    const all = await api().get("/api/v1/reports/schedules").set(owner());
    expect((all.body.data as Body[]).length).toBeGreaterThanOrEqual(2);
  });

  it("runs when due as its owner and sends the file to the recipients", async () => {
    await due(id);
    expect(await runDue()).toBe(1);
    const after = (await api().get(`/api/v1/reports/schedules/${id}`).set(as(accountant.token)))
      .body.data;
    expect(after.lastJobId).not.toBeNull();
    expect(new Date(after.nextRunAt as string).getTime()).toBeGreaterThan(Date.now());
    expect(await runDue()).toBe(0);

    const jobId = after.lastJobId as string;
    const [row] = await t.tenant.query<{ params: Body; requested_by: string; schedule_id: string }>(
      `select params, requested_by, schedule_id from report_jobs where id = $1`,
      [jobId],
    );
    expect(row).toMatchObject({
      params: { asOf: lastMonthEnd() },
      requested_by: accountant.userId,
      schedule_id: id,
    });
    await generate(jobId);

    // The colleague, a recipient, sees and downloads it; the seller does not.
    const listed = await api().get("/api/v1/reports/jobs").set(as(colleague.token));
    expect((listed.body.data as { id: string }[]).map((j) => j.id)).toContain(jobId);
    const seen = await api().get(`/api/v1/reports/jobs/${jobId}`).set(as(colleague.token));
    expect(seen.status).toBe(200);
    expect(seen.body.data).toMatchObject({ status: "ready", reportId: "trial_balance" });
    const file = await fetch(seen.body.data.download.url as string);
    expect(file.ok).toBe(true);
    expect((await file.text()).length).toBeGreaterThan(10);
    expect((await api().get(`/api/v1/reports/jobs/${jobId}`).set(as(seller.token))).status).toBe(
      404,
    );

    const inbox = await api().get("/api/v1/notifications").set(as(colleague.token));
    expect((inbox.body.data as { title: string }[]).map((n) => n.title)).toContain(
      "Trial balance: your scheduled report",
    );
    const emails = await t.tenant.query<{ recipient_id: string }>(
      `select recipient_id from notification_deliveries
        where rule = 'scheduled_report' and channel = 'email' order by recipient_id`,
    );
    expect(emails.map((e) => e.recipient_id).sort()).toEqual(
      [accountant.userId, colleague.userId].sort(),
    );
  });

  it("runs now, pauses and resumes", async () => {
    const before = (await api().get(`/api/v1/reports/schedules/${id}`).set(as(accountant.token)))
      .body.data;
    const now = await api().post(`/api/v1/reports/schedules/${id}/run`).set(as(accountant.token));
    expect(now.status, JSON.stringify(now.body)).toBe(202);
    expect(now.body.data.lastJobId).not.toBe(before.lastJobId);
    expect(now.body.data.nextRunAt).toBe(before.nextRunAt);
    await generate(now.body.data.lastJobId as string);

    const paused = await api()
      .post(`/api/v1/reports/schedules/${id}/pause`)
      .set(as(accountant.token));
    expect(paused.body.data.status).toBe("paused");
    await due(id);
    expect(await runDue()).toBe(0);
    expect(
      (await api().post(`/api/v1/reports/schedules/${id}/run`).set(as(accountant.token))).status,
    ).toBe(422);
    const resumed = await api()
      .post(`/api/v1/reports/schedules/${id}/resume`)
      .set(as(accountant.token));
    expect(resumed.body.data.status).toBe("active");
    expect(new Date(resumed.body.data.nextRunAt as string).getTime()).toBeGreaterThan(Date.now());

    const changed = await api()
      .put(`/api/v1/reports/schedules/${id}`)
      .set(owner())
      .send(schedule({ frequency: "daily", monthDay: null, format: "xlsx" }));
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect(changed.body.data).toMatchObject({ frequency: "daily", ownerId: accountant.userId });
  });

  it("pauses a schedule whose owner was disabled", async () => {
    const disabled = await api()
      .post(`/api/v1/users/${accountant.userId}/disable`)
      .set(owner())
      .send({ reason: "left the company" });
    expect(disabled.status).toBe(204);
    await due(id);
    expect(await runDue()).toBe(0);
    const s = (await api().get(`/api/v1/reports/schedules/${id}`).set(owner())).body.data;
    expect(s).toMatchObject({
      status: "paused",
      lastError: "The schedule's owner may no longer run this report",
    });
    expect((await api().post(`/api/v1/reports/schedules/${id}/resume`).set(owner())).status).toBe(
      422,
    );

    const removed = await api().delete(`/api/v1/reports/schedules/${id}`).set(owner());
    expect(removed.status).toBe(204);
    expect((await api().get(`/api/v1/reports/schedules/${id}`).set(owner())).status).toBe(404);
  });
});

describe("role dashboards", () => {
  it("lists the roles and the widgets", async () => {
    const res = await api().get("/api/v1/dashboards/roles").set(owner());
    expect(res.status).toBe(200);
    expect((res.body.data.roles as { role: string }[]).map((r) => r.role)).toEqual([
      "owner",
      "fleet_manager",
      "rental_agent",
      "sales_executive",
      "accountant",
    ]);
    expect((res.body.data.widgets as Body[]).length).toBeGreaterThanOrEqual(17);
  });

  it("reads every widget of every role", async () => {
    for (const role of [
      "owner",
      "fleet_manager",
      "rental_agent",
      "sales_executive",
      "accountant",
    ]) {
      const res = await api().get(`/api/v1/dashboards/roles/${role}`).set(owner());
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const widgets = res.body.data.widgets as Body[];
      expect(widgets.length, role).toBeGreaterThanOrEqual(3);
      for (const w of widgets) expect(w.error, `${role} ${w.key}`).toBeNull();
    }
    const owners = await api().get("/api/v1/dashboards/roles/owner").set(owner());
    expect((owners.body.data.widgets as { key: string }[]).map((w) => w.key)).toEqual([
      "kpis",
      "revenue_trend",
      "vehicle_ranking",
      "alerts",
    ]);
    const trend = (owners.body.data.widgets as Body[]).find((w) => w.key === "revenue_trend");
    expect(trend.data.series).toHaveLength(12);
  });

  it("leaves out the widgets the viewer may not see", async () => {
    const res = await api().get("/api/v1/dashboards/roles/owner").set(as(seller.token));
    expect((res.body.data.widgets as { key: string }[]).map((w) => w.key)).toEqual(["alerts"]);
  });

  it("keeps the business's own widgets of a role, or the defaults", async () => {
    const put = (widgets: string[], headers = owner()) =>
      api().put("/api/v1/dashboards/roles/accountant/layout").set(headers).send({ widgets });
    expect((await put(["receivables"], as(seller.token))).status).toBe(403);
    expect((await put(["no_such_widget"])).status).toBe(422);
    expect((await put(["receivables", "receivables"])).status).toBe(422);
    const set = await put(["payments_today", "receivables"]);
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(set.body.data).toMatchObject({ role: "accountant", customised: true });
    const board = await api().get("/api/v1/dashboards/roles/accountant").set(owner());
    expect((board.body.data.widgets as { key: string }[]).map((w) => w.key)).toEqual([
      "payments_today",
      "receivables",
    ]);
    const reset = await api().delete("/api/v1/dashboards/roles/accountant/layout").set(owner());
    expect(reset.body.data).toMatchObject({ customised: false });
    expect((reset.body.data.widgets as { key: string }[]).map((w) => w.key)).toEqual([
      "receivables",
      "payments_today",
      "expense_approvals",
      "cash_sessions",
    ]);
  });
});
