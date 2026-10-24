import { randomUUID } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import type { Express } from "express";
import type { Container } from "inversify";
import type pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ComplianceDaily } from "../../application/use-cases/console/ComplianceOperations.js";
import type { TenantDataExports } from "../../application/use-cases/console/TenantDataExports.js";
import { quarterEnd, nextQuarterEnd } from "../../domain/console/Compliance.js";
import { TotpService } from "../../infrastructure/security/TotpService.js";
import {
  ProvisionedTenants,
  type ProvisionedTenant,
} from "../../testing/fixtures/ProvisionedTenants.js";
import { StaffFixtures, type TestStaff } from "../../testing/fixtures/StaffFixtures.js";
import { createTestContainer } from "../../testing/testContainer.js";
import { disposeContainer } from "../dependency-injection/container.js";
import { TYPES } from "../dependency-injection/types.js";

/**
 * Legal and operations (P4-8): terms and privacy versions accepted at sign-up and by the owner,
 * the full data export, data-protection requests and their deadlines, the public status page,
 * and the quarterly restore drill.
 */
const BASE = "/api/platform/v1";
let container: Container;
let app: Express;
let platform: pg.Pool;
let admin: TestStaff;
let support: TestStaff;
let t: ProvisionedTenant;

const api = () => request(app);
const as = (who: { accessToken: string }) => ({ Authorization: `Bearer ${who.accessToken}` });
const owner = () => ({ Authorization: `Bearer ${t.ownerAccessToken}` });
const unique = () => randomUUID().slice(0, 8);
const today = () => new Date().toISOString().slice(0, 10);

/** The names in a zip's central directory, and one entry's text. */
function unzip(zip: Buffer): Map<string, string> {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let at = zip.readUInt32LE(end + 16);
  const files = new Map<string, string>();
  for (let i = zip.readUInt16LE(end + 10); i > 0; i--) {
    const method = zip.readUInt16LE(at + 10);
    const size = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString();
    const start = local + 30 + zip.readUInt16LE(local + 26);
    const body = zip.subarray(start, start + size);
    files.set(name, (method === 8 ? inflateRawSync(body) : body).toString("utf8"));
    at += 46 + nameLength;
  }
  return files;
}

beforeAll(async () => {
  container = await createTestContainer({ AUTH_RATE_LIMIT_MAX: "10000", RATE_LIMIT_MAX: "100000" });
  app = container.get<Express>(TYPES.HttpApp);
  platform = container.get<pg.Pool>(TYPES.PlatformDatabasePool);
  const fixtures = new StaffFixtures(container);
  admin = await fixtures.create(["super_admin"]);
  support = await fixtures.create(["support"]);
  const code = new TotpService().codeAt(admin.totpSecret, new Date(Date.now() + 30_000));
  await api()
    .post(`${BASE}/auth/step-up`)
    .set(as(admin))
    .send({ password: admin.password, code })
    .expect(204);
  t = await new ProvisionedTenants(container, app, admin).create();
});

afterAll(async () => {
  await disposeContainer(container);
});

describe("terms and privacy", () => {
  let termsId: string;

  it("are versioned, published, and accepted with an application", async () => {
    for (const kind of ["terms", "privacy"] as const) {
      const draft = await api()
        .post(`${BASE}/legal-documents`)
        .set(as(admin))
        .send({
          kind,
          version: `2026.${unique()}`,
          title: kind === "terms" ? "Terms of service" : "Privacy policy",
          body: `# ${kind}\n\nThese are the ${kind} of Autoforce Manager.`,
        });
      expect(draft.status, JSON.stringify(draft.body)).toBe(201);
      const refused = await api()
        .post(`${BASE}/legal-documents/${draft.body.data.id}/publish`)
        .set(as(support))
        .send({});
      expect(refused.status).toBe(403);
      await api()
        .post(`${BASE}/legal-documents/${draft.body.data.id}/publish`)
        .set(as(admin))
        .send({})
        .expect(200);
      if (kind === "terms") termsId = draft.body.data.id as string;
    }
    const current = await api().get("/api/v1/public/legal/terms");
    expect(current.body.data).toMatchObject({ id: termsId, title: "Terms of service" });
    const changed = await api()
      .patch(`${BASE}/legal-documents/${termsId}`)
      .set(as(admin))
      .send({ title: "Changed after publishing" });
    expect(changed.body.error.code).toBe("LEGAL_RULE");

    const signup = await api()
      .post("/api/v1/applications")
      .send({
        businessName: `Legal Fleet ${unique()}`,
        businessType: "fleet",
        desiredSlug: `legal-${unique()}`,
        contactName: "Kwame Owusu",
        contactEmail: `legal-${unique()}@example.com`,
        contactPhone: `+23324${String(Math.floor(Math.random() * 10_000_000)).padStart(7, "0")}`,
        expectedBranches: 1,
        expectedVehicles: 5,
        acceptTerms: true,
      });
    expect(signup.status, JSON.stringify(signup.body)).toBe(201);
    const { rows } = await platform.query(
      "select document_id from legal_acceptances where application_id = $1",
      [signup.body.data.applicationId],
    );
    expect(rows).toHaveLength(2);
  });

  it("asks the owner to accept the versions in force, and records it", async () => {
    const before = await api().get("/api/v1/legal").set(owner());
    expect(before.body.data.actionRequired).toBe(true);
    const ids = (before.body.data.documents as { id: string }[]).map((d) => d.id);
    const after = await api().post("/api/v1/legal/accept").set(owner()).send({ documentIds: ids });
    expect(after.status, JSON.stringify(after.body)).toBe(200);
    expect(after.body.data.actionRequired).toBe(false);
    const summary = await api().get(`${BASE}/legal-documents/${termsId}`).set(as(support));
    expect(summary.body.data.acceptances.accepted).toEqual(
      expect.arrayContaining([expect.objectContaining({ tenantId: t.tenantId, context: "app" })]),
    );
  });
});

describe("data export", () => {
  it("builds the owner's archive, emails them and gives a short-lived link", async () => {
    await api()
      .post("/api/v1/vehicles")
      .set(owner())
      .send({ make: "Toyota", model: "Corolla", plateNumber: `GR ${unique().slice(0, 4)}-26` })
      .expect(201);
    const requested = await api().post("/api/v1/data-exports").set(owner());
    expect(requested.status, JSON.stringify(requested.body)).toBe(202);
    const again = await api().post("/api/v1/data-exports").set(owner());
    expect(again.body.error.code).toBe("DATA_EXPORT_RUNNING");

    await container
      .get<TenantDataExports>(TYPES.TenantDataExports)
      .handle({ exportId: requested.body.data.id as string });
    const list = await api().get("/api/v1/data-exports").set(owner());
    expect(list.body.data[0]).toMatchObject({ status: "ready", tables: expect.any(Number) });
    const { rows } = await platform.query(
      "select 1 from email_deliveries where recipient = $1 and template = 'tenant.data_export_ready'",
      [t.ownerEmail],
    );
    expect(rows).toHaveLength(1);

    const link = await api()
      .post(`/api/v1/data-exports/${requested.body.data.id}/download`)
      .set(owner());
    expect(link.status, JSON.stringify(link.body)).toBe(200);
    const zip = Buffer.from(await (await fetch(link.body.data.url as string)).arrayBuffer());
    const files = unzip(zip);
    expect(files.has("README.md")).toBe(true);
    expect(files.get("tables/vehicles.csv")).toContain("Corolla");
    expect(files.get("tables/users.csv")?.split("\n")[0]).not.toMatch(/password/);
    expect(files.has("tables/auth_sessions.csv")).toBe(false);
    expect(
      (await api().get(`${BASE}/tenants/${t.tenantId}/data-exports`).set(as(admin))).body.data[0],
    ).toMatchObject({
      downloads: 1,
    });
  });
});

describe("data-protection requests and restore drills", () => {
  it("track a request to its outcome and alert on its deadline", async () => {
    const opened = await api()
      .post(`${BASE}/data-protection-requests`)
      .set(as(support))
      .send({
        kind: "access",
        tenantId: t.tenantId,
        requesterName: "Ama Driver",
        requesterContact: "ama@example.com",
        subject: "A driver of the tenant asks what data is held about her",
        receivedAt: new Date().toISOString(),
        dueAt: new Date(Date.now() + 2 * 86_400_000).toISOString(),
      });
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    expect(opened.body.data.code).toMatch(/^DPR-\d{4}-\d{4}$/);
    const id = opened.body.data.id as string;
    await api()
      .post(`${BASE}/data-protection-requests/${id}/steps`)
      .set(as(support))
      .send({ note: "Identity confirmed with the tenant owner" })
      .expect(200);

    await container.get<ComplianceDaily>(TYPES.ComplianceDaily).handle();
    const alerts = await api().get(`${BASE}/alerts?status=open&source=privacy`).set(as(support));
    expect(alerts.body.data.map((a: { key: string }) => a.key)).toContain(`dpr.due:${id}`);

    const closed = await api()
      .post(`${BASE}/data-protection-requests/${id}/close`)
      .set(as(support))
      .send({ status: "completed", outcome: "Sent an export of her records by email" });
    expect(closed.body.data).toMatchObject({ status: "completed" });
    expect(closed.body.data.steps).toHaveLength(3);
  });

  it("keep a quarterly restore drill scheduled and record its result", async () => {
    await container.get<ComplianceDaily>(TYPES.ComplianceDaily).handle();
    const drills = await api().get(`${BASE}/restore-drills`).set(as(admin));
    const scheduled = (drills.body.data as { id: string; status: string; dueOn: string }[]).find(
      (d) => d.status === "scheduled",
    )!;
    // Due by the end of a quarter, never in the past.
    expect(scheduled.dueOn >= today()).toBe(true);
    expect(quarterEnd(scheduled.dueOn)).toBe(scheduled.dueOn);
    const recorded = await api()
      .post(`${BASE}/restore-drills/${scheduled.id}/record`)
      .set(as(admin))
      .send({
        outcome: "passed",
        performedAt: new Date().toISOString(),
        rtoMinutes: 45,
        notes: "Docs 31 §5",
      });
    expect(recorded.status, JSON.stringify(recorded.body)).toBe(200);
    expect(recorded.body.data.next).toMatchObject({
      status: "scheduled",
      dueOn: nextQuarterEnd(today()),
    });
  });
});

describe("status page", () => {
  it("shows an incident until it is resolved", async () => {
    const opened = await api()
      .post(`${BASE}/incidents`)
      .set(as(support))
      .send({
        title: "Payments slow",
        impact: "major",
        components: ["payments"],
        message: "Checkout is slow.",
      });
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    const during = await api().get("/api/v1/public/status");
    expect(during.body.data.status).toBe("partial_outage");
    expect(during.body.data.components).toEqual(
      expect.arrayContaining([
        { name: "payments", status: "partial_outage" },
        { name: "api", status: "operational" },
      ]),
    );
    await api()
      .post(`${BASE}/incidents/${opened.body.data.id}/updates`)
      .set(as(support))
      .send({ status: "resolved", message: "The provider fixed it." })
      .expect(200);
    const after = await api().get("/api/v1/public/status");
    expect(after.body.data.status).toBe("operational");
    expect(after.body.data.incidents[0]).toMatchObject({
      status: "resolved",
      updates: expect.any(Array),
    });
  });
});
