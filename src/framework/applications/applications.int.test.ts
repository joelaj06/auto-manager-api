import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { Container } from "inversify";
import type pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ISmsSender } from "../../application/ports/ISmsSender.js";
import { StaffFixtures, type TestStaff } from "../../testing/fixtures/StaffFixtures.js";
import { createTestContainer } from "../../testing/testContainer.js";
import { disposeContainer } from "../dependency-injection/container.js";
import { TYPES } from "../dependency-injection/types.js";

const PUBLIC = "/api/v1/applications";
const CONSOLE = "/api/platform/v1/applications";

/** Captures SMS instead of sending them. */
const sms: { to: string; text: string }[] = [];
const capturingSms: ISmsSender = {
  send: (to, text) => {
    sms.push({ to, text });
    return Promise.resolve(`test-${sms.length}`);
  },
};

let container: Container;
let app: Express;
let platform: pg.Pool;
let admin: TestStaff;
let support: TestStaff;

const api = () => request(app);
const bearer = (staff: TestStaff) => ({ Authorization: `Bearer ${staff.accessToken}` });

function applicationInput(overrides: Record<string, unknown> = {}) {
  const unique = randomUUID().slice(0, 8);
  return {
    businessName: `Kofi Motors ${unique}`,
    businessType: "rental",
    desiredSlug: `kofi-${unique}`,
    contactName: "Kofi Mensah",
    contactEmail: `kofi-${unique}@example.com`,
    contactPhone: `024${String(Math.floor(Math.random() * 10_000_000)).padStart(7, "0")}`,
    expectedBranches: 2,
    expectedVehicles: 25,
    acceptTerms: true,
    ...overrides,
  };
}

/** The latest email of a template to an address (no worker runs in tests; bodies are kept). */
async function lastEmail(to: string, template: string): Promise<string> {
  const { rows } = await platform.query<{ body_text: string }>(
    `select body_text from email_deliveries
      where recipient = $1 and template = $2 order by created_at desc limit 1`,
    [to.toLowerCase(), template],
  );
  if (rows[0] === undefined) throw new Error(`No ${template} email to ${to}`);
  return rows[0].body_text;
}

const emailCode = async (to: string) =>
  /verification code is (\d{6})/.exec(await lastEmail(to, "application.verify_email"))![1]!;
const smsCode = (phone: string) =>
  /^(\d{6}) is your/.exec([...sms].reverse().find((m) => m.to === phone)!.text)![1]!;

/** Applies and verifies email and phone; returns the id, token and normalised phone. */
async function applyAndVerify(overrides: Record<string, unknown> = {}) {
  const input = applicationInput(overrides);
  const created = await api().post(PUBLIC).send(input);
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const { applicationId, accessToken } = created.body.data as {
    applicationId: string;
    accessToken: string;
  };
  const phone = sms.at(-1)!.to;
  const verify = (channel: string, code: string) =>
    api()
      .post(`${PUBLIC}/${applicationId}/verify`)
      .set("X-Application-Token", accessToken)
      .send({ channel, code });
  expect((await verify("email", await emailCode(input.contactEmail))).status).toBe(200);
  const done = await verify("phone", smsCode(phone));
  expect(done.body.data.status).toBe("pending_review");
  return { applicationId, accessToken, input, phone };
}

beforeAll(async () => {
  container = await createTestContainer({ AUTH_RATE_LIMIT_MAX: "10000" });
  container.rebind<ISmsSender>(TYPES.SmsSender).toConstantValue(capturingSms);
  app = container.get<Express>(TYPES.HttpApp);
  platform = container.get<pg.Pool>(TYPES.PlatformDatabasePool);
  const staff = new StaffFixtures(container);
  admin = await staff.create(["super_admin"]);
  support = await staff.create(["support"]);
});

afterAll(async () => {
  await disposeContainer(container);
});

describe("public signup", () => {
  it("checks slug availability and refuses reserved names", async () => {
    const free = await api()
      .get(`${PUBLIC}/slug-availability`)
      .query({ slug: `fresh-${randomUUID().slice(0, 6)}` });
    expect(free.body.data.available).toBe(true);
    const reserved = await api().get(`${PUBLIC}/slug-availability`).query({ slug: "admin" });
    expect([reserved.status, reserved.body.error.code]).toEqual([400, "INVALID_SLUG"]);
  });

  it("creates an application, verifies email and phone, and queues it for review", async () => {
    const input = applicationInput({
      contactPhone: "024 555 0001".replace("0001", String(Date.now()).slice(-4)),
    });
    const created = await api().post(PUBLIC).send(input);
    expect(created.status).toBe(201);
    const { applicationId, accessToken, status } = created.body.data;
    expect(status).toBe("pending_verification");
    expect(sms.at(-1)!.to).toMatch(/^\+23324555/);

    const wrongToken = await api()
      .get(`${PUBLIC}/${applicationId}`)
      .set("X-Application-Token", "x".repeat(43));
    expect([wrongToken.status, wrongToken.body.error.code]).toEqual([404, "APPLICATION_NOT_FOUND"]);

    const badCode = await api()
      .post(`${PUBLIC}/${applicationId}/verify`)
      .set("X-Application-Token", accessToken)
      .send({ channel: "email", code: "000000" });
    expect(badCode.body.error.code).toBe("OTP_INVALID");

    await api()
      .post(`${PUBLIC}/${applicationId}/verify`)
      .set("X-Application-Token", accessToken)
      .send({ channel: "email", code: await emailCode(input.contactEmail) });
    const done = await api()
      .post(`${PUBLIC}/${applicationId}/verify`)
      .set("X-Application-Token", accessToken)
      .send({ channel: "phone", code: smsCode(sms.at(-1)!.to) });
    expect(done.body.data).toMatchObject({
      status: "pending_review",
      emailVerified: true,
      phoneVerified: true,
    });
    expect(await lastEmail(input.contactEmail, "application.received")).toContain(
      input.businessName,
    );
  });

  it("refuses duplicates in progress and taken slugs", async () => {
    const first = applicationInput();
    expect((await api().post(PUBLIC).send(first)).status).toBe(201);
    const again = await api()
      .post(PUBLIC)
      .send({ ...applicationInput(), contactEmail: first.contactEmail });
    expect([again.status, again.body.error.code]).toEqual([409, "APPLICATION_EXISTS"]);
    const slug = await api()
      .post(PUBLIC)
      .send({ ...applicationInput(), desiredSlug: first.desiredSlug });
    expect([slug.status, slug.body.error.code]).toEqual([409, "SLUG_TAKEN"]);
  });

  it("validates input", async () => {
    const res = await api()
      .post(PUBLIC)
      .send({ ...applicationInput(), contactPhone: "12", acceptTerms: false });
    expect(res.status).toBe(400);
    expect(res.body.error.details.map((d: { field: string }) => d.field)).toContain(
      "body.acceptTerms",
    );
  });

  it("flags disposable emails as high risk", async () => {
    const created = await api()
      .post(PUBLIC)
      .send(applicationInput({ contactEmail: `x-${randomUUID().slice(0, 6)}@mailinator.com` }));
    const detail = await api()
      .get(`${CONSOLE}/${created.body.data.applicationId}`)
      .set(bearer(admin));
    expect(detail.body.data.riskLevel).toBe("high");
    expect(detail.body.data.riskSignals.map((s: { code: string }) => s.code)).toContain(
      "disposable_email",
    );
  });
});

describe("review queue", () => {
  it("lists, requests information, takes the applicant's reply and approves", async () => {
    const { applicationId, accessToken, input } = await applyAndVerify();

    const queue = await api()
      .get(CONSOLE)
      .query({ status: "pending_review", search: input.desiredSlug })
      .set(bearer(admin));
    expect(queue.body.data.map((a: { id: string }) => a.id)).toEqual([applicationId]);

    const asked = await api()
      .post(`${CONSOLE}/${applicationId}/request-info`)
      .set(bearer(admin))
      .send({ message: "Please send your business registration number" });
    expect(asked.status).toBe(204);

    // The email carries a fresh private link; the old token no longer works.
    expect(
      (await api().get(`${PUBLIC}/${applicationId}`).set("X-Application-Token", accessToken))
        .status,
    ).toBe(404);
    const newToken = /#token=([A-Za-z0-9_-]+)/.exec(
      await lastEmail(input.contactEmail, "application.info_requested"),
    )![1]!;
    const status = await api()
      .get(`${PUBLIC}/${applicationId}`)
      .set("X-Application-Token", newToken);
    expect(status.body.data.status).toBe("needs_info");
    expect(status.body.data.messages.at(-1)).toMatchObject({
      type: "info_requested",
      from: "us",
      message: "Please send your business registration number",
    });

    const replied = await api()
      .post(`${PUBLIC}/${applicationId}/reply`)
      .set("X-Application-Token", newToken)
      .send({ message: "It is CS123456789", corrections: { registrationNumber: "CS123456789" } });
    expect(replied.body.data.status).toBe("pending_review");

    const denied = await api()
      .post(`${CONSOLE}/${applicationId}/approve`)
      .set(bearer(support))
      .send({});
    expect([denied.status, denied.body.error.code]).toEqual([403, "FORBIDDEN"]);

    const approved = await api()
      .post(`${CONSOLE}/${applicationId}/approve`)
      .set(bearer(admin))
      .send({ trialDays: 30, note: "Registration verified" });
    expect(approved.status).toBe(204);

    const detail = await api().get(`${CONSOLE}/${applicationId}`).set(bearer(admin));
    expect(detail.body.data).toMatchObject({
      status: "approved",
      registrationNumber: "CS123456789",
      reviewedBy: admin.id,
      approvalOptions: { plan: "standard", trialDays: 30 },
    });
    expect(detail.body.data).not.toHaveProperty("accessTokenHash");
    expect(detail.body.data.events.map((e: { type: string }) => e.type)).toEqual([
      "submitted",
      "verified",
      "verified",
      "info_requested",
      "applicant_replied",
      "approved",
    ]);
    expect(await lastEmail(input.contactEmail, "application.approved")).toContain("approved");

    const again = await api()
      .post(`${CONSOLE}/${applicationId}/approve`)
      .set(bearer(admin))
      .send({});
    expect([again.status, again.body.error.code]).toEqual([409, "APPLICATION_STATE"]);
  });

  it("rejects with a reason and blocks re-applying for a while", async () => {
    const { applicationId, input } = await applyAndVerify();
    const rejected = await api()
      .post(`${CONSOLE}/${applicationId}/reject`)
      .set(bearer(admin))
      .send({ reason: "We could not verify this business", notifyApplicantOfReason: true });
    expect(rejected.status).toBe(204);
    expect(await lastEmail(input.contactEmail, "application.rejected")).toContain(
      "could not verify",
    );

    const reapply = await api()
      .post(PUBLIC)
      .send({ ...applicationInput(), contactEmail: input.contactEmail });
    expect([reapply.status, reapply.body.error.code]).toEqual([409, "REAPPLY_LATER"]);
    // The slug is free again after a rejection.
    const slug = await api().get(`${PUBLIC}/slug-availability`).query({ slug: input.desiredSlug });
    expect(slug.body.data.available).toBe(true);
  });

  it("creates assisted applications whose link goes only to the client", async () => {
    const input = applicationInput();
    const created = await api().post(CONSOLE).set(bearer(admin)).send(input);
    expect(created.status).toBe(201);
    expect(created.body.data).not.toHaveProperty("accessToken");
    expect(await lastEmail(input.contactEmail, "application.verify_email")).toMatch(/#token=/);
    const detail = await api()
      .get(`${CONSOLE}/${created.body.data.applicationId}`)
      .set(bearer(admin));
    expect(detail.body.data).toMatchObject({ source: "assisted", createdByStaffId: admin.id });
  });

  it("assigns reviewers and audits decisions", async () => {
    const { applicationId } = await applyAndVerify();
    const assigned = await api()
      .post(`${CONSOLE}/${applicationId}/assign`)
      .set(bearer(admin))
      .send({ assigneeId: support.id });
    expect(assigned.status).toBe(204);
    const mine = await api().get(CONSOLE).query({ assignedTo: support.id }).set(bearer(support));
    expect(mine.body.data.map((a: { id: string }) => a.id)).toContain(applicationId);

    const { rows } = await platform.query(
      "select action from platform_audit_logs where entity_id = $1 order by id",
      [applicationId],
    );
    expect(rows.map((r: { action: string }) => r.action)).toContain("application.assigned");
  });
});
