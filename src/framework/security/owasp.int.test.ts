import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { Container } from "inversify";
import type pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IClock } from "../../application/ports/IClock.js";
import {
  OWNER_PASSWORD,
  ProvisionedTenants,
  type ProvisionedTenant,
} from "../../testing/fixtures/ProvisionedTenants.js";
import { StaffFixtures } from "../../testing/fixtures/StaffFixtures.js";
import { createTestContainer } from "../../testing/testContainer.js";
import { disposeContainer } from "../dependency-injection/container.js";
import { TYPES } from "../dependency-injection/types.js";

/**
 * The internal penetration test of the private beta (P3-8, docs/32), against the OWASP Top 10
 * (2021) as it applies to this API: what an attacker with a valid account in one place tries
 * elsewhere, tampered and stale tokens, enumeration, injection, mass assignment, the HTTP
 * surface and uploads. Findings and the checks that need a deployed system are in docs/32.
 */

class TestClock implements IClock {
  private offsetMs = 0;
  now = () => new Date(Date.now() + this.offsetMs);
  advanceMinutes(minutes: number) {
    this.offsetMs += minutes * 60_000;
  }
}

const AUTH_LIMIT = 25;
const clock = new TestClock();
let container: Container;
let app: Express;
let platform: pg.Pool;
let t: ProvisionedTenant;
let ownerToken: string;
let managerElsewhere: string;
let driverA: { id: string; token: string };
let driverB: { id: string; token: string };
let agreement: string;
let expense: string;

const api = () => request(app);
const as = (token: string) => ({ Authorization: `Bearer ${token}` });
const owner = () => as(ownerToken);
const digits = (n: number) => String(Math.floor(Math.random() * 10 ** n)).padStart(n, "0");
const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");

async function acceptInvitation(text: string): Promise<string> {
  const token = /#token=([A-Za-z0-9_-]+)/.exec(text)![1]!;
  const res = await api()
    .post("/api/v1/auth/invitations/accept")
    .set("X-Tenant", t.slug)
    .send({ token, password: OWNER_PASSWORD });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data.accessToken as string;
}

async function newDriver(branchId?: string) {
  const id = (
    await api()
      .post("/api/v1/drivers")
      .set(owner())
      .send({
        firstName: "Kwame",
        lastName: `Boateng${digits(3)}`,
        phone: `+23324${digits(7)}`,
        ghanaCardNumber: `GHA-${digits(9)}-1`,
        licenceNumber: `DL-${randomUUID().slice(0, 6)}`,
        licenceClass: "B",
        licenceExpiresOn: "2030-01-01",
        employmentType: "workpay",
        ...(branchId === undefined ? {} : { branchId }),
      })
  ).body.data.id as string;
  await api()
    .post(`/api/v1/drivers/${id}/guarantors`)
    .set(owner())
    .send({ name: "Yaw", phone: `020${digits(7)}` });
  await api().post(`/api/v1/drivers/${id}/activate`).set(owner()).send({});
  const access = await api().post(`/api/v1/drivers/${id}/app-access`).set(owner());
  return { id, token: await acceptInvitation(access.body.data.invitation.webUrl as string) };
}

beforeAll(async () => {
  container = await createTestContainer({
    AUTH_RATE_LIMIT_MAX: String(AUTH_LIMIT),
    RATE_LIMIT_MAX: "100000",
  });
  container.rebind<IClock>(TYPES.Clock).toConstantValue(clock);
  app = container.get<Express>(TYPES.HttpApp);
  platform = container.get<pg.Pool>(TYPES.PlatformDatabasePool);
  const staff = await new StaffFixtures(container).create(["super_admin"]);
  t = await new ProvisionedTenants(container, app, staff).create();
  ownerToken = t.ownerAccessToken;

  // A branch manager of another branch.
  const branch = await api()
    .post("/api/v1/branches")
    .set(owner())
    .send({ code: "TML", name: "Tamale" });
  expect(branch.status, JSON.stringify(branch.body)).toBe(201);
  const roles = (await api().get("/api/v1/roles").set(owner())).body.data as {
    id: string;
    systemKey: string | null;
  }[];
  const email = `manager-${randomUUID().slice(0, 8)}@example.com`;
  const invited = await api()
    .post("/api/v1/users/invitations")
    .set(owner())
    .send({
      name: "Tamale manager",
      email,
      branchIds: [branch.body.data.id],
      roles: [
        {
          roleId: roles.find((r) => r.systemKey === "branch_manager")!.id,
          branchId: branch.body.data.id,
        },
      ],
    });
  expect(invited.status, JSON.stringify(invited.body)).toBe(201);
  const { rows } = await platform.query<{ body_text: string }>(
    `select body_text from email_deliveries where recipient = $1
      and template = 'tenant.user_invitation' order by created_at desc limit 1`,
    [email],
  );
  managerElsewhere = await acceptInvitation(rows[0]!.body_text);

  // Two drivers with the app; a draft agreement for the first, in the main branch.
  driverA = await newDriver();
  driverB = await newDriver();
  const vehicle = (
    await api()
      .post("/api/v1/vehicles")
      .set(owner())
      .send({ make: "Kia", model: "Picanto", plateNumber: `GR ${digits(4)}-26`, odometer: 10 })
  ).body.data.id as string;
  const draft = await api()
    .post("/api/v1/workpay/agreements")
    .set(owner())
    .send({
      vehicleId: vehicle,
      driverId: driverA.id,
      terms: {
        vehicleValue: "5000.00",
        pricing: { kind: "multiplier", multiplier: "2" },
        frequency: "weekly",
        periods: 52,
        firstDueOn: new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10),
      },
    });
  expect(draft.status, JSON.stringify(draft.body)).toBe(201);
  agreement = draft.body.data.id as string;
  const categories = (await api().get("/api/v1/expense-categories").set(owner())).body.data as {
    id: string;
    code: string;
  }[];
  expense = (
    await api()
      .post("/api/v1/expenses")
      .set(owner())
      .send({
        categoryId: categories.find((c) => c.code === "other")!.id,
        description: "Office water",
        payeeName: "Voltic",
        amount: "40.00",
      })
  ).body.data.expense.id as string;
}, 120_000);

afterAll(async () => {
  await disposeContainer(container);
});

describe("A01 broken access control", () => {
  it("hides another branch's records from a branch-scoped manager", async () => {
    const res = await api()
      .get(`/api/v1/workpay/agreements/${agreement}`)
      .set(as(managerElsewhere));
    expect(res.status).toBe(404);
    const list = await api().get("/api/v1/workpay/agreements").set(as(managerElsewhere));
    expect((list.body.data as { id: string }[]).map((a) => a.id)).not.toContain(agreement);
    const statement = await api()
      .get(`/api/v1/workpay/agreements/${agreement}/statement`)
      .set(as(managerElsewhere));
    expect(statement.status).toBe(404);
  });

  it("keeps one driver out of another driver's agreement, statement and letter", async () => {
    for (const path of [
      `/api/v1/me/driver/workpay/${agreement}/statement`,
      `/api/v1/me/driver/workpay/${agreement}/statement.pdf`,
      `/api/v1/me/driver/workpay/${agreement}/transfer-letter`,
    ])
      expect((await api().get(path).set(as(driverB.token))).status, path).toBe(404);
    const own = await api()
      .get(`/api/v1/me/driver/workpay/${agreement}/statement`)
      .set(as(driverA.token));
    expect(own.status).toBe(200);
  });

  it("gives a driver login nothing of the staff API", async () => {
    for (const path of ["/api/v1/vehicles", "/api/v1/workpay/agreements", "/api/v1/payments"])
      expect((await api().get(path).set(as(driverA.token))).status, path).toBe(403);
  });

  it("ignores fields a client must not set (mass assignment)", async () => {
    const res = await api()
      .patch(`/api/v1/workpay/agreements/${agreement}`)
      .set(owner())
      .send({ status: "completed", depositPaidMinor: 999_999, graceDays: 4 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toMatchObject({ status: "draft", graceDays: 4 });
    expect(res.body.data.depositPaid.amountMinor).toBe(0);
    const created = await api()
      .post("/api/v1/expenses")
      .set(owner())
      .send({
        categoryId: (await api().get(`/api/v1/expenses/${expense}`).set(owner())).body.data
          .categoryId,
        description: "Self-approved",
        payeeName: "Me",
        amount: "10.00",
        status: "approved",
        approvedBy: randomUUID(),
      });
    expect(created.body.data.expense).toMatchObject({ status: "draft", approvedBy: null });
  });
});

describe("A02/A07 tokens and authentication", () => {
  const parts = () => ownerToken.split(".") as [string, string, string];

  it("rejects an unsigned token (alg none) and a tampered signature", async () => {
    const [, payload] = parts();
    const unsigned = `${b64({ alg: "none", typ: "JWT" })}.${payload}.`;
    expect((await api().get("/api/v1/vehicles").set(as(unsigned))).status).toBe(401);
    const [header, body, signature] = parts();
    const flipped = `${header}.${body}.${signature.slice(0, -2)}${signature.endsWith("AA") ? "BB" : "AA"}`;
    expect((await api().get("/api/v1/vehicles").set(as(flipped))).status).toBe(401);
  });

  it("rejects a token whose claims were raised", async () => {
    const [header, payload, signature] = parts();
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString()) as Record<
      string,
      unknown
    >;
    const forged = `${header}.${b64({ ...claims, sub: randomUUID(), pv: 999 })}.${signature}`;
    expect((await api().get("/api/v1/vehicles").set(as(forged))).status).toBe(401);
  });

  it("rejects an expired token", async () => {
    clock.advanceMinutes(120);
    try {
      expect((await api().get("/api/v1/vehicles").set(owner())).status).toBe(401);
    } finally {
      clock.advanceMinutes(-120);
    }
  });

  it("answers an unknown account and a wrong password the same way", async () => {
    const unknown = await api()
      .post("/api/v1/auth/login")
      .set("X-Tenant", t.slug)
      .send({ identifier: `nobody-${digits(6)}@example.com`, password: "wrong password 1" });
    const wrong = await api()
      .post("/api/v1/auth/login")
      .set("X-Tenant", t.slug)
      .send({ identifier: t.ownerEmail, password: "wrong password 1" });
    expect(unknown.status).toBe(wrong.status);
    expect(unknown.body.error).toMatchObject({
      code: wrong.body.error.code,
      message: wrong.body.error.message,
    });
  });
});

describe("A03 injection", () => {
  it("treats SQL in search and filters as text, never as SQL", async () => {
    const search = await api()
      .get("/api/v1/vehicles")
      .query({ search: "' OR 1=1 --" })
      .set(owner());
    expect(search.status).toBe(200);
    expect(search.body.data).toEqual([]);
    const status = await api()
      .get("/api/v1/workpay/agreements")
      .query({ status: "draft'); drop table workpay_agreements; --" })
      .set(owner());
    expect(status.status).toBe(400);
    const cursor = await api()
      .get("/api/v1/workpay/agreements")
      .query({ cursor: "1' union select * from users --" })
      .set(owner());
    expect(cursor.status).toBe(400);
    expect((await api().get(`/api/v1/workpay/agreements/${agreement}`).set(owner())).status).toBe(
      200,
    );
  });

  it("refuses ids that are not ids", async () => {
    const res = await api().get("/api/v1/workpay/agreements/1%20or%201=1").set(owner());
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_FAILED");
  });
});

describe("A05 security misconfiguration", () => {
  it("sends security headers and no framework banner", async () => {
    const res = await api().get("/health/live");
    expect(res.headers["x-powered-by"]).toBeUndefined();
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["strict-transport-security"]).toMatch(/max-age=\d+/);
    expect(res.headers["content-security-policy"]).toMatch(/default-src/);
    expect(res.headers["x-frame-options"]).toBeDefined();
  });

  it("gives no CORS grant to an unknown origin", async () => {
    const res = await api()
      .options("/api/v1/vehicles")
      .set("Origin", "https://evil.example")
      .set("Access-Control-Request-Method", "GET");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("refuses oversized bodies and answers unknown routes without internals", async () => {
    const huge = await api()
      .post("/api/v1/expenses")
      .set(owner())
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ description: "x".repeat(2_000_000) }));
    expect(huge.status).toBe(413);
    const missing = await api().get("/api/v1/does-not-exist").set(owner());
    expect(missing.status).toBe(404);
    expect(JSON.stringify(missing.body)).not.toMatch(/at \w+ \(|node_modules|\.ts:\d+/);
  });
});

describe("A08 uploads", () => {
  it("refuses file types that can carry scripts, and files over the size limit", async () => {
    const svg = await api()
      .post(`/api/v1/expenses/${expense}/receipts`)
      .set(owner())
      .send({ filename: "receipt.svg", contentType: "image/svg+xml", sizeBytes: 1_000 });
    expect(svg.status).toBe(400);
    const html = await api()
      .post(`/api/v1/expenses/${expense}/receipts`)
      .set(owner())
      .send({ filename: "receipt.html", contentType: "text/html", sizeBytes: 1_000 });
    expect(html.status).toBe(400);
    const big = await api()
      .post(`/api/v1/expenses/${expense}/receipts`)
      .set(owner())
      .send({ filename: "receipt.pdf", contentType: "application/pdf", sizeBytes: 500_000_000 });
    expect(big.status).toBe(400);
  });
});

describe("A07 brute force", () => {
  it("slows down password guessing with a rate limit", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < AUTH_LIMIT + 5; i += 1)
      statuses.push(
        (
          await api()
            .post("/api/v1/auth/login")
            .set("X-Tenant", t.slug)
            .send({ identifier: t.ownerEmail, password: `guess ${i} wrong` })
        ).status,
      );
    expect(statuses).toContain(429);
  });
});
