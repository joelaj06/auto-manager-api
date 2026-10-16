import type { Express } from "express";
import type { Container } from "inversify";
import type pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ProvisionedTenants,
  type ProvisionedTenant,
} from "../../testing/fixtures/ProvisionedTenants.js";
import { StaffFixtures, type TestStaff } from "../../testing/fixtures/StaffFixtures.js";
import { createTestContainer } from "../../testing/testContainer.js";
import { disposeContainer } from "../dependency-injection/container.js";
import { TYPES } from "../dependency-injection/types.js";

const BASE = "/api/platform/v1";
let container: Container;
let app: Express;
let platform: pg.Pool;
let admin: TestStaff;
let support: TestStaff;
let auditor: TestStaff;
let t: ProvisionedTenant;

const as = (staff: TestStaff) => ({ Authorization: `Bearer ${staff.accessToken}` });
const get = (path: string, staff = admin) => request(app).get(`${BASE}${path}`).set(as(staff));

beforeAll(async () => {
  container = await createTestContainer();
  app = container.get<Express>(TYPES.HttpApp);
  platform = container.get<pg.Pool>(TYPES.PlatformDatabasePool);
  const staff = new StaffFixtures(container);
  admin = await staff.create(["super_admin"]);
  support = await staff.create(["support"]);
  auditor = await staff.create(["auditor"]);
  t = await new ProvisionedTenants(container, app, admin).create();
});

afterAll(async () => {
  await disposeContainer(container);
});

describe("dashboard", () => {
  it("counts tenants by status and pending work", async () => {
    const res = await get("/dashboard");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const d = res.body.data;
    expect(d.tenantsByStatus.trialing).toBeGreaterThanOrEqual(1);
    expect(d.liveTenants).toBeGreaterThanOrEqual(1);
    expect(d.newTenants.last7Days).toBeGreaterThanOrEqual(1);
    expect(d).toHaveProperty("applicationsByStatus");
    expect(d).toHaveProperty("trialsEndingWithin7Days");
  });

  it("is refused without the permission", async () => {
    // Auditor has dashboard.view but not tenants.view or health.view.
    expect((await get("/dashboard", auditor)).status).toBe(200);
    expect((await get("/tenants", auditor)).status).toBe(403);
    expect((await get("/health", auditor)).status).toBe(403);
  });
});

describe("tenant list and 360° profile", () => {
  it("lists, searches and filters tenants", async () => {
    const all = await get("/tenants?limit=100");
    expect(all.status).toBe(200);
    expect(all.body.data.map((x: { id: string }) => x.id)).toContain(t.tenantId);

    const bySlug = await get(`/tenants?q=${t.slug.slice(-8)}`);
    expect(bySlug.body.data).toHaveLength(1);
    expect(bySlug.body.data[0]).toMatchObject({
      id: t.tenantId,
      status: "trialing",
      ownerEmail: t.ownerEmail,
      source: "self",
    });
    expect((await get(`/tenants?q=${encodeURIComponent(t.ownerEmail)}`)).body.data).toHaveLength(1);
    expect((await get(`/tenants?status=deactivated&q=${t.slug}`)).body.data).toHaveLength(0);
    expect((await get("/tenants?status=bogus")).status).toBe(400);
  });

  it("pages with a keyset cursor", async () => {
    await new ProvisionedTenants(container, app, admin).create();
    const first = await get("/tenants?limit=1");
    expect(first.body.data).toHaveLength(1);
    const next = first.body.meta.nextBefore as string;
    const second = await get(`/tenants?limit=1&before=${next}`);
    expect(second.body.data).toHaveLength(1);
    expect(second.body.data[0].id).not.toBe(first.body.data[0].id);
  });

  it("shows the profile with provisioning, schema and usage from the tenant database", async () => {
    const res = await get(`/tenants/${t.tenantId}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const p = res.body.data;
    expect(p).toMatchObject({
      id: t.tenantId,
      slug: t.slug,
      status: "trialing",
      application: { contactEmail: t.ownerEmail, source: "self" },
      provisioning: { status: "completed", step: "completed" },
      schema: { status: "ok" },
      usageUnavailable: null,
      usage: { users: { active: 1 }, branches: { active: 1 } },
      tags: [],
      notes: { count: 0, pinned: 0 },
    });
    expect(p.schema.version).not.toBeNull();
    expect(p.usage.databaseBytes).toBeGreaterThan(0);
    expect(p.usage.lastLoginAt).not.toBeNull();
    expect((await get("/tenants/00000000-0000-7000-8000-000000000000")).status).toBe(404);
  });

  it("shows the timeline: application events and console actions", async () => {
    const res = await get(`/tenants/${t.tenantId}/timeline`);
    expect(res.status).toBe(200);
    const types = res.body.data.map((e: { type: string }) => e.type);
    expect(types).toEqual(expect.arrayContaining(["approved", "tenant.provisioned"]));
  });
});

describe("notes and tags", () => {
  it("adds, edits, pins and deletes notes; only the author edits; all audited", async () => {
    const path = `/tenants/${t.tenantId}/notes`;
    const added = await request(app)
      .post(`${BASE}${path}`)
      .set(as(support))
      .send({ body: "  Called the owner about onboarding  " });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    const note = added.body.data;
    expect(note).toMatchObject({ body: "Called the owner about onboarding", pinned: false });
    expect(note.author.id).toBe(support.id);

    // Another staff member can pin but not edit or delete.
    const pin = await request(app)
      .patch(`${BASE}${path}/${note.id}`)
      .set(as(admin))
      .send({ pinned: true });
    expect(pin.status).toBe(200);
    expect(pin.body.data.pinned).toBe(true);
    const foreignEdit = await request(app)
      .patch(`${BASE}${path}/${note.id}`)
      .set(as(admin))
      .send({ body: "rewritten" });
    expect([foreignEdit.status, foreignEdit.body.error.code]).toEqual([403, "NOTE_NOT_YOURS"]);
    expect((await request(app).delete(`${BASE}${path}/${note.id}`).set(as(admin))).status).toBe(
      403,
    );

    const edited = await request(app)
      .patch(`${BASE}${path}/${note.id}`)
      .set(as(support))
      .send({ body: "Owner wants a demo" });
    expect(edited.body.data).toMatchObject({ body: "Owner wants a demo", pinned: true });

    const pinned = await get(`${path}?pinned=true`, support);
    expect(pinned.body.data.map((n: { id: string }) => n.id)).toEqual([note.id]);
    expect((await get(`/tenants/${t.tenantId}`)).body.data.notes).toEqual({ count: 1, pinned: 1 });

    expect((await request(app).delete(`${BASE}${path}/${note.id}`).set(as(support))).status).toBe(
      204,
    );
    expect((await get(path)).body.data).toHaveLength(0);
    expect(
      (
        await request(app)
          .patch(`${BASE}${path}/${note.id}`)
          .set(as(support))
          .send({ pinned: false })
      ).status,
    ).toBe(404);

    const { rows } = await platform.query<{ action: string; before: { body?: string } | null }>(
      `select action, before from platform_audit_logs
        where entity_type = 'tenant_note' and entity_id = $1 order by id`,
      [note.id],
    );
    expect(rows.map((r) => r.action)).toEqual([
      "tenant.note_added",
      "tenant.note_edited",
      "tenant.note_edited",
      "tenant.note_deleted",
    ]);
    expect(rows.at(-1)!.before).toEqual({ body: "Owner wants a demo" });
  });

  it("refuses notes without the notes permission", async () => {
    const res = await request(app)
      .post(`${BASE}/tenants/${t.tenantId}/notes`)
      .set(as(auditor))
      .send({ body: "x" });
    expect(res.status).toBe(403);
  });

  it("replaces tags (normalised), filters the list by tag and counts tags in use", async () => {
    const set = await request(app)
      .put(`${BASE}/tenants/${t.tenantId}/tags`)
      .set(as(support))
      .send({ tags: ["VIP", "At Risk", "vip"] });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(set.body.data).toEqual(["at-risk", "vip"]);

    const filtered = await get("/tenants?tag=vip");
    expect(filtered.body.data.map((x: { id: string }) => x.id)).toEqual([t.tenantId]);
    expect(filtered.body.data[0].tags).toEqual(["at-risk", "vip"]);
    const inUse = await get("/tags");
    expect(inUse.body.data).toEqual(
      expect.arrayContaining([
        { tag: "vip", tenants: 1 },
        { tag: "at-risk", tenants: 1 },
      ]),
    );

    const replaced = await request(app)
      .put(`${BASE}/tenants/${t.tenantId}/tags`)
      .set(as(support))
      .send({ tags: ["vip"] });
    expect(replaced.body.data).toEqual(["vip"]);
    const bad = await request(app)
      .put(`${BASE}/tenants/${t.tenantId}/tags`)
      .set(as(support))
      .send({ tags: ["no!"] });
    expect([bad.status, bad.body.error.code]).toEqual([400, "INVALID_TAG"]);
  });
});

describe("data operations", () => {
  it("shows backups and the backup summary", async () => {
    await platform.query(
      `insert into backups (kind, tenant_id, database_name, status, finished_at, location, sha256, size_bytes)
       values ('tenant', $1, 'x', 'succeeded', now(), 'loc', repeat('a', 64), 1234),
              ('tenant', $1, 'x', 'failed', now(), null, null, null)`,
      [t.tenantId],
    );
    const list = await get(`/tenants/${t.tenantId}/backups`);
    expect(list.status).toBe(200);
    expect(list.body.data.map((b: { status: string }) => b.status)).toEqual([
      "failed",
      "succeeded",
    ]);
    expect(list.body.data[1]).not.toHaveProperty("location");
    expect(list.body.data[1]).toMatchObject({ tenantSlug: t.slug, sizeBytes: 1234 });

    const summary = await get("/backups/summary");
    expect(summary.status).toBe(200);
    expect(summary.body.data.failedLast24Hours).toBeGreaterThanOrEqual(1);
    expect(summary.body.data).toHaveProperty("tenantsWithoutRecentBackup.count");

    const profile = await get(`/tenants/${t.tenantId}`);
    expect(profile.body.data.backups.lastSizeBytes).toBe(1234);
  });

  it("shows migration status with provisioned tenants at the latest version", async () => {
    const res = await get("/migrations");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const m = res.body.data;
    expect(m.platform.upToDate).toBe(true);
    expect(m.tenants.latest).not.toBeNull();
    expect(m.tenants.upToDate).toBeGreaterThanOrEqual(1);
    expect((await get("/migrations", support)).status).toBe(403);
  });

  it("summarises system health", async () => {
    const res = await get("/health");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const h = res.body.data;
    expect(["ok", "warning", "critical"]).toContain(h.status);
    expect(h.checks.map((c: { name: string }) => c.name)).toEqual([
      "database",
      "jobs",
      "email",
      "backups",
      "migrations",
    ]);
    const database = h.checks.find((c: { name: string }) => c.name === "database");
    expect(database.status).toBe("ok");
    expect(database.metrics.tenantDatabases).toBeGreaterThanOrEqual(1);
    const jobs = h.checks.find((c: { name: string }) => c.name === "jobs");
    expect(jobs.findings.join()).not.toContain("Check failed");
    expect(h.runtime.version).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe("audit viewer", () => {
  it("filters by entity and exports CSV, recording the export", async () => {
    const byEntity = await get(`/audit-logs?entityType=tenant&entityId=${t.tenantId}`, auditor);
    expect(byEntity.status).toBe(200);
    expect(byEntity.body.data.length).toBeGreaterThanOrEqual(1);
    expect(byEntity.body.data.every((e: { entityType: string }) => e.entityType === "tenant")).toBe(
      true,
    );

    const csv = await get(`/audit-logs/export?targetTenantId=${t.tenantId}`, auditor);
    expect(csv.status).toBe(200);
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.headers["x-export-truncated"]).toBe("false");
    const lines = csv.text.trim().split("\r\n");
    expect(lines[0]).toMatch(/^occurredAt,id,actorType/);
    expect(lines.length).toBeGreaterThan(1);

    const { rows } = await platform.query<{ metadata: { rows: number } }>(
      `select metadata from platform_audit_logs
        where action = 'audit.exported' and actor_id = $1 order by id desc limit 1`,
      [auditor.id],
    );
    expect(rows[0]!.metadata.rows).toBe(lines.length - 1);
    expect((await get("/audit-logs/export", support)).status).toBe(403);
  });
});
