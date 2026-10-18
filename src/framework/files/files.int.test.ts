import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { Container } from "inversify";
import type pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IJobHandler } from "../../application/jobs/IJobHandler.js";
import {
  ProvisionedTenants,
  type ProvisionedTenant,
} from "../../testing/fixtures/ProvisionedTenants.js";
import { StaffFixtures, type TestStaff } from "../../testing/fixtures/StaffFixtures.js";
import { createTestContainer } from "../../testing/testContainer.js";
import { disposeContainer } from "../dependency-injection/container.js";
import { TYPES } from "../dependency-injection/types.js";

const CONSOLE = "/api/platform/v1";
let container: Container;
let app: Express;
let platform: pg.Pool;
let admin: TestStaff;
let t: ProvisionedTenant;
let other: ProvisionedTenant;

const api = () => request(app);
const as = (token: string) => ({ Authorization: `Bearer ${token}` });
const unique = () => randomUUID().slice(0, 8);

const png = (size = 64) => {
  const bytes = Buffer.alloc(size, 7);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  return bytes;
};
const pdf = (size = 64) => {
  const bytes = Buffer.alloc(size, 0x20);
  Buffer.from("%PDF-1.7\n").copy(bytes);
  return bytes;
};

type Upload = { method: string; url: string; headers: Record<string, string> };
/** What a browser or the mobile app does with the pre-signed URL. */
const send = (upload: Upload, body: Buffer) =>
  fetch(upload.url, { method: upload.method, headers: upload.headers, body });

async function startLogo(token: string, body: Buffer, overrides: Record<string, unknown> = {}) {
  return api()
    .post("/api/v1/files/uploads")
    .set(as(token))
    .send({
      kind: "organisation_logo",
      filename: "logo.png",
      contentType: "image/png",
      sizeBytes: body.length,
      ...overrides,
    });
}

/** Uploads and confirms a logo; returns the ready file. */
async function uploadLogo(token: string, body = png()) {
  const started = await startLogo(token, body);
  expect(started.status, JSON.stringify(started.body)).toBe(201);
  expect((await send(started.body.data.upload, body)).status).toBe(200);
  const done = await api()
    .post(`/api/v1/files/${started.body.data.file.id}/complete`)
    .set(as(token));
  expect(done.status, JSON.stringify(done.body)).toBe(200);
  return done.body.data as { id: string; url: string; status: string };
}

async function signup(): Promise<{ id: string; token: string }> {
  const res = await api()
    .post("/api/v1/applications")
    .send({
      businessName: `Docs Fleet ${unique()}`,
      businessType: "fleet",
      desiredSlug: `docs-${unique()}`,
      contactName: "Efua Asante",
      contactEmail: `docs-${unique()}@example.com`,
      contactPhone: `+23324${String(Math.floor(Math.random() * 10_000_000)).padStart(7, "0")}`,
      expectedBranches: 1,
      expectedVehicles: 3,
      acceptTerms: true,
    });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return { id: res.body.data.applicationId, token: res.body.data.accessToken };
}

beforeAll(async () => {
  container = await createTestContainer({ AUTH_RATE_LIMIT_MAX: "10000" });
  app = container.get<Express>(TYPES.HttpApp);
  platform = container.get<pg.Pool>(TYPES.PlatformDatabasePool);
  admin = await new StaffFixtures(container).create(["super_admin"]);
  const tenants = new ProvisionedTenants(container, app, admin);
  t = await tenants.create();
  other = await tenants.create();
});

afterAll(async () => {
  await disposeContainer(container);
});

describe("tenant uploads and the business logo", () => {
  it("uploads a logo straight to storage, serves it publicly and shows it in tenant-config", async () => {
    const body = png(200);
    const logo = await uploadLogo(t.ownerAccessToken, body);
    expect(logo.status).toBe("ready");
    const served = await fetch(logo.url);
    expect(served.status).toBe(200);
    expect(Buffer.from(await served.arrayBuffer())).toEqual(body);

    const set = await api()
      .put("/api/v1/organisation/logo")
      .set(as(t.ownerAccessToken))
      .send({ fileId: logo.id });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(set.body.data.logo).toEqual({ fileId: logo.id, url: logo.url });
    const config = await api().get(`/api/v1/public/tenant-config?slug=${t.slug}`);
    expect(config.body.data.tenant.logoUrl).toBe(logo.url);

    // Replacing the logo deletes the previous file and its bytes.
    const next = await uploadLogo(t.ownerAccessToken);
    await api()
      .put("/api/v1/organisation/logo")
      .set(as(t.ownerAccessToken))
      .send({ fileId: next.id })
      .expect(200);
    expect((await fetch(logo.url)).status).not.toBe(200);
    expect((await api().get(`/api/v1/files/${logo.id}`).set(as(t.ownerAccessToken))).status).toBe(
      404,
    );
    await api()
      .put("/api/v1/organisation/logo")
      .set(as(t.ownerAccessToken))
      .send({ fileId: null })
      .expect(200);
    expect(
      (await api().get(`/api/v1/public/tenant-config?slug=${t.slug}`)).body.data.tenant.logoUrl,
    ).toBeNull();
  });

  it("refuses a file that is not what was announced, and deletes it", async () => {
    const started = await startLogo(t.ownerAccessToken, pdf());
    const id = started.body.data.file.id as string;
    const early = await api().post(`/api/v1/files/${id}/complete`).set(as(t.ownerAccessToken));
    expect([early.status, early.body.error.code]).toEqual([409, "FILE_STATE"]);

    expect((await send(started.body.data.upload, pdf())).status).toBe(200);
    const done = await api().post(`/api/v1/files/${id}/complete`).set(as(t.ownerAccessToken));
    expect([done.status, done.body.error.code]).toEqual([400, "FILE_REJECTED"]);
    expect((await api().get(`/api/v1/files/${id}`).set(as(t.ownerAccessToken))).status).toBe(404);
    const logo = await api()
      .put("/api/v1/organisation/logo")
      .set(as(t.ownerAccessToken))
      .send({ fileId: id });
    expect(logo.status).toBe(409);
  });

  it("enforces the kind's rules and the announced size", async () => {
    const svg = await startLogo(t.ownerAccessToken, png(), { contentType: "image/svg+xml" });
    expect([svg.status, svg.body.error.code]).toEqual([400, "FILE_REJECTED"]);
    const big = await startLogo(t.ownerAccessToken, png(), { sizeBytes: 3 * 1024 * 1024 });
    expect([big.status, big.body.error.code]).toEqual([400, "FILE_REJECTED"]);
    const platformKind = await startLogo(t.ownerAccessToken, png(), { kind: "partner_document" });
    expect(platformKind.status).toBe(400);

    // The signature covers the size: sending more bytes than announced is refused by storage.
    const started = await startLogo(t.ownerAccessToken, png(64));
    expect((await send(started.body.data.upload, png(65))).status).toBe(403);
  });

  it("keeps files inside their tenant", async () => {
    const logo = await uploadLogo(t.ownerAccessToken);
    const foreign = await api().get(`/api/v1/files/${logo.id}`).set(as(other.ownerAccessToken));
    expect(foreign.status).toBe(404);
    const attach = await api()
      .put("/api/v1/organisation/logo")
      .set(as(other.ownerAccessToken))
      .send({ fileId: logo.id });
    expect(attach.status).toBe(404);
  });
});

describe("application KYC documents", () => {
  it("lets the applicant attach documents and staff read them through signed links", async () => {
    const application = await signup();
    const header = { "X-Application-Token": application.token };
    const body = pdf(120);
    const started = await api()
      .post(`/api/v1/applications/${application.id}/documents`)
      .set(header)
      .send({
        filename: "Business certificate.pdf",
        contentType: "application/pdf",
        sizeBytes: body.length,
      });
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    const fileId = started.body.data.file.id as string;
    expect((await send(started.body.data.upload, body)).status).toBe(200);

    const otherApplication = await signup();
    const foreign = await api()
      .post(`/api/v1/applications/${otherApplication.id}/documents/${fileId}/complete`)
      .set({ "X-Application-Token": otherApplication.token });
    expect(foreign.status).toBe(404);
    const wrongToken = await api()
      .get(`/api/v1/applications/${application.id}/documents`)
      .set({ "X-Application-Token": otherApplication.token });
    expect(wrongToken.status).toBe(404);

    await api()
      .post(`/api/v1/applications/${application.id}/documents/${fileId}/complete`)
      .set(header)
      .expect(200);
    const mine = await api().get(`/api/v1/applications/${application.id}/documents`).set(header);
    expect(mine.body.data.map((d: { id: string }) => d.id)).toEqual([fileId]);

    const review = await api()
      .get(`${CONSOLE}/applications/${application.id}/documents`)
      .set(as(admin.accessToken));
    expect(review.status).toBe(200);
    const document = review.body.data[0];
    expect(document).toMatchObject({ filename: "Business certificate.pdf", visibility: "private" });
    const download = await fetch(document.url);
    expect(download.status).toBe(200);
    expect(download.headers.get("content-disposition")).toContain("attachment");
    expect(Buffer.from(await download.arrayBuffer())).toEqual(body);
    // The object itself is not public.
    const key = new URL(document.url).pathname;
    expect((await fetch(`${new URL(document.url).origin}${key}`)).status).toBe(403);

    await platform.query("update tenant_applications set status = 'rejected' where id = $1", [
      application.id,
    ]);
    const closed = await api()
      .post(`/api/v1/applications/${application.id}/documents`)
      .set(header)
      .send({ filename: "late.pdf", contentType: "application/pdf", sizeBytes: 10 });
    expect([closed.status, closed.body.error.code]).toEqual([409, "FILE_STATE"]);
  });
});

describe("partner documents", () => {
  it("are kept by staff, listed with signed links and removed with an audited reason", async () => {
    const created = await api()
      .post(`${CONSOLE}/partners`)
      .set(as(admin.accessToken))
      .send({
        name: `Docs Partner ${unique()}`,
        kind: "company",
        contactName: "Yaw Boateng",
        email: `docs-partner-${unique()}@example.com`,
        phone: `+23324${String(Math.floor(Math.random() * 10_000_000)).padStart(7, "0")}`,
      });
    const partnerId = created.body.data.id as string;
    const body = pdf(90);
    const started = await api()
      .post(`${CONSOLE}/partners/${partnerId}/documents`)
      .set(as(admin.accessToken))
      .send({ filename: "agreement.pdf", contentType: "application/pdf", sizeBytes: body.length });
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    const fileId = started.body.data.file.id as string;
    await send(started.body.data.upload, body);
    await api()
      .post(`${CONSOLE}/partners/${partnerId}/documents/${fileId}/complete`)
      .set(as(admin.accessToken))
      .expect(200);
    const list = await api()
      .get(`${CONSOLE}/partners/${partnerId}/documents`)
      .set(as(admin.accessToken));
    expect(list.body.data).toEqual([expect.objectContaining({ id: fileId, status: "ready" })]);

    await api()
      .delete(`${CONSOLE}/partners/${partnerId}/documents/${fileId}`)
      .set(as(admin.accessToken))
      .send({ reason: "Superseded by v2" })
      .expect(204);
    expect(
      (await api().get(`${CONSOLE}/partners/${partnerId}/documents`).set(as(admin.accessToken)))
        .body.data,
    ).toEqual([]);
    const { rows } = await platform.query<{ action: string }>(
      "select action from platform_audit_logs where entity_id = $1 order by id",
      [partnerId],
    );
    expect(rows.map((r) => r.action)).toEqual(
      expect.arrayContaining(["partner.document_added", "partner.document_removed"]),
    );
  });
});

describe("abandoned uploads", () => {
  it("are removed by the daily sweep", async () => {
    const application = await signup();
    const started = await api()
      .post(`/api/v1/applications/${application.id}/documents`)
      .set({ "X-Application-Token": application.token })
      .send({ filename: "never.pdf", contentType: "application/pdf", sizeBytes: 50 });
    const fileId = started.body.data.file.id as string;
    await platform.query(
      "update platform_files set created_at = now() - interval '2 days' where id = $1",
      [fileId],
    );
    const sweep = container
      .get<IJobHandler[]>(TYPES.JobHandlers)
      .find((h) => h.job === "files.sweep") as IJobHandler<"files.sweep">;
    await sweep.handle({}, { jobId: "test", attempt: 1 });
    const { rows } = await platform.query<{ status: string }>(
      "select status from platform_files where id = $1",
      [fileId],
    );
    expect(rows[0]!.status).toBe("deleted");
  });
});
