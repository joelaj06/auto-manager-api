import type { Express } from "express";
import type { Container } from "inversify";
import pg from "pg";
import request from "supertest";
import type { StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IJobHandler } from "../../application/jobs/IJobHandler.js";
import type { ITenantDirectory } from "../../application/ports/ITenantDirectory.js";
import type { MigrationSets } from "../../infrastructure/database/migrations/MigrationCatalog.js";
import type { MigrationRunner } from "../../infrastructure/database/migrations/MigrationRunner.js";
import { ClusterBootstrapper } from "../../infrastructure/database/provisioning/ClusterBootstrapper.js";
import type { PostgresConnectionFactory } from "../../infrastructure/database/postgres/PostgresConnectionFactory.js";
import { TotpService } from "../../infrastructure/security/TotpService.js";
import {
  ProvisionedTenants,
  type ProvisionedTenant,
} from "../../testing/fixtures/ProvisionedTenants.js";
import { StaffFixtures, type TestStaff } from "../../testing/fixtures/StaffFixtures.js";
import { createTestContainer } from "../../testing/testContainer.js";
import { TEST_DATABASE } from "../../testing/testDatabase.js";
import {
  startPostgresContainer,
  TEST_POSTGRES_PASSWORD,
} from "../../testing/testInfrastructure.js";
import { disposeContainer } from "../dependency-injection/container.js";
import { TYPES } from "../dependency-injection/types.js";

/**
 * Cluster management (P9-1) end to end against a second PostgreSQL server: adding a cluster
 * once its server is ready, a tenant offline while moving, a four-eyes move with the copy
 * checked and the tenant working on its new cluster, the orphan sweep's findings with the drop
 * rules (four-eyes, Super Admin, after the grace period), moving back and retiring the cluster.
 */
const BASE = "/api/platform/v1";
const CLUSTER = `c2-${Date.now().toString(36)}`;
let container: Container;
let app: Express;
let platform: pg.Pool;
let factory: PostgresConnectionFactory;
let server: StartedTestContainer;
let second: { host: string; port: number };
let admin: TestStaff;
let approver: TestStaff;
let support: TestStaff;
let t: ProvisionedTenant;
let database: string;
let vehicleId: string;

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

/** Asks, approves and runs a move; returns the move. */
async function move(to: string): Promise<Body> {
  const asked = await api()
    .post(`${BASE}/tenants/${t.tenantId}/cluster-move`)
    .set(as(admin))
    .send({ clusterId: to, reason: "Rebalancing the clusters" });
  expect(asked.status, JSON.stringify(asked.body)).toBe(202);
  await approve(asked.body.data.approvalId as string);
  const moves = await api().get(`${BASE}/clusters/moves?tenantId=${t.tenantId}`).set(as(admin));
  const queued = (moves.body.data as Body[])[0];
  expect(queued).toMatchObject({ to, status: "queued", approvalId: asked.body.data.approvalId });
  const handler = container
    .get<IJobHandler[]>(TYPES.JobHandlers)
    .find((h) => h.job === "tenant.cluster_move") as IJobHandler<"tenant.cluster_move">;
  await handler.handle({ moveId: queued.id as string }, { jobId: "test", attempt: 1 });
  const done = await api().get(`${BASE}/clusters/moves/${queued.id}`).set(as(admin));
  expect(done.status).toBe(200);
  return done.body.data;
}

async function onSecond<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const client = await factory.at(second).connect("migrator", TEST_DATABASE.platformDatabase);
  try {
    return (await client.query(sql, params)).rows as T[];
  } finally {
    await client.end();
  }
}

async function sweep(): Promise<Body[]> {
  const swept = await api().post(`${BASE}/clusters/sweep`).set(as(admin));
  expect(swept.status, JSON.stringify(swept.body)).toBe(200);
  const res = await api().get(`${BASE}/clusters/findings`).set(as(admin));
  expect(res.status).toBe(200);
  return res.body.data as Body[];
}

beforeAll(async () => {
  server = await startPostgresContainer();
  second = { host: server.getHost(), port: server.getMappedPort(5432) };
  // The second server, set up as `yarn db:setup` would.
  const superuser = new pg.Client({
    ...second,
    user: "autoforce",
    password: TEST_POSTGRES_PASSWORD,
    database: "postgres",
  });
  await superuser.connect();
  try {
    await new ClusterBootstrapper(superuser).bootstrap({
      roles: TEST_DATABASE.roles,
      platformDatabase: TEST_DATABASE.platformDatabase,
      tenantTemplateDatabase: TEST_DATABASE.templateDatabase,
      tenantDatabasePrefix: TEST_DATABASE.tenantPrefix,
    });
  } finally {
    await superuser.end();
  }

  container = await createTestContainer({
    AUTH_RATE_LIMIT_MAX: "10000",
    RATE_LIMIT_MAX: "100000",
    CLUSTER_MOVE_SETTLE_MS: "0",
    // No PostgreSQL client tools are assumed on the machine: run them from the server's image.
    BACKUP_PG_TOOLS: process.env.BACKUP_PG_TOOLS ?? "docker",
  });
  app = container.get<Express>(TYPES.HttpApp);
  platform = container.get<pg.Pool>(TYPES.PlatformDatabasePool);
  factory = container.get<PostgresConnectionFactory>(TYPES.PostgresConnectionFactory);
  const fixtures = new StaffFixtures(container);
  admin = await fixtures.create(["super_admin"]);
  approver = await fixtures.create(["super_admin"]);
  support = await fixtures.create(["support"]);
  await stepUp(admin);
  await stepUp(approver);
  t = await new ProvisionedTenants(container, app, admin).create();
  const { rows } = await platform.query<{ database_name: string }>(
    "select database_name from tenants where id = $1",
    [t.tenantId],
  );
  database = rows[0]!.database_name;

  const vehicle = await api()
    .post("/api/v1/vehicles")
    .set(owner())
    .send({ make: "Toyota", model: "Corolla", plateNumber: `GW ${digits(4)}-26`, odometer: 5_000 });
  expect(vehicle.status, JSON.stringify(vehicle.body)).toBe(201);
  vehicleId = vehicle.body.data.id as string;
});

afterAll(async () => {
  // Whatever happened, later files must not place tenants on a server that is going away.
  await platform
    ?.query("update tenants set cluster_id = 'main', moving_since = null where cluster_id = $1", [
      CLUSTER,
    ])
    .catch(() => undefined);
  await platform
    ?.query("update clusters set status = 'retired' where id = $1", [CLUSTER])
    .catch(() => undefined);
  await disposeContainer(container);
  await server?.stop();
});

describe("cluster management", () => {
  it("shows the clusters with their capacity to staff who may see them", async () => {
    expect((await api().get(`${BASE}/clusters`).set(as(support))).status).toBe(403);
    const res = await api().get(`${BASE}/clusters`).set(as(admin));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const main = (res.body.data.clusters as Body[]).find((c) => c.id === "main");
    expect(main).toMatchObject({ status: "active", host: null, acceptsTenants: true });
    expect(main.tenants).toBeGreaterThanOrEqual(1);
    expect(main.probe).toMatchObject({ reachable: true, problems: [] });
    expect(res.body.data.totals.capacity).toBeGreaterThanOrEqual(1_000);
  });

  it("adds a cluster only once its server is ready", async () => {
    const body = { id: CLUSTER, name: "Second cluster", ...second, maxTenants: 50 };
    // The template is not migrated there yet.
    const early = await api().post(`${BASE}/clusters`).set(as(admin)).send(body);
    expect(early.status, JSON.stringify(early.body)).toBe(422);
    expect(early.body.error.message).toContain("tenant template");

    const runner = container.get<MigrationRunner>(TYPES.MigrationRunner);
    const sets = container.get<MigrationSets>(TYPES.MigrationSets);
    const template = await factory.at(second).connect("migrator", TEST_DATABASE.templateDatabase);
    try {
      await runner.migrate(template, sets.tenant);
    } finally {
      await template.end();
    }

    const unreachable = await api()
      .post(`${BASE}/clusters`)
      .set(as(admin))
      .send({ ...body, id: `${CLUSTER}-x`, port: 1 });
    expect(unreachable.status).toBe(422);
    expect(unreachable.body.error.message).toContain("Unreachable");

    const added = await api().post(`${BASE}/clusters`).set(as(admin)).send(body);
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    expect(added.body.data).toMatchObject({
      id: CLUSTER,
      status: "active",
      tenants: 0,
      maxTenants: 50,
      probe: { reachable: true, problems: [] },
    });
    expect((await api().post(`${BASE}/clusters`).set(as(admin)).send(body)).status).toBe(422);
    const audit = await platform.query(
      "select 1 from platform_audit_logs where action = 'cluster.added' and entity_id = $1",
      [CLUSTER],
    );
    expect(audit.rowCount).toBe(1);
  });

  it("keeps a tenant offline while it is moving", async () => {
    const directory = container.get<ITenantDirectory>(TYPES.TenantDirectory);
    await platform.query("update tenants set moving_since = now() where id = $1", [t.tenantId]);
    directory.invalidate();
    try {
      const res = await api().get(`/api/v1/vehicles/${vehicleId}`).set(owner());
      expect(res.status, JSON.stringify(res.body)).toBe(503);
      expect(res.body.error.code).toBe("TENANT_MOVING");
      expect(res.headers["retry-after"]).toBe("60");
    } finally {
      await platform.query("update tenants set moving_since = null where id = $1", [t.tenantId]);
      directory.invalidate();
    }
    expect((await api().get(`/api/v1/vehicles/${vehicleId}`).set(owner())).status).toBe(200);
  });

  it("refuses moves that cannot happen", async () => {
    for (const clusterId of ["main", "nowhere"]) {
      const res = await api()
        .post(`${BASE}/tenants/${t.tenantId}/cluster-move`)
        .set(as(admin))
        .send({ clusterId, reason: "Rebalancing the clusters" });
      expect(res.status, JSON.stringify(res.body)).toBe(422);
    }
    const asSupport = await api()
      .post(`${BASE}/tenants/${t.tenantId}/cluster-move`)
      .set(as(support))
      .send({ clusterId: CLUSTER, reason: "Rebalancing the clusters" });
    expect(asSupport.status).toBe(403);
  });

  it("moves a tenant to the new cluster after a second admin approves", async () => {
    const done = await move(CLUSTER);
    expect(done, JSON.stringify(done)).toMatchObject({
      from: "main",
      to: CLUSTER,
      status: "completed",
      error: null,
    });
    expect(done.report.rows).toBeGreaterThan(0);
    expect(done.report.tables).toBeGreaterThan(0);
    expect(done.report.offlineSeconds).toBeGreaterThanOrEqual(0);
    expect(done.sourceRetainedUntil).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const placed = await platform.query<{ cluster_id: string; moving_since: Date | null }>(
      "select cluster_id, moving_since from tenants where id = $1",
      [t.tenantId],
    );
    expect(placed.rows[0]).toEqual({ cluster_id: CLUSTER, moving_since: null });

    // The tenant works from its new cluster: its data is there and new data lands there.
    const car = await api().get(`/api/v1/vehicles/${vehicleId}`).set(owner());
    expect(car.status, JSON.stringify(car.body)).toBe(200);
    const added = await api()
      .post("/api/v1/vehicles")
      .set(owner())
      .send({ make: "Kia", model: "Picanto", plateNumber: `GE ${digits(4)}-26`, odometer: 10 });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    const client = await factory.at(second).connect("migrator", database);
    try {
      const { rows } = await client.query<{ n: string }>("select count(*) as n from vehicles");
      expect(Number(rows[0]!.n)).toBe(2);
    } finally {
      await client.end();
    }

    const audit = await platform.query(
      "select 1 from platform_audit_logs where action = 'tenant.cluster_moved' and entity_id = $1",
      [t.tenantId],
    );
    expect(audit.rowCount).toBe(1);
    const view = await api().get(`${BASE}/clusters/${CLUSTER}`).set(as(admin));
    expect(view.body.data).toMatchObject({ tenants: 1, fillPercent: 2 });
  });

  it("finds the database left behind and keeps it for the retention period", async () => {
    const findings = await sweep();
    const left = findings.find((f) => f.clusterId === "main" && f.databaseName === database);
    expect(left).toMatchObject({ kind: "moved_away", tenantId: t.tenantId, droppable: false });
    expect(left.retainedUntil).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const drop = await api()
      .post(`${BASE}/clusters/main/databases/${database}/drop`)
      .set(as(admin))
      .send({ reason: "No longer needed" });
    expect(drop.status, JSON.stringify(drop.body)).toBe(422);
  });

  it("drops an orphan database only after the grace period and a Super Admin's approval", async () => {
    const stray = `${TEST_DATABASE.tenantPrefix}stray_${Date.now().toString(36)}`;
    await onSecond(`create database ${pg.escapeIdentifier(stray)}`);
    const found = (await sweep()).find((f) => f.clusterId === CLUSTER && f.databaseName === stray);
    expect(found).toMatchObject({ kind: "no_tenant", tenantId: null, droppable: false });
    const early = await api()
      .post(`${BASE}/clusters/${CLUSTER}/databases/${stray}/drop`)
      .set(as(admin))
      .send({ reason: "Left over from a test" });
    expect(early.status).toBe(422);

    await platform.query(
      `update cluster_database_findings set first_seen_at = now() - interval '15 days'
        where cluster_id = $1 and database_name = $2`,
      [CLUSTER, stray],
    );
    const asked = await api()
      .post(`${BASE}/clusters/${CLUSTER}/databases/${stray}/drop`)
      .set(as(admin))
      .send({ reason: "Left over from a test" });
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    await approve(asked.body.data.approvalId as string);
    expect(await onSecond("select 1 from pg_database where datname = $1", [stray])).toHaveLength(0);
    const finding = await platform.query<{ resolved_at: Date | null; dropped_by: string | null }>(
      "select resolved_at, dropped_by from cluster_database_findings where database_name = $1",
      [stray],
    );
    expect(finding.rows[0]!.resolved_at).not.toBeNull();
    expect(finding.rows[0]!.dropped_by).toBe(approver.id);
  });

  it("moves the tenant back and retires the empty cluster", async () => {
    const busy = await api()
      .patch(`${BASE}/clusters/${CLUSTER}`)
      .set(as(admin))
      .send({ status: "retired" });
    expect(busy.status).toBe(422);

    const back = await move("main");
    expect(back).toMatchObject({ from: CLUSTER, to: "main", status: "completed" });
    const car = await api().get(`/api/v1/vehicles/${vehicleId}`).set(owner());
    expect(car.status, JSON.stringify(car.body)).toBe(200);

    expect(
      (await api().patch(`${BASE}/clusters/main`).set(as(admin)).send({ status: "retired" }))
        .status,
    ).toBe(422);
    const retired = await api()
      .patch(`${BASE}/clusters/${CLUSTER}`)
      .set(as(admin))
      .send({ status: "retired", notes: "Test server" });
    expect(retired.status, JSON.stringify(retired.body)).toBe(200);
    expect(retired.body.data).toMatchObject({ status: "retired", notes: "Test server" });
  });
});
