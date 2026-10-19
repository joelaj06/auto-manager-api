import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { Container } from "inversify";
import type pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  OWNER_PASSWORD,
  ProvisionedTenants,
  type ProvisionedTenant,
} from "../../testing/fixtures/ProvisionedTenants.js";
import { StaffFixtures } from "../../testing/fixtures/StaffFixtures.js";
import { createTestContainer } from "../../testing/testContainer.js";
import { disposeContainer } from "../dependency-injection/container.js";
import { TYPES } from "../dependency-injection/types.js";

let container: Container;
let app: Express;
let platform: pg.Pool;
let t: ProvisionedTenant;
let hq: string;
let kumasi: string;
let officer: string;

const api = () => request(app);
const as = (token: string) => ({ Authorization: `Bearer ${token}` });
const owner = () => as(t.ownerAccessToken);
const mobile = () => `024${String(Math.floor(Math.random() * 10_000_000)).padStart(7, "0")}`;
const ghanaCard = () => `GHA-${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}-1`;
const png = () => {
  const bytes = Buffer.alloc(64, 7);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  return bytes;
};

async function fleetOfficer(branchId: string): Promise<string> {
  const roles = await api().get("/api/v1/roles").set(owner());
  const roleId = (roles.body.data as { id: string; systemKey: string | null }[]).find(
    (r) => r.systemKey === "fleet_officer",
  )!.id;
  const email = `officer-${randomUUID().slice(0, 8)}@example.com`;
  await api()
    .post("/api/v1/users/invitations")
    .set(owner())
    .send({ name: "Fleet Officer", email, branchIds: [branchId], roles: [{ roleId, branchId }] });
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
  return accepted.body.data.accessToken as string;
}

const newDriver = (body: Record<string, unknown> = {}, token = t.ownerAccessToken) =>
  api()
    .post("/api/v1/drivers")
    .set(as(token))
    .send({
      firstName: "Kwame",
      lastName: "Mensah",
      phone: mobile(),
      ghanaCardNumber: ghanaCard(),
      licenceNumber: `DL-${randomUUID().slice(0, 6)}`,
      licenceClass: "B",
      licenceExpiresOn: "2030-01-01",
      ...body,
    });

beforeAll(async () => {
  container = await createTestContainer({ AUTH_RATE_LIMIT_MAX: "10000" });
  app = container.get<Express>(TYPES.HttpApp);
  platform = container.get<pg.Pool>(TYPES.PlatformDatabasePool);
  const staff = await new StaffFixtures(container).create(["super_admin"]);
  t = await new ProvisionedTenants(container, app, staff).create();
  const branches = await api().get("/api/v1/branches").set(owner());
  hq = (branches.body.data as { id: string; isDefault: boolean }[]).find((b) => b.isDefault)!.id;
  kumasi = (await api().post("/api/v1/branches").set(owner()).send({ code: "KSI", name: "Kumasi" }))
    .body.data.id;
  officer = await fleetOfficer(kumasi);
});

afterAll(async () => {
  await disposeContainer(container);
});

describe("drivers", () => {
  it("registers an applicant with a code and normalised details, once per phone", async () => {
    const res = await newDriver({ phone: "024 555 0101", ghanaCardNumber: "gha 000000001 7" });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data).toMatchObject({
      code: "DRV-00001",
      phone: "+233245550101",
      ghanaCardNumber: "GHA-000000001-7",
      status: "applicant",
      branchId: hq,
    });
    const again = await newDriver({ phone: "+233 24 555 0101" });
    expect([again.status, again.body.error.code]).toEqual([409, "PARTY_EXISTS"]);
  });

  it("activates only once onboarding is complete, then suspends and terminates with reasons", async () => {
    const driver = (await newDriver()).body.data;
    expect(driver.onboarding.find((i: { key: string }) => i.key === "guarantors").done).toBe(false);
    const early = await api().post(`/api/v1/drivers/${driver.id}/activate`).set(owner()).send({});
    expect([early.status, early.body.error.message]).toEqual([
      422,
      expect.stringMatching(/1 guarantor/),
    ]);

    const guarantor = await api()
      .post(`/api/v1/drivers/${driver.id}/guarantors`)
      .set(owner())
      .send({ name: "Yaw Boateng", phone: mobile(), relationship: "Uncle" });
    expect(guarantor.status, JSON.stringify(guarantor.body)).toBe(201);
    const active = await api().post(`/api/v1/drivers/${driver.id}/activate`).set(owner()).send({});
    expect(active.body.data).toMatchObject({ status: "active", hiredOn: expect.any(String) });

    const reinstate = await api()
      .post(`/api/v1/drivers/${driver.id}/reinstate`)
      .set(owner())
      .send({ reason: "nothing to reinstate" });
    expect(reinstate.status).toBe(422);
    await api()
      .post(`/api/v1/drivers/${driver.id}/suspend`)
      .set(owner())
      .send({ reason: "Three days of shortfalls" });
    await api()
      .post(`/api/v1/drivers/${driver.id}/terminate`)
      .set(owner())
      .send({ reason: "Left the company" });
    const history = await api().get(`/api/v1/drivers/${driver.id}/status-history`).set(owner());
    expect((history.body.data as { to: string }[]).map((h) => h.to)).toEqual([
      "terminated",
      "suspended",
      "active",
      "applicant",
    ]);
  });

  it("keeps a branch fleet officer to their branch, without identity documents or termination", async () => {
    const atHq = (await newDriver()).body.data;
    const own = await newDriver({}, officer);
    expect(own.status, JSON.stringify(own.body)).toBe(201);
    expect(own.body.data.branchId).toBe(kumasi);
    expect(own.body.data.ghanaCardNumber).toMatch(/^GHA-•••••\d{4}-\d$/);

    const list = await api().get("/api/v1/drivers").set(as(officer));
    const ids = (list.body.data as { id: string }[]).map((d) => d.id);
    expect(ids).toContain(own.body.data.id);
    expect(ids).not.toContain(atHq.id);
    expect((await api().get(`/api/v1/drivers/${atHq.id}`).set(as(officer))).status).toBe(404);
    expect(
      (await api().get(`/api/v1/drivers/${own.body.data.id}/documents`).set(as(officer))).status,
    ).toBe(403);
    expect(
      (
        await api()
          .post(`/api/v1/drivers/${own.body.data.id}/terminate`)
          .set(as(officer))
          .send({ reason: "not allowed" })
      ).status,
    ).toBe(403);
  });

  it("keeps identity documents with scans and checks required ones at onboarding", async () => {
    await api()
      .patch("/api/v1/settings/drivers")
      .set(owner())
      .send({ requiredGuarantors: 0, requiredDocuments: ["police_report"] });
    const driver = (await newDriver()).body.data;
    expect(
      (await api().post(`/api/v1/drivers/${driver.id}/activate`).set(owner()).send({})).status,
    ).toBe(422);

    const doc = await api()
      .post(`/api/v1/drivers/${driver.id}/documents`)
      .set(owner())
      .send({ type: "police_report", number: "PR-2026-77", issuedOn: "2026-10-01" });
    expect(doc.status, JSON.stringify(doc.body)).toBe(201);
    const started = await api()
      .post(`/api/v1/drivers/${driver.id}/documents/${doc.body.data.id}/files`)
      .set(owner())
      .send({ filename: "report.png", contentType: "image/png", sizeBytes: png().length });
    const { method, url, headers } = started.body.data.upload;
    expect((await fetch(url, { method, headers, body: png() })).ok).toBe(true);
    await api()
      .post(
        `/api/v1/drivers/${driver.id}/documents/${doc.body.data.id}/files/${started.body.data.file.id}/complete`,
      )
      .set(owner());
    const docs = await api().get(`/api/v1/drivers/${driver.id}/documents`).set(owner());
    expect(docs.body.data[0]).toMatchObject({
      type: "police_report",
      files: [{ status: "ready" }],
    });

    const active = await api().post(`/api/v1/drivers/${driver.id}/activate`).set(owner()).send({});
    expect(active.status, JSON.stringify(active.body)).toBe(200);
    await api()
      .patch("/api/v1/settings/drivers")
      .set(owner())
      .send({ requiredGuarantors: 1, requiredDocuments: [] });
  });

  it("lists drivers whose licence expires soon and finds drivers by phone", async () => {
    const soon = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
    const phone = mobile();
    const driver = (await newDriver({ licenceExpiresOn: soon, phone })).body.data;
    const expiring = await api().get("/api/v1/drivers/expiring-licences?days=30").set(owner());
    expect((expiring.body.data as { id: string }[]).map((d) => d.id)).toContain(driver.id);
    const found = await api().get(`/api/v1/drivers?search=${phone}`).set(owner());
    expect((found.body.data as { id: string }[]).map((d) => d.id)).toEqual([driver.id]);
  });

  it("blocks deactivating a branch that still has drivers", async () => {
    const branch = (
      await api().post("/api/v1/branches").set(owner()).send({ code: "TML", name: "Tamale" })
    ).body.data.id;
    const driver = (await newDriver({ branchId: branch })).body.data;
    const blocked = await api()
      .post(`/api/v1/branches/${branch}/deactivate`)
      .set(owner())
      .send({ reason: "closing the yard" });
    expect(blocked.body.error.message).toMatch(/1 driver is still in this branch/);
    await api().patch(`/api/v1/drivers/${driver.id}`).set(owner()).send({ branchId: hq });
    const done = await api()
      .post(`/api/v1/branches/${branch}/deactivate`)
      .set(owner())
      .send({ reason: "closing the yard" });
    expect(done.status, JSON.stringify(done.body)).toBe(204);
  });
});

describe("customers", () => {
  it("registers individuals and companies with credit terms, once per email", async () => {
    const person = await api()
      .post("/api/v1/customers")
      .set(owner())
      .send({ type: "individual", firstName: "Ama", lastName: "Owusu", email: "AMA@example.com" });
    expect(person.status, JSON.stringify(person.body)).toBe(201);
    expect(person.body.data).toMatchObject({ code: "CUS-00001", name: "Ama Owusu" });
    const company = await api().post("/api/v1/customers").set(owner()).send({
      type: "corporate",
      companyName: "Acme Logistics Ltd",
      phone: mobile(),
      creditLimit: "5000.00",
      paymentTermsDays: 30,
    });
    expect(company.body.data).toMatchObject({
      name: "Acme Logistics Ltd",
      creditLimit: { amountMinor: 500_000, currency: "GHS" },
    });
    const twice = await api()
      .post("/api/v1/customers")
      .set(owner())
      .send({ type: "individual", firstName: "A", lastName: "B", email: "ama@example.com" });
    expect([twice.status, twice.body.error.code]).toEqual([409, "PARTY_EXISTS"]);
    const found = await api().get("/api/v1/customers?search=acme").set(owner());
    expect(found.body.data[0].id).toBe(company.body.data.id);
  });

  it("blacklists and clears with reasons kept in the history", async () => {
    const c = (
      await api()
        .post("/api/v1/customers")
        .set(owner())
        .send({ type: "individual", firstName: "Kofi", lastName: "Asante", phone: mobile() })
    ).body.data;
    const risk = (status: string, reason: string) =>
      api().post(`/api/v1/customers/${c.id}/risk`).set(owner()).send({ status, reason });
    expect((await risk("blacklisted", "Unpaid damage")).body.data).toMatchObject({
      riskStatus: "blacklisted",
      riskReason: "Unpaid damage",
    });
    const listed = await api().get("/api/v1/customers?riskStatus=blacklisted").set(owner());
    expect((listed.body.data as { id: string }[]).map((x) => x.id)).toContain(c.id);
    await risk("ok", "Paid in full");
    const history = await api().get(`/api/v1/customers/${c.id}/risk-history`).set(owner());
    expect((history.body.data as { to: string; reason: string }[]).map((h) => h.to)).toEqual([
      "ok",
      "blacklisted",
    ]);
  });
});

describe("suppliers", () => {
  it("adds suppliers once per name and hides deactivated ones by default", async () => {
    const res = await api()
      .post("/api/v1/suppliers")
      .set(owner())
      .send({
        name: "Kantanka Parts",
        type: "parts",
        payout: { momoNumber: mobile(), momoNetwork: "mtn" },
      });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data.code).toBe("SUP-0001");
    expect(
      (
        await api()
          .post("/api/v1/suppliers")
          .set(owner())
          .send({ name: "kantanka parts", type: "parts" })
      ).status,
    ).toBe(409);
    await api().patch(`/api/v1/suppliers/${res.body.data.id}`).set(owner()).send({ active: false });
    expect((await api().get("/api/v1/suppliers").set(owner())).body.data).toEqual([]);
    expect(
      (await api().get("/api/v1/suppliers?includeInactive=true").set(owner())).body.data,
    ).toHaveLength(1);
  });
});
