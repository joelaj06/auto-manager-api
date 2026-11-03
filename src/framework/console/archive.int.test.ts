import { generateKeyPairSync, randomUUID, type KeyObject } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Express } from "express";
import type { Container } from "inversify";
import type pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IJobHandler } from "../../application/jobs/IJobHandler.js";
import type { ArchiveOperations } from "../../application/use-cases/console/ArchiveOperations.js";
import type { PostgresConnectionFactory } from "../../infrastructure/database/postgres/PostgresConnectionFactory.js";
import { TotpService } from "../../infrastructure/security/TotpService.js";
import {
  ProvisionedTenants,
  type ProvisionedTenant,
} from "../../testing/fixtures/ProvisionedTenants.js";
import { StaffFixtures, type TestStaff } from "../../testing/fixtures/StaffFixtures.js";
import { createTestContainer } from "../../testing/testContainer.js";
import { archiveOperationsFrom } from "../cli/archiveOperations.js";
import { disposeContainer } from "../dependency-injection/container.js";
import { TYPES } from "../dependency-injection/types.js";

/**
 * Cold archive and erasure (P9-2) end to end: a driver erased by anonymisation with a Super
 * Admin's approval and the ledger, a tenant deactivated for a year archived with four-eyes
 * (dumped, checked while written, its live database dropped), the yearly restore test and
 * encrypting again for the key with the private key, an approved restore bringing the database
 * back with the erasure applied again, and the tenant working once staff restore it.
 */
const BASE = "/api/platform/v1";
let container: Container;
let app: Express;
let platform: pg.Pool;
let factory: PostgresConnectionFactory;
let directory: string;
let privateKey: KeyObject;
let operations: ArchiveOperations;
let admin: TestStaff;
let approver: TestStaff;
let support: TestStaff;
let t: ProvisionedTenant;
let database: string;
let driverId: string;
let customerId: string;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- response bodies are checked by expect()
type Body = any;

const api = () => request(app);
const as = (who: { accessToken: string }) => ({ Authorization: `Bearer ${who.accessToken}` });
const owner = () => ({ Authorization: `Bearer ${t.ownerAccessToken}` });
const digits = (n: number) => String(Math.floor(Math.random() * 10 ** n)).padStart(n, "0");

async function stepUp(who: TestStaff) {
  const code = new TotpService().codeAt(who.totpSecret, new Date(Date.now() + 30_000));
  await api()
    .post(`${BASE}/auth/step-up`)
    .set(as(who))
    .send({ password: who.password, code })
    .expect(204);
}

async function approve(approvalId: string) {
  const res = await api()
    .post(`${BASE}/approvals/${approvalId}/approve`)
    .set(as(approver))
    .send({ note: "Checked" });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  expect(res.body.data.status, JSON.stringify(res.body.data)).toBe("approved");
}

function handler<J extends "tenant.archive" | "tenant.erasure">(job: J): IJobHandler<J> {
  return container
    .get<IJobHandler[]>(TYPES.JobHandlers)
    .find((h) => h.job === job) as unknown as IJobHandler<J>;
}

async function tenantQuery<R extends pg.QueryResultRow>(sql: string, params: unknown[] = []) {
  const client = await factory.connect("migrator", database);
  try {
    return (await client.query<R>(sql, params)).rows;
  } finally {
    await client.end();
  }
}

async function databaseExists(): Promise<boolean> {
  const { rowCount } = await platform.query("select 1 from pg_database where datname = $1", [
    database,
  ]);
  return (rowCount ?? 0) > 0;
}

async function tenantRow() {
  const { rows } = await platform.query<{ status: string; database_name: string | null }>(
    "select status, database_name from tenants where id = $1",
    [t.tenantId],
  );
  return rows[0]!;
}

async function currentArchive(): Promise<Body> {
  const res = await api().get(`${BASE}/archives?tenantId=${t.tenantId}`).set(as(admin));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return (res.body.data as Body[])[0];
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "autoforce-archive-"));
  const keys = generateKeyPairSync("rsa", { modulusLength: 3072 });
  privateKey = keys.privateKey;
  const publicKeyFile = join(directory, "backup-public.pem");
  await writeFile(publicKeyFile, keys.publicKey.export({ type: "spki", format: "pem" }));
  container = await createTestContainer({
    AUTH_RATE_LIMIT_MAX: "10000",
    RATE_LIMIT_MAX: "100000",
    BACKUP_DIR: join(directory, "backups"),
    BACKUP_PUBLIC_KEY_FILE: publicKeyFile,
    // No PostgreSQL client tools are assumed on the machine: run them from the server's image.
    BACKUP_PG_TOOLS: process.env.BACKUP_PG_TOOLS ?? "docker",
  });
  app = container.get<Express>(TYPES.HttpApp);
  platform = container.get<pg.Pool>(TYPES.PlatformDatabasePool);
  factory = container.get<PostgresConnectionFactory>(TYPES.PostgresConnectionFactory);
  operations = archiveOperationsFrom(container, privateKey);
  const fixtures = new StaffFixtures(container);
  admin = await fixtures.create(["super_admin"]);
  approver = await fixtures.create(["super_admin"]);
  support = await fixtures.create(["support"]);
  await stepUp(admin);
  await stepUp(approver);
  t = await new ProvisionedTenants(container, app, admin).create();
  database = (await tenantRow()).database_name!;

  const driver = await api()
    .post("/api/v1/drivers")
    .set(owner())
    .send({
      firstName: "Kwame",
      lastName: "Boateng",
      phone: `024${digits(7)}`,
      ghanaCardNumber: `GHA-${digits(9)}-1`,
      licenceNumber: `DL-${randomUUID().slice(0, 6)}`,
      licenceClass: "B",
      licenceExpiresOn: "2030-01-01",
    });
  expect(driver.status, JSON.stringify(driver.body)).toBe(201);
  driverId = driver.body.data.id as string;
  const guarantor = await api()
    .post(`/api/v1/drivers/${driverId}/guarantors`)
    .set(owner())
    .send({ name: "Abena Boateng", phone: `020${digits(7)}`, relationship: "Sister" });
  expect(guarantor.status, JSON.stringify(guarantor.body)).toBe(201);
  const customer = await api()
    .post("/api/v1/customers")
    .set(owner())
    .send({
      type: "individual",
      firstName: "Yaw",
      lastName: "Owusu",
      email: `yaw-${randomUUID().slice(0, 8)}@example.com`,
    });
  expect(customer.status, JSON.stringify(customer.body)).toBe(201);
  customerId = customer.body.data.id as string;
}, 180_000);

afterAll(async () => {
  await disposeContainer(container);
  await rm(directory, { recursive: true, force: true });
});

describe("erasure by anonymisation", () => {
  it("previews the person to staff who may erase", async () => {
    const query = `subjectType=driver&subjectId=${driverId}`;
    expect(
      (await api().get(`${BASE}/tenants/${t.tenantId}/erasures/preview?${query}`).set(as(support)))
        .status,
    ).toBe(403);
    const res = await api()
      .get(`${BASE}/tenants/${t.tenantId}/erasures/preview?${query}`)
      .set(as(admin));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toMatchObject({ found: true, blockedBy: null, erasure: null });
  });

  it("refuses to erase the owner", async () => {
    const [ownerUser] = await tenantQuery<{ id: string }>(
      "select id from users where is_owner limit 1",
    );
    const res = await api()
      .post(`${BASE}/tenants/${t.tenantId}/erasures`)
      .set(as(admin))
      .send({ subjectType: "user", subjectId: ownerUser!.id, reason: "Asked to be forgotten" });
    expect(res.status, JSON.stringify(res.body)).toBe(422);
  });

  it("erases a driver once a Super Admin approves, keeping the ledger", async () => {
    const asked = await api()
      .post(`${BASE}/tenants/${t.tenantId}/erasures`)
      .set(as(admin))
      .send({ subjectType: "driver", subjectId: driverId, reason: "Data subject request DSR-1" });
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    await approve(asked.body.data.approvalId as string);

    const ledger = await api().get(`${BASE}/erasures?tenantId=${t.tenantId}`).set(as(admin));
    expect(ledger.status, JSON.stringify(ledger.body)).toBe(200);
    const entry = (ledger.body.data as Body[])[0];
    expect(entry).toMatchObject({ subjectType: "driver", subjectId: driverId, status: "pending" });
    await handler("tenant.erasure").handle(
      { erasureId: entry.id as string },
      { jobId: "test", attempt: 1 },
    );

    const [row] = await tenantQuery<Body>(
      "select first_name, last_name, phone, ghana_card_number, licence_number from drivers where id = $1",
      [driverId],
    );
    expect(row).toMatchObject({
      first_name: "Erased",
      ghana_card_number: null,
      licence_number: null,
    });
    expect(row.last_name).toMatch(/^[0-9A-F]{10}$/);
    expect(row.phone).toMatch(/^\+999\d{9}$/);
    const guarantors = await tenantQuery<Body>(
      "select name, phone from driver_guarantors where driver_id = $1",
      [driverId],
    );
    expect(guarantors.every((g) => !String(g.name).includes("Abena"))).toBe(true);
    const audits = await tenantQuery<{ n: number }>(
      "select count(*)::int as n from audit_logs where (coalesce(before, '{}')::text || coalesce(after, '{}')::text) like '%Kwame%'",
    );
    expect(audits[0]!.n).toBe(0);

    const after = await api().get(`${BASE}/erasures?tenantId=${t.tenantId}`).set(as(admin));
    expect((after.body.data as Body[])[0]).toMatchObject({ status: "applied" });
    const again = await api()
      .post(`${BASE}/tenants/${t.tenantId}/erasures`)
      .set(as(admin))
      .send({ subjectType: "driver", subjectId: driverId, reason: "Again" });
    expect(again.status, JSON.stringify(again.body)).toBe(422);
  });
});

describe("cold archive", () => {
  let archiveId: string;
  let backupId: string;

  it("archives only a tenant deactivated for a year", async () => {
    const ask = () =>
      api()
        .post(`${BASE}/tenants/${t.tenantId}/cold-archive`)
        .set(as(admin))
        .send({ reason: "Closed down for good" });
    expect((await ask()).status).toBe(422);
    await api()
      .post(`${BASE}/tenants/${t.tenantId}/deactivate`)
      .set(as(admin))
      .send({ reasonCategory: "other", reason: "Business closed" })
      .expect(204);
    const recent = await ask();
    expect(recent.status).toBe(422);
    expect(recent.body.error.message).toContain("365 days");
    await platform.query(
      "update tenants set status_changed_at = now() - interval '400 days' where id = $1",
      [t.tenantId],
    );

    const asked = await ask();
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    await approve(asked.body.data.approvalId as string);
    const queued = await currentArchive();
    expect(queued).toMatchObject({ status: "queued", reason: "Closed down for good" });
    archiveId = queued.id as string;
  });

  it("dumps the database checked while written and drops it", async () => {
    await handler("tenant.archive").handle({ archiveId }, { jobId: "test", attempt: 1 });
    const archived = await api().get(`${BASE}/archives/${archiveId}`).set(as(admin));
    expect(archived.status, JSON.stringify(archived.body)).toBe(200);
    expect(archived.body.data, JSON.stringify(archived.body.data)).toMatchObject({
      status: "archived",
      clusterId: "main",
      error: null,
    });
    expect(archived.body.data.files.missing).toBe(0);
    expect(archived.body.data.files.manifestLocation).toMatch(/^archives\//);
    backupId = archived.body.data.backupId as string;

    expect(await tenantRow()).toEqual({ status: "archived", database_name: null });
    expect(await databaseExists()).toBe(false);
    const { rows } = await platform.query<Body>(
      "select purpose, status, verified_at, location from backups where id = $1",
      [backupId],
    );
    expect(rows[0]).toMatchObject({ purpose: "archive", status: "succeeded" });
    expect(rows[0].verified_at).toBeInstanceOf(Date);
    expect(rows[0].location).toMatch(new RegExp(`^archives/${t.tenantId}/`));

    // Nobody signs in, nothing is erased until it is back, and no second archive.
    const erase = await api()
      .post(`${BASE}/tenants/${t.tenantId}/erasures`)
      .set(as(admin))
      .send({ subjectType: "customer", subjectId: customerId, reason: "Asked" });
    expect(erase.status).toBe(422);
    expect(erase.body.error.message).toContain("cold archive");
  });

  it("passes the yearly restore test and is encrypted again for the key", async () => {
    const [verified] = await operations.verify("ops-test", { archiveIds: [archiveId] });
    expect(verified!.error).toBeNull();
    expect(verified!.report!.checks.filter((c) => !c.passed)).toEqual([]);
    expect(verified!.report!.migratedTo).toMatch(/^\d{4}$/);
    expect((await currentArchive()).lastVerifiedAt).not.toBeNull();

    const [rekeyed] = await operations.rekey("ops-test", { archiveIds: [archiveId] });
    expect(rekeyed!.error).toBeNull();
    expect(rekeyed!.backupId).not.toBe(backupId);
    expect((await currentArchive()).backupId).toBe(rekeyed!.backupId);
  });

  it("restores the tenant once approved, with the erasure applied again", async () => {
    await expect(operations.restore(t.tenantId, "ops-test")).rejects.toThrow(/No approved restore/);
    const asked = await api()
      .post(`${BASE}/tenants/${t.tenantId}/cold-archive/restore`)
      .set(as(admin))
      .send({ reason: "The owner is back" });
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    await approve(asked.body.data.approvalId as string);

    const restored = await operations.restore(t.tenantId, "ops-test");
    expect(restored.clusterId).toBe("main");
    expect(restored.archive).toMatchObject({ status: "restored", restoredByOperator: "ops-test" });
    expect(restored.archive.restoreReport).toMatchObject({ erasures: { reapplied: 1 } });
    expect(await tenantRow()).toEqual({ status: "deactivated", database_name: database });
    const [driver] = await tenantQuery<Body>("select first_name from drivers where id = $1", [
      driverId,
    ]);
    expect(driver.first_name).toBe("Erased");

    await api()
      .post(`${BASE}/tenants/${t.tenantId}/restore`)
      .set(as(admin))
      .send({ reason: "Back from cold archive" })
      .expect(204);
    const read = await api().get(`/api/v1/customers/${customerId}`).set(owner());
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(read.body.data.firstName).toBe("Yaw");
  });
});
