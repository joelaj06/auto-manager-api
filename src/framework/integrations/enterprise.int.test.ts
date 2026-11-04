import type { Express } from "express";
import type { Container } from "inversify";
import pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IEventHandler } from "../../application/events/IEventHandler.js";
import type { IJobHandler } from "../../application/jobs/IJobHandler.js";
import type { IDnsResolver } from "../../application/ports/ITenantDomains.js";
import type { IWebhookTransport, WebhookResponse } from "../../application/ports/IWebhooks.js";
import type { CustomDomains } from "../../application/use-cases/console/CustomDomains.js";
import { signWebhook } from "../../application/use-cases/integrations/Webhooks.js";
import type { PostgresConnectionFactory } from "../../infrastructure/database/postgres/PostgresConnectionFactory.js";
import { TotpService } from "../../infrastructure/security/TotpService.js";
import {
  ProvisionedTenants,
  type ProvisionedTenant,
} from "../../testing/fixtures/ProvisionedTenants.js";
import { StaffFixtures, type TestStaff } from "../../testing/fixtures/StaffFixtures.js";
import { createTestContainer } from "../../testing/testContainer.js";
import { TEST_DATABASE } from "../../testing/testDatabase.js";
import { disposeContainer } from "../dependency-injection/container.js";
import { TYPES } from "../dependency-injection/types.js";

/**
 * Enterprise extras (P9-7) end to end: API keys acting within their scopes, webhooks from a
 * committed change to a signed delivery with its retries, custom domains from DNS to resolution,
 * a dedicated cluster, and a tenant's own database login with the physical separation it gives.
 */
const CONSOLE = "/api/platform/v1";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- response bodies are checked by expect()
type Body = any;

class FakeTransport implements IWebhookTransport {
  calls: { url: string; headers: Record<string, string>; body: string }[] = [];
  answer: WebhookResponse = { status: 200, error: null };

  post(url: string, headers: Readonly<Record<string, string>>, body: string) {
    this.calls.push({ url, headers: { ...headers }, body });
    return Promise.resolve(this.answer);
  }
}

class FakeDns implements IDnsResolver {
  records = new Map<string, string[]>();
  txt(name: string) {
    return Promise.resolve(this.records.get(name) ?? []);
  }
  cnames() {
    return Promise.resolve([]);
  }
  addresses() {
    return Promise.resolve([]);
  }
}

let container: Container;
let app: Express;
let platform: pg.Pool;
let factory: PostgresConnectionFactory;
let admin: TestStaff;
let approver: TestStaff;
let t: ProvisionedTenant;
let standard: ProvisionedTenant;
const transport = new FakeTransport();
const dns = new FakeDns();

const api = () => request(app);
const owner = (tenant = t) => ({
  Authorization: `Bearer ${tenant.ownerAccessToken}`,
  "X-Tenant": tenant.slug,
});
const as = (who: { accessToken: string }) => ({ Authorization: `Bearer ${who.accessToken}` });
const digits = (n: number) => String(Math.floor(Math.random() * 10 ** n)).padStart(n, "0");
const bearer = (key: string) => ({ Authorization: `Bearer ${key}` });

async function stepUp(who: TestStaff) {
  const code = new TotpService().codeAt(who.totpSecret, new Date(Date.now() + 30_000));
  await api()
    .post(`${CONSOLE}/auth/step-up`)
    .set(as(who))
    .send({ password: who.password, code })
    .expect(204);
}

const handler = (job: string) =>
  container.get<IJobHandler[]>(TYPES.EnterpriseJobHandlers).find((h) => h.job === job)!;

const deliver = (deliveryId: string) =>
  t.tenant.run(() =>
    handler("tenant.webhook_deliver").handle(
      { tenantId: t.tenantId, deliveryId },
      { jobId: "test", attempt: 1 },
    ),
  );

/** What the worker does with the events of a committed change. */
async function publishEvents(): Promise<void> {
  const fanOut = container
    .get<IEventHandler[]>(TYPES.EventHandlers)
    .find((h) => h.name === "webhooks.fan_out")!;
  const events = await t.tenant.query<Body>(
    "select * from outbox where published_at is null order by occurred_at",
  );
  for (const e of events) {
    await t.tenant.run(() =>
      fanOut.handle({
        id: e.id,
        tenantId: t.tenantId,
        eventType: e.event_type,
        aggregateType: e.aggregate_type,
        aggregateId: e.aggregate_id,
        payload: e.payload,
        occurredAt: e.occurred_at,
      }),
    );
    await t.tenant.query("update outbox set published_at = now() where id = $1", [e.id]);
  }
}

const newVehicle = (headers: Record<string, string>, registration: string) =>
  api()
    .post("/api/v1/vehicles")
    .set(headers)
    .send({ plateNumber: registration, make: "Toyota", model: "Corolla", year: 2022 });

beforeAll(async () => {
  container = await createTestContainer({
    AUTH_RATE_LIMIT_MAX: "10000",
    RATE_LIMIT_MAX: "100000",
    CLUSTER_MOVE_SETTLE_MS: "0",
  });
  container.rebind<IWebhookTransport>(TYPES.WebhookTransport).toConstantValue(transport);
  container.rebind<IDnsResolver>(TYPES.DnsResolver).toConstantValue(dns);
  app = container.get<Express>(TYPES.HttpApp);
  platform = container.get<pg.Pool>(TYPES.PlatformDatabasePool);
  factory = container.get<PostgresConnectionFactory>(TYPES.PostgresConnectionFactory);
  const fixtures = new StaffFixtures(container);
  admin = await fixtures.create(["super_admin"]);
  approver = await fixtures.create(["super_admin"]);
  const tenants = new ProvisionedTenants(container, app, admin);
  await stepUp(admin);
  await stepUp(approver);
  t = await tenants.create();
  standard = await tenants.create();
  await platform.query(
    "update subscriptions set licence_type = 'enterprise' where tenant_id = $1",
    [t.tenantId],
  );
}, 180_000);

afterAll(async () => {
  await disposeContainer(container);
});

describe("API keys", () => {
  let key: string;
  let keyId: string;

  it("belongs to the Enterprise licence", async () => {
    const res = await api()
      .post("/api/v1/integrations/api-keys")
      .set(owner(standard))
      .send({ name: "ERP", scopes: ["vehicles.list"] });
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error.code).toBe("ENTERPRISE_LICENCE_REQUIRED");
  });

  it("refuses scopes a key may not hold", async () => {
    const scopes = await api().get("/api/v1/integrations/api-key-scopes").set(owner()).expect(200);
    const keys = scopes.body.data.map((s: Body) => s.key as string);
    expect(keys).toContain("vehicles.list");
    expect(keys).not.toContain("users.invite");
    expect(keys).not.toContain("integrations.manage");
    expect(keys).not.toContain("billing.manage");
    const refused = await api()
      .post("/api/v1/integrations/api-keys")
      .set(owner())
      .send({ name: "Too much", scopes: ["roles.update"] });
    expect(refused.status).toBe(422);
  });

  it("is shown once, kept as a hash and finds its business without a header", async () => {
    const created = await api()
      .post("/api/v1/integrations/api-keys")
      .set(owner())
      .send({ name: "ERP", scopes: ["vehicles.list", "vehicles.view"] });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    key = created.body.data.key;
    keyId = created.body.data.id;
    expect(key).toMatch(/^afk_[0-9a-f]{32}_/);

    const rows = await t.tenant.query<Body>("select * from api_keys where id = $1", [keyId]);
    expect(JSON.stringify(rows[0])).not.toContain(key);

    await api().get("/api/v1/vehicles").set(bearer(key)).expect(200);
    const listed = await api().get("/api/v1/integrations/api-keys").set(owner()).expect(200);
    const seen = listed.body.data.find((k: Body) => k.id === keyId);
    expect(seen.key).toBeUndefined();
    expect(seen.requests).toBe(1);
    expect(seen.lastUsedAt).not.toBeNull();
  });

  it("does only what its scopes allow, and no personal routes", async () => {
    const write = await newVehicle(bearer(key), `GX ${digits(4)}-26`);
    expect(write.status).toBe(403);
    await api().get("/api/v1/me").set(bearer(key)).expect(403);
    await api().get("/api/v1/integrations/api-keys").set(bearer(key)).expect(403);
  });

  it("must match the business a request addresses", async () => {
    const res = await api()
      .get("/api/v1/vehicles")
      .set({ ...bearer(key), "X-Tenant": standard.slug });
    expect(res.body.error.code).toBe("TENANT_MISMATCH");
    await api()
      .get("/api/v1/vehicles")
      .set(bearer(`${key}x`))
      .expect(401);
    await api()
      .get("/api/v1/vehicles")
      .set(bearer(`afk_${standard.tenantId.replaceAll("-", "")}_${key.slice(-43)}`))
      .expect(403);
  });

  it("names itself in the audit log", async () => {
    const created = await api()
      .post("/api/v1/integrations/api-keys")
      .set(owner())
      .send({ name: "Writer", scopes: ["vehicles.create", "vehicles.view", "vehicles.list"] });
    const writer = created.body.data.key as string;
    const res = await newVehicle(bearer(writer), `GN ${digits(4)}-26`);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const logged = await t.tenant.query<Body>(
      "select metadata from audit_logs where action = 'vehicle.created' and entity_id = $1",
      [res.body.data.id],
    );
    expect(logged[0].metadata.apiKey).toEqual({ id: created.body.data.id, name: "Writer" });
  });

  it("stops at once when revoked, and when it expires", async () => {
    await api().delete(`/api/v1/integrations/api-keys/${keyId}`).set(owner()).expect(204);
    await api().get("/api/v1/vehicles").set(bearer(key)).expect(401);

    const expiring = await api()
      .post("/api/v1/integrations/api-keys")
      .set(owner())
      .send({
        name: "Short",
        scopes: ["vehicles.list"],
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
    await t.tenant.query(
      "update api_keys set expires_at = now() - interval '1 minute' where id = $1",
      [expiring.body.data.id],
    );
    await api().get("/api/v1/vehicles").set(bearer(expiring.body.data.key)).expect(401);
  });

  it("is shown in the console, which can stop it", async () => {
    const created = await api()
      .post("/api/v1/integrations/api-keys")
      .set(owner())
      .send({ name: "Leaked", scopes: ["vehicles.list"] });
    const overview = await api()
      .get(`${CONSOLE}/tenants/${t.tenantId}/integrations`)
      .set(as(admin))
      .expect(200);
    expect(overview.body.data.apiKeys.some((k: Body) => k.name === "Leaked")).toBe(true);
    expect(JSON.stringify(overview.body.data)).not.toContain("key_hash");
    await api()
      .post(`${CONSOLE}/tenants/${t.tenantId}/api-keys/${created.body.data.id}/revoke`)
      .set(as(admin))
      .send({ reason: "Customer reported a leak" })
      .expect(204);
    await api().get("/api/v1/vehicles").set(bearer(created.body.data.key)).expect(401);
  });
});

describe("webhooks", () => {
  let endpointId: string;
  let secret: string;

  it("refuses private addresses and unknown events", async () => {
    for (const url of ["http://hooks.example.com/in", "https://169.254.169.254/latest"]) {
      const res = await api()
        .post("/api/v1/integrations/webhooks")
        .set(owner())
        .send({ url, events: ["vehicle.created"] });
      expect(res.status, url).toBe(422);
    }
    const unknown = await api()
      .post("/api/v1/integrations/webhooks")
      .set(owner())
      .send({ url: "https://hooks.example.com/in", events: ["nothing.happened"] });
    expect(unknown.status).toBe(422);
  });

  it("writes no event while nobody listens", async () => {
    const res = await newVehicle(owner(), `GR ${digits(4)}-26`);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const events = await t.tenant.query<Body>(
      "select 1 from outbox where event_type = 'vehicle.created'",
    );
    expect(events).toHaveLength(0);
  });

  it("delivers a signed, thin event for a committed change", async () => {
    const created = await api()
      .post("/api/v1/integrations/webhooks")
      .set(owner())
      .send({ url: "https://hooks.example.com/in", events: ["vehicle.created"] });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    endpointId = created.body.data.id;
    secret = created.body.data.secret;
    expect(secret).toMatch(/^whsec_/);
    const stored = await t.tenant.query<Body>(
      "select sealed_secret from webhook_endpoints where id = $1",
      [endpointId],
    );
    expect(stored[0].sealed_secret).not.toContain(secret);

    const vehicle = await newVehicle(owner(), `AS ${digits(4)}-26`);
    expect(vehicle.status).toBe(201);
    await publishEvents();
    // The same event again finds its delivery already made.
    const [delivery] = await t.tenant.query<Body>(
      "select id from webhook_deliveries where endpoint_id = $1",
      [endpointId],
    );
    await deliver(delivery.id);

    expect(transport.calls).toHaveLength(1);
    const call = transport.calls[0]!;
    const sent = JSON.parse(call.body);
    expect(sent).toMatchObject({
      type: "vehicle.created",
      tenant: t.slug,
      data: { entityType: "vehicle", entityId: vehicle.body.data.id },
    });
    expect(call.body).not.toContain("Toyota");
    expect(call.headers["X-Autoforce-Event"]).toBe("vehicle.created");
    const stamp = /^t=(\d+),v1=/.exec(call.headers["X-Autoforce-Signature"]!)![1]!;
    expect(call.headers["X-Autoforce-Signature"]).toBe(
      signWebhook(secret, call.body, Number(stamp)),
    );

    const deliveries = await api()
      .get(`/api/v1/integrations/webhooks/${endpointId}/deliveries`)
      .set(owner())
      .expect(200);
    expect(deliveries.body.data[0]).toMatchObject({
      status: "delivered",
      attempts: 1,
      lastStatus: 200,
    });
  });

  it("retries a failure on the same bytes, then gives up, and can replay", async () => {
    transport.calls = [];
    transport.answer = { status: 503, error: null };
    const test = await api()
      .post(`/api/v1/integrations/webhooks/${endpointId}/test`)
      .set(owner())
      .expect(202);
    const { deliveryId } = test.body.data;

    await deliver(deliveryId);
    const [first] = await t.tenant.query<Body>("select * from webhook_deliveries where id = $1", [
      deliveryId,
    ]);
    expect(first).toMatchObject({ status: "pending", attempts: 1, last_status: 503 });
    expect(first.next_attempt_at.getTime()).toBeGreaterThan(Date.now());

    for (let i = 0; i < 6; i += 1) await deliver(deliveryId);
    const [last] = await t.tenant.query<Body>("select * from webhook_deliveries where id = $1", [
      deliveryId,
    ]);
    expect(last).toMatchObject({ status: "failed", attempts: 7, next_attempt_at: null });
    expect(new Set(transport.calls.map((c) => c.body)).size).toBe(1);

    transport.answer = { status: 204, error: null };
    await api()
      .post(`/api/v1/integrations/webhook-deliveries/${deliveryId}/replay`)
      .set(owner())
      .expect(202);
    await deliver(deliveryId);
    const [replayed] = await t.tenant.query<Body>(
      "select status from webhook_deliveries where id = $1",
      [deliveryId],
    );
    expect(replayed.status).toBe("delivered");
  });

  it("switches off an address that has failed for days and tells the business", async () => {
    await t.tenant.query(
      `update webhook_endpoints set consecutive_failures = 40,
              last_success_at = now() - interval '4 days' where id = $1`,
      [endpointId],
    );
    transport.answer = { status: 500, error: null };
    const test = await api()
      .post(`/api/v1/integrations/webhooks/${endpointId}/test`)
      .set(owner())
      .expect(202);
    await deliver(test.body.data.deliveryId);
    const [endpoint] = await t.tenant.query<Body>(
      "select status, disabled_reason from webhook_endpoints where id = $1",
      [endpointId],
    );
    expect(endpoint.status).toBe("disabled");
    const inbox = await t.tenant.query<Body>(
      "select 1 from notifications where title = 'A webhook address was switched off'",
    );
    expect(inbox.length).toBeGreaterThan(0);
  });

  it("rotates the secret, and a new one signs", async () => {
    const before = await t.tenant.query<Body>(
      "select sealed_secret from webhook_endpoints where id = $1",
      [endpointId],
    );
    const rotated = await api()
      .post(`/api/v1/integrations/webhooks/${endpointId}/rotate-secret`)
      .set(owner())
      .expect(200);
    expect(rotated.body.data.secret).not.toBe(secret);
    const after = await t.tenant.query<Body>(
      "select sealed_secret from webhook_endpoints where id = $1",
      [endpointId],
    );
    expect(after[0].sealed_secret).not.toBe(before[0].sealed_secret);
  });
});

describe("custom domains", () => {
  const domain = `fleet-${Date.now().toString(36)}.example.com`;
  let id: string;
  let txt: { name: string; value: string };

  const lookup = () => container.get<{ forget(): void }>(TYPES.TenantDomainLookup);

  it("needs the Enterprise licence and a real host name", async () => {
    await api()
      .post(`${CONSOLE}/tenants/${standard.tenantId}/domains`)
      .set(as(admin))
      .send({ domain })
      .expect(403);
    await api()
      .post(`${CONSOLE}/tenants/${t.tenantId}/domains`)
      .set(as(admin))
      .send({ domain: "not a domain" })
      .expect(422);
  });

  it("does nothing until the DNS proves the domain", async () => {
    const added = await api()
      .post(`${CONSOLE}/tenants/${t.tenantId}/domains`)
      .set(as(admin))
      .send({ domain })
      .expect(201);
    id = added.body.data.id;
    txt = added.body.data.dns.txt;
    expect(added.body.data.status).toBe("pending");

    const failed = await api()
      .post(`${CONSOLE}/tenants/${t.tenantId}/domains/${id}/verify`)
      .set(as(admin))
      .expect(200);
    expect(failed.body.data.status).toBe("pending");
    expect(failed.body.data.lastError).toContain("TXT");
    await api().get("/api/v1/public/domains/allowed").query({ domain }).expect(404);
    await api().get("/api/v1/public/tenant-config").set("Host", domain).expect(404);
  });

  it("goes live with the record, and the host name says which business it is", async () => {
    dns.records.set(txt.name, [txt.value]);
    const verified = await api()
      .post(`${CONSOLE}/tenants/${t.tenantId}/domains/${id}/verify`)
      .set(as(admin))
      .expect(200);
    expect(verified.body.data.status).toBe("active");

    await api().get("/api/v1/public/domains/allowed").query({ domain }).expect(200);
    const config = await api().get("/api/v1/public/tenant-config").set("Host", domain).expect(200);
    expect(config.body.data.tenant.slug).toBe(t.slug);

    // A signed-in request on the domain needs no header, and a header must agree with it.
    await api()
      .get("/api/v1/vehicles")
      .set({ Host: domain, Authorization: `Bearer ${t.ownerAccessToken}` })
      .expect(200);
    const mismatch = await api()
      .get("/api/v1/vehicles")
      .set({ Host: domain, ...owner(standard) });
    expect(mismatch.body.error.code).toBe("TENANT_MISMATCH");
  });

  it("refuses a domain somebody else holds", async () => {
    await platform.query(
      "update subscriptions set licence_type = 'enterprise' where tenant_id = $1",
      [standard.tenantId],
    );
    lookup().forget();
    const taken = await request(app)
      .post(`${CONSOLE}/tenants/${t.tenantId}/domains`)
      .set(as(admin))
      .send({ domain });
    expect(taken.status).toBe(422);
    await platform.query(
      "update subscriptions set licence_type = 'standard' where tenant_id = $1",
      [standard.tenantId],
    );
  });

  it("suspends after three days without the record and comes back with it", async () => {
    const domains = container.get<CustomDomains>(TYPES.CustomDomains);
    dns.records.clear();
    await domains.sweep();
    await domains.sweep();
    await api().get("/api/v1/public/domains/allowed").query({ domain }).expect(200);
    await domains.sweep();
    const list = await api()
      .get(`${CONSOLE}/tenants/${t.tenantId}/domains`)
      .set(as(admin))
      .expect(200);
    expect(list.body.data[0].status).toBe("suspended");
    await api().get("/api/v1/public/domains/allowed").query({ domain }).expect(404);

    dns.records.set(txt.name, [txt.value]);
    await domains.sweep();
    await api().get("/api/v1/public/domains/allowed").query({ domain }).expect(200);
  });

  it("is removed from the console", async () => {
    await api().delete(`${CONSOLE}/tenants/${t.tenantId}/domains/${id}`).set(as(admin)).expect(204);
    await api().get("/api/v1/public/domains/allowed").query({ domain }).expect(404);
  });
});

describe("dedicated clusters", () => {
  const cluster = `kept-${Date.now().toString(36)}`;

  it("keeps a cluster for an Enterprise tenant and no new tenant lands on it", async () => {
    await platform.query(
      "insert into clusters (id, name, host, port) values ($1, 'Kept', 'db.internal', 5432)",
      [cluster],
    );
    const reason = "Enterprise contract";
    await api()
      .post(`${CONSOLE}/clusters/main/dedication`)
      .set(as(admin))
      .send({ tenantId: t.tenantId, reason })
      .expect(422);
    await api()
      .post(`${CONSOLE}/clusters/${cluster}/dedication`)
      .set(as(admin))
      .send({ tenantId: standard.tenantId, reason })
      .expect(403);
    await api()
      .post(`${CONSOLE}/clusters/${cluster}/dedication`)
      .set(as(admin))
      .send({ tenantId: t.tenantId, reason })
      .expect(200);

    const refused = await api()
      .post(`${CONSOLE}/tenants/${standard.tenantId}/cluster-move`)
      .set(as(admin))
      .send({ clusterId: cluster, reason: "Should not go" });
    expect(refused.status).toBe(422);
    expect(refused.body.error.message).toContain("kept for another tenant");

    await api()
      .post(`${CONSOLE}/clusters/${cluster}/dedication`)
      .set(as(admin))
      .send({ tenantId: null, reason: "Contract ended" })
      .expect(200);
    await platform.query("delete from clusters where id = $1", [cluster]);
  });
});

describe("a tenant's own database login", () => {
  const databaseOf = (tenant: ProvisionedTenant) =>
    `${TEST_DATABASE.tenantPrefix}${tenant.tenantId.replaceAll("-", "")}`;

  async function connectAs(user: string, password: string, database: string): Promise<pg.Client> {
    const config = factory.clientConfig("tenant", database);
    const client = new pg.Client({ ...config, user, password });
    await client.connect();
    return client;
  }

  async function currentPassword(): Promise<string> {
    const { rows } = await platform.query<Body>(
      "select sealed_password from tenant_database_credentials where tenant_id = $1",
      [t.tenantId],
    );
    const box = container.get<{ open(s: string): string }>(TYPES.CredentialsSecretBox);
    return box.open(rows[0].sealed_password);
  }

  const runLogin = (action: "enable" | "rotate" | "disable") =>
    handler("tenant.database_credentials").handle(
      { tenantId: t.tenantId, action },
      { jobId: "test", attempt: 1 },
    );

  it("needs Enterprise and a second person's approval", async () => {
    await api()
      .post(`${CONSOLE}/tenants/${standard.tenantId}/database-login`)
      .set(as(admin))
      .send({ action: "enable", reason: "Contract" })
      .expect(403);

    const asked = await api()
      .post(`${CONSOLE}/tenants/${t.tenantId}/database-login`)
      .set(as(admin))
      .send({ action: "enable", reason: "Contract" })
      .expect(202);
    const approved = await api()
      .post(`${CONSOLE}/approvals/${asked.body.data.approvalId}/approve`)
      .set(as(approver))
      .send({ note: "Checked" });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.data.status).toBe("approved");
  });

  it("reaches its own database and no other, and the shared login loses it", async () => {
    await runLogin("enable");
    const status = await api()
      .get(`${CONSOLE}/tenants/${t.tenantId}/database-login`)
      .set(as(admin))
      .expect(200);
    expect(status.body.data).toMatchObject({ enabled: true, status: "active", version: 1 });
    expect(JSON.stringify(status.body.data)).not.toContain("sealed");

    const role = status.body.data.role as string;
    const password = await currentPassword();
    const own = await connectAs(role, password, databaseOf(t));
    const who = await own.query<Body>(
      "select session_user::text as login, current_user::text as acting, count(*)::int as n from users",
    );
    expect(who.rows[0]).toMatchObject({ login: role, acting: "af_tenant_rw" });
    expect(who.rows[0].n).toBeGreaterThan(0);
    // The same rights as the shared login: the audit trail is still append-only.
    await expect(own.query("delete from audit_logs")).rejects.toThrow();
    await own.end();

    await expect(connectAs(role, password, databaseOf(standard))).rejects.toThrow(
      /permission denied for database/,
    );
    const shared = factory.clientConfig("tenant", databaseOf(t));
    const client = new pg.Client(shared);
    await expect(client.connect()).rejects.toThrow(/permission denied for database/);
    await client.end().catch(() => undefined);

    // The app carries on through the new login, the other tenant through the shared one.
    await api().get("/api/v1/vehicles").set(owner()).expect(200);
    await api().get("/api/v1/vehicles").set(owner(standard)).expect(200);
  });

  it("changes the password and retires the pools that used the old one", async () => {
    const before = await currentPassword();
    await runLogin("rotate");
    const after = await currentPassword();
    expect(after).not.toBe(before);
    await api().get("/api/v1/vehicles").set(owner()).expect(200);
    const status = await api()
      .get(`${CONSOLE}/tenants/${t.tenantId}/database-login`)
      .set(as(admin))
      .expect(200);
    expect(status.body.data.version).toBe(2);
    await expect(connectAs(status.body.data.role as string, before, databaseOf(t))).rejects.toThrow(
      /password authentication failed/,
    );
  });

  it("goes back to the shared login with nothing left behind", async () => {
    const { role } = (
      await api().get(`${CONSOLE}/tenants/${t.tenantId}/database-login`).set(as(admin)).expect(200)
    ).body.data;
    await runLogin("disable");
    await api().get("/api/v1/vehicles").set(owner()).expect(200);
    const client = new pg.Client(factory.clientConfig("tenant", databaseOf(t)));
    await client.connect();
    await client.end();
    const migrator = await factory.connect("migrator", TEST_DATABASE.platformDatabase);
    try {
      const left = await migrator.query("select 1 from pg_roles where rolname = $1", [role]);
      expect(left.rowCount).toBe(0);
    } finally {
      await migrator.end();
    }
    const status = await api()
      .get(`${CONSOLE}/tenants/${t.tenantId}/database-login`)
      .set(as(admin))
      .expect(200);
    expect(status.body.data).toEqual({ enabled: false });
  });
});
