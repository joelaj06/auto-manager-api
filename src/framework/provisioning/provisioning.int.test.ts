import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { Container } from "inversify";
import type pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TENANT_ROLE_TEMPLATES } from "../../application/authorization/tenantRoleTemplates.js";
import type { IJobHandler } from "../../application/jobs/IJobHandler.js";
import type { JobName, JobPayloads } from "../../application/jobs/jobCatalog.js";
import type { IPermissionCatalogueSource } from "../../application/ports/IPermissionCatalogueSource.js";
import type { ITenantDatabaseProvisioner } from "../../application/ports/ITenantDatabaseProvisioner.js";
import type { ITenantSchemaUpdater } from "../../application/ports/ITenantSchemaUpdater.js";
import { ProvisionTenant } from "../../application/use-cases/provisioning/ProvisionTenant.js";
import { TenantApplication } from "../../domain/entities/TenantApplication.js";
import type { ITenantApplicationRepository } from "../../domain/repositories/ITenantApplicationRepository.js";
import { TenantId } from "../../domain/value-objects/TenantId.js";
import { StaffFixtures, type TestStaff } from "../../testing/fixtures/StaffFixtures.js";
import { TestTenant } from "../../testing/fixtures/TenantFixtures.js";
import { createTestContainer } from "../../testing/testContainer.js";
import { disposeContainer } from "../dependency-injection/container.js";
import { TYPES } from "../dependency-injection/types.js";

let container: Container;
let app: Express;
let platform: pg.Pool;
let admin: TestStaff;

const api = () => request(app);
const handler = <N extends JobName>(job: N) =>
  container.get<IJobHandler[]>(TYPES.JobHandlers).find((h) => h.job === job) as IJobHandler<N>;
const run = <N extends JobName>(job: N, payload: JobPayloads[N]) =>
  handler(job).handle(payload, { jobId: `test-${randomUUID()}`, attempt: 1 });

/** A verified application waiting for review (stored directly; signup is tested elsewhere). */
async function pendingApplication(): Promise<{ id: string; slug: string; email: string }> {
  const unique = randomUUID().slice(0, 8);
  const application = TenantApplication.submit({
    id: randomUUID(),
    details: {
      businessName: `Ama Rentals ${unique}`,
      businessType: "rental",
      country: "GH",
      desiredSlug: `ama-${unique}`,
      contactName: "Ama Owusu",
      contactEmail: `ama-${unique}@example.com`,
      contactPhone: `+23320${String(Math.floor(Math.random() * 10_000_000)).padStart(7, "0")}`,
      tin: "P0012345678",
      registrationNumber: null,
      expectedBranches: 1,
      expectedVehicles: 10,
      heardAbout: null,
      referralCode: null,
    },
    source: "self",
    createdByStaffId: null,
    accessTokenHash: randomUUID().replaceAll("-", ""),
    risk: { level: "low", signals: [] },
    ip: null,
    userAgent: null,
    now: new Date(),
  });
  application.markVerified("email", new Date());
  application.markVerified("phone", new Date());
  await container
    .get<ITenantApplicationRepository>(TYPES.TenantApplicationRepository)
    .save(application);
  return {
    id: application.id,
    slug: application.details.desiredSlug,
    email: application.details.contactEmail,
  };
}

async function approve(applicationId: string): Promise<string> {
  const res = await api()
    .post(`/api/platform/v1/applications/${applicationId}/approve`)
    .set("Authorization", `Bearer ${admin.accessToken}`)
    .send({ trialDays: 21 });
  expect(res.status, JSON.stringify(res.body)).toBe(204);
  const { rows } = await platform.query<{ tenant_id: string }>(
    "select tenant_id from tenant_applications where id = $1",
    [applicationId],
  );
  return rows[0]!.tenant_id;
}

async function welcomeToken(email: string): Promise<string> {
  const { rows } = await platform.query<{ body_text: string }>(
    `select body_text from email_deliveries where recipient = $1 and template = 'tenant.welcome_owner'
      order by created_at desc limit 1`,
    [email],
  );
  return /#token=([A-Za-z0-9_-]+)/.exec(rows[0]!.body_text)![1]!;
}

beforeAll(async () => {
  container = await createTestContainer({ AUTH_RATE_LIMIT_MAX: "10000" });
  app = container.get<Express>(TYPES.HttpApp);
  platform = container.get<pg.Pool>(TYPES.PlatformDatabasePool);
  admin = await new StaffFixtures(container).create(["super_admin"]);
});

afterAll(async () => {
  await disposeContainer(container);
});

describe("provisioning saga", () => {
  let tenantId: string;
  let slug: string;
  let email: string;
  let tenant: TestTenant;

  it("approval reserves the tenant and queues provisioning", async () => {
    const application = await pendingApplication();
    ({ slug, email } = application);
    tenantId = await approve(application.id);
    tenant = new TestTenant(TenantId.from(tenantId), slug, container);

    const { rows } = await platform.query<{ status: string; slug: string; step: string }>(
      `select t.status, t.slug::text as slug, p.step from tenants t
         join tenant_provisioning p on p.tenant_id = t.id where t.id = $1`,
      [tenantId],
    );
    expect(rows[0]).toEqual({ status: "provisioning", slug, step: "registered" });
    const queued = await platform.query(
      "select 1 from pgboss.job where name = 'tenant.provision' and data->>'tenantId' = $1",
      [tenantId],
    );
    expect(queued.rowCount).toBe(1);
  });

  it("creates and seeds the database and starts the trial", async () => {
    await run("tenant.provision", { tenantId });

    const { rows } = await platform.query<{
      status: string;
      trial_days: number;
      database_name: string;
    }>(
      `select status, round(extract(epoch from trial_ends_at - now()) / 86400)::int as trial_days,
              database_name from tenants where id = $1`,
      [tenantId],
    );
    expect(rows[0]).toMatchObject({ status: "trialing", trial_days: 21 });
    expect(rows[0]!.database_name).toMatch(/^tt_/);

    const catalogue = await container
      .get<IPermissionCatalogueSource>(TYPES.PermissionCatalogueSource)
      .current();
    const [seeded] = await tenant.query<{
      org: string;
      currency: string;
      branches: string;
      permissions: string;
      system_roles: string;
      owners: string;
      categories: string;
      active_taxes: string;
      catalogue_version: number;
    }>(
      `select (select name from organisation) as org,
              (select base_currency from organisation) as currency,
              (select string_agg(code, ',') from branches where is_default) as branches,
              (select count(*) from permissions) as permissions,
              (select count(*) from roles where is_system) as system_roles,
              (select count(*) from users where is_owner and status = 'invited') as owners,
              (select count(*) from expense_categories) as categories,
              (select count(*) from tax_codes where active) as active_taxes,
              (select catalogue_version from organisation) as catalogue_version`,
    );
    expect(seeded).toMatchObject({
      currency: "GHS",
      branches: "HQ",
      permissions: String(catalogue.permissions.length),
      system_roles: String(catalogue.templates.length),
      owners: "1",
      categories: "15",
      // VAT_STANDARD, ZERO_RATED and EXEMPT for a Ghana business (decision 168).
      active_taxes: "3",
      catalogue_version: catalogue.version,
    });
    expect(seeded!.org).toContain("Ama Rentals");

    const directory = await platform.query(
      "select kind from user_directory where tenant_id = $1 order by kind",
      [tenantId],
    );
    expect(directory.rows.map((r: { kind: string }) => r.kind)).toEqual(["email", "phone"]);
    // Identifiers are stored hashed only.
    expect(JSON.stringify(directory.rows)).not.toContain(email);
  });

  it("is idempotent", async () => {
    await run("tenant.provision", { tenantId });
    const [counts] = await tenant.query<{ users: string; branches: string; roles: string }>(
      `select (select count(*) from users) as users, (select count(*) from branches) as branches,
              (select count(*) from roles) as roles`,
    );
    expect(counts).toEqual({
      users: "1",
      branches: "1",
      roles: String(TENANT_ROLE_TEMPLATES.length),
    });
  });

  it("lets the owner set a password, sign in and use every permission", async () => {
    const token = await welcomeToken(email);
    const accepted = await api()
      .post("/api/v1/auth/invitations/accept")
      .set("X-Tenant", slug)
      .send({ token, password: "correct horse battery staple" });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);

    const me = await api()
      .get("/api/v1/me")
      .set("Authorization", `Bearer ${accepted.body.data.accessToken}`);
    expect(me.status, JSON.stringify(me.body)).toBe(200);
    expect(me.body.data.tenant).toMatchObject({ id: tenantId, slug, status: "trialing" });
    expect(me.body.data.permissions.map((p: { key: string }) => p.key)).toContain("billing.manage");
    expect(me.body.data.branchIds).toHaveLength(1);

    const reused = await api()
      .post("/api/v1/auth/invitations/accept")
      .set("X-Tenant", slug)
      .send({ token, password: "correct horse battery staple" });
    expect(reused.body.error.code).toBe("INVITATION_INVALID");
  });
});

describe("failure and resume", () => {
  it("records the failed step and resumes from it after a retry", async () => {
    const application = await pendingApplication();
    const tenantId = await approve(application.id);

    let failures = 1;
    const real = container.get<ITenantSchemaUpdater>(TYPES.TenantSchemaUpdater);
    const flaky: ITenantSchemaUpdater = {
      migrate: (id) =>
        failures-- > 0 ? Promise.reject(new Error("cluster busy")) : real.migrate(id),
    };
    const saga = new ProvisionTenant({
      ...(
        handler("tenant.provision") as unknown as {
          deps: ConstructorParameters<typeof ProvisionTenant>[0];
        }
      ).deps,
      schema: flaky,
    });

    await expect(saga.handle({ tenantId })).rejects.toThrow("cluster busy");
    const status = await api()
      .get(`/api/platform/v1/tenants/${tenantId}/provisioning`)
      .set("Authorization", `Bearer ${admin.accessToken}`);
    expect(status.body.data).toMatchObject({
      status: "failed",
      step: "database_created",
      tenantStatus: "provisioning_failed",
      lastError: "database_created: cluster busy",
    });

    const retried = await api()
      .post(`/api/platform/v1/tenants/${tenantId}/provisioning/retry`)
      .set("Authorization", `Bearer ${admin.accessToken}`);
    expect(retried.status).toBe(202);

    await saga.handle({ tenantId });
    const done = await api()
      .get(`/api/platform/v1/tenants/${tenantId}/provisioning`)
      .set("Authorization", `Bearer ${admin.accessToken}`);
    expect(done.body.data).toMatchObject({
      status: "completed",
      tenantStatus: "trialing",
      attempts: 2,
    });

    const again = await api()
      .post(`/api/platform/v1/tenants/${tenantId}/provisioning/retry`)
      .set("Authorization", `Bearer ${admin.accessToken}`);
    expect(again.body.error.code).toBe("PROVISIONING_NOT_RETRYABLE");
  });
});

describe("catalogue sync", () => {
  it("adds new catalogue permissions to tenants without touching custom roles", async () => {
    const application = await pendingApplication();
    const tenantId = await approve(application.id);
    await run("tenant.provision", { tenantId });
    const tenant = new TestTenant(TenantId.from(tenantId), application.slug, container);
    await tenant.query(
      `with r as (insert into roles (name) values ('Night desk') returning id)
       insert into role_permissions (role_id, permission_key, scope) select id, 'users.list', 'all' from r`,
    );

    const key = `zz_test.${randomUUID()
      .slice(0, 8)
      .replace(/[0-9-]/g, "x")}`;
    const { rows } = await platform.query<{ version: number }>(
      `with p as (insert into permission_catalog (key, module, description, scopes)
                  values ($1, 'zz_test', 'Test permission', '{all}'))
       insert into catalogue_versions (version, checksum)
       select max(version) + 1, $2 from catalogue_versions returning version`,
      [key, randomUUID()],
    );
    const version = rows[0]!.version;
    try {
      await run("catalogue.sweep", {});
      const queued = await platform.query(
        "select 1 from pgboss.job where name = 'tenant.catalogue_sync' and data->>'tenantId' = $1",
        [tenantId],
      );
      expect(queued.rowCount).toBe(1);

      await tenant.run(() => run("tenant.catalogue_sync", { tenantId, version }));
      const [after] = await tenant.query<{ has_key: boolean; custom: string; org_version: number }>(
        `select exists (select 1 from permissions where key = $1) as has_key,
                (select string_agg(permission_key, ',') from role_permissions rp join roles r on r.id = rp.role_id
                  where r.name = 'Night desk') as custom,
                (select catalogue_version from organisation) as org_version`,
        [key],
      );
      expect(after).toEqual({ has_key: true, custom: "users.list", org_version: version });
      const tenantRow = await platform.query(
        "select catalogue_version from tenants where id = $1",
        [tenantId],
      );
      expect(tenantRow.rows[0]).toEqual({ catalogue_version: version });
    } finally {
      await platform.query("delete from catalogue_versions where version = $1", [version]);
      await platform.query("delete from permission_catalog where key = $1", [key]);
    }
  });
});

describe("provisioning sweep", () => {
  it("reports tenant databases that belong to no tenant (and never drops them)", async () => {
    const orphan = TenantId.from(randomUUID());
    await container
      .get<ITenantDatabaseProvisioner>(TYPES.TenantDatabaseProvisioner)
      .provision(orphan);
    await run("provisioning.sweep", {});
    const { rows } = await platform.query<{ after: { databases: string[] } }>(
      `select after from platform_audit_logs where action = 'provisioning.orphan_databases_found'
        order by id desc limit 1`,
    );
    expect(rows[0]!.after.databases.some((d) => d.endsWith(orphan.value.replaceAll("-", "")))).toBe(
      true,
    );
  });
});
