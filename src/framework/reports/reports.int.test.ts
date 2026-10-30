import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { Container } from "inversify";
import type pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ITenantContext } from "../../application/ports/ITenantContext.js";
import type { Reports } from "../../application/use-cases/reporting/Reports.js";
import {
  OWNER_PASSWORD,
  ProvisionedTenants,
  type ProvisionedTenant,
} from "../../testing/fixtures/ProvisionedTenants.js";
import { StaffFixtures } from "../../testing/fixtures/StaffFixtures.js";
import { createTestContainer } from "../../testing/testContainer.js";
import { unzip } from "../../testing/unzip.js";
import { disposeContainer } from "../dependency-injection/container.js";
import { TYPES } from "../dependency-injection/types.js";

/**
 * The report engine (P8-1) end to end: the catalogue filtered by permission, a report answered
 * as JSON, CSV, XLSX and PDF files built by the job as the user who asked, downloaded through
 * their short-lived link and announced in the inbox, the per-user limit, someone else's job
 * hidden, a job whose requester lost the permission failing, and expiry removing the file.
 */
let container: Container;
let app: Express;
let platform: pg.Pool;
let t: ProvisionedTenant;
let branchId: string;
let seller: Session;

type Session = { token: string; userId: string };
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- response bodies are checked by expect()
type Body = any;

const api = () => request(app);
const as = (token: string) => ({ Authorization: `Bearer ${token}` });
const owner = () => as(t.ownerAccessToken);
const run = (report: string, body: Record<string, unknown>, headers = owner()) =>
  api().post(`/api/v1/reports/${report}/run`).set(headers).send(body);
const reports = () => container.get<Reports>(TYPES.Reports);
/** The worker's step, in the tenant's context as the job runs it. */
const generate = (jobId: string) =>
  container
    .get<ITenantContext>(TYPES.TenantContext)
    .runAs(t.tenant.id, () => reports().generate(jobId));
const job = async (id: string, headers = owner()): Promise<Body> => {
  const res = await api().get(`/api/v1/reports/jobs/${id}`).set(headers);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data;
};
const download = async (url: string) => Buffer.from(await (await fetch(url)).arrayBuffer());

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

beforeAll(async () => {
  container = await createTestContainer({ AUTH_RATE_LIMIT_MAX: "10000", RATE_LIMIT_MAX: "100000" });
  app = container.get<Express>(TYPES.HttpApp);
  platform = container.get<pg.Pool>(TYPES.PlatformDatabasePool);
  const staff = await new StaffFixtures(container).create(["super_admin"]);
  t = await new ProvisionedTenants(container, app, staff).create();
  const branches = await api().get("/api/v1/branches").set(owner());
  branchId = (branches.body.data as { id: string }[])[0]!.id;
  seller = await join("Sales Executive", "Ama Sales");
});

afterAll(async () => {
  await disposeContainer(container);
});

describe("report engine", () => {
  it("lists the reports each user may run", async () => {
    const all = await api().get("/api/v1/reports").set(owner());
    expect(all.status).toBe(200);
    const ids = (all.body.data as { id: string }[]).map((r) => r.id);
    expect(ids).toEqual(
      expect.arrayContaining(["dealer_gross_profit", "dealer_price_reductions", "trial_balance"]),
    );
    const trial = (all.body.data as Body[]).find((r) => r.id === "trial_balance");
    expect(trial).toMatchObject({
      category: "finance",
      params: [{ key: "asOf", type: "date", required: false }],
      formats: ["json", "csv", "xlsx", "pdf"],
    });
    const mine = await api().get("/api/v1/reports").set(as(seller.token));
    expect((mine.body.data as { id: string }[]).map((r) => r.id)).not.toContain("trial_balance");
    expect((await run("trial_balance", {}, as(seller.token))).status).toBe(403);
  });

  it("answers JSON at once and refuses bad parameters", async () => {
    const res = await run("trial_balance", { params: { asOf: "2026-10-30" } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const table: Body = res.body.data;
    expect(table).toMatchObject({ reportId: "trial_balance", subtitle: "As of 2026-10-30" });
    expect(table.columns.map((c: { key: string }) => c.key)).toEqual([
      "code",
      "name",
      "type",
      "debit",
      "credit",
      "balance",
    ]);
    expect(table.totals.debit.amountMinor).toBe(table.totals.credit.amountMinor);

    expect((await run("trial_balance", { params: { asOf: "30/10/2026" } })).status).toBe(422);
    expect((await run("trial_balance", { params: { other: "x" } })).status).toBe(422);
    expect((await run("dealer_gross_profit", { params: { from: "2026-10-01" } })).status).toBe(422);
    expect((await run("no_such_report", {})).status).toBe(404);
  });

  it("builds CSV, XLSX and PDF files as the user who asked", async () => {
    const files: Record<string, Body> = {};
    for (const format of ["csv", "xlsx", "pdf"]) {
      const res = await run("trial_balance", { format });
      expect(res.status, JSON.stringify(res.body)).toBe(202);
      expect(res.body.data).toMatchObject({ status: "queued", format, download: null });
      await generate(res.body.data.id as string);
      files[format] = await job(res.body.data.id as string);
    }
    for (const f of Object.values(files)) {
      expect(f).toMatchObject({ status: "ready", title: "Trial balance" });
      expect(f.download.url).toMatch(/^https?:\/\//);
      expect(f.download.filename).toMatch(/^trial_balance-\d{4}-\d{2}-\d{2}\.(csv|xlsx|pdf)$/);
    }
    const csv = await download(files.csv.download.url as string);
    expect(csv.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    expect(csv.subarray(3).toString("utf8")).toMatch(
      /^Code,Account,Type,Debit \(GHS\),Credit \(GHS\),Balance \(GHS\)\r\n/,
    );
    const sheet = unzip(await download(files.xlsx.download.url as string))
      .get("xl/worksheets/sheet1.xml")!
      .toString("utf8");
    expect(sheet).toContain("Trial balance");
    expect((await download(files.pdf.download.url as string)).subarray(0, 5).toString()).toBe(
      "%PDF-",
    );

    const listed = await api().get("/api/v1/reports/jobs").set(owner());
    expect(listed.body.data).toHaveLength(3);
    expect(listed.body.data[0].download).toBeNull();
    const inbox = await api().get("/api/v1/notifications").set(owner());
    expect(
      (inbox.body.data as { title: string }[]).filter((n) => n.title === "Trial balance is ready"),
    ).toHaveLength(3);
    // Someone else's job is not theirs to see.
    const other = await api().get(`/api/v1/reports/jobs/${files.csv.id}`).set(as(seller.token));
    expect(other.status).toBe(404);
  });

  it("limits the files a user builds at once and fails a job its requester may no longer run", async () => {
    const first = await run("trial_balance", { format: "csv" });
    const second = await run("trial_balance", { format: "pdf" });
    expect([first.status, second.status]).toEqual([202, 202]);
    const third = await run("trial_balance", { format: "xlsx" });
    expect(third.status).toBe(429);
    expect(third.body.error.code).toBe("REPORT_BUSY");

    // The job no longer matches the requester's permissions: it fails with the reason.
    await t.tenant.query(
      `update report_jobs set report_id = 'dealer_gross_profit',
         params = '{"from":"2026-10-01","to":"2026-10-30"}' where id = $1`,
      [first.body.data.id],
    );
    await t.tenant.query(`update report_jobs set requested_by = $2 where id = $1`, [
      first.body.data.id,
      seller.userId,
    ]);
    await generate(first.body.data.id as string);
    expect(await job(first.body.data.id as string, as(seller.token))).toMatchObject({
      status: "failed",
      error: "You may no longer run this report",
      download: null,
    });
    await generate(second.body.data.id as string);
    expect((await run("trial_balance", { format: "xlsx" })).status).toBe(202);
  });

  it("removes files past their seven days", async () => {
    const res = await run("trial_balance", { format: "csv" });
    const id = res.body.data.id as string;
    await generate(id);
    const ready = await job(id);
    await t.tenant.query(
      `update report_jobs set expires_at = now() - interval '1 minute' where id = $1`,
      [id],
    );
    await container
      .get<ITenantContext>(TYPES.TenantContext)
      .runAs(t.tenant.id, () => reports().sweep());
    expect(await job(id)).toMatchObject({ status: "expired", download: null });
    expect((await fetch(ready.download.url as string)).ok).toBe(false);
    const [file] = await t.tenant.query<{ status: string }>(
      `select f.status from files f join report_jobs j on j.file_id = f.id where j.id = $1`,
      [id],
    );
    expect(file!.status).toBe("deleted");
  });
});
