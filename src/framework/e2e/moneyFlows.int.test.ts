import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Express } from "express";
import type { Container } from "inversify";
import type pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ITenantDailyTask } from "../../application/jobs/ITenantDailyTask.js";
import type { IClock } from "../../application/ports/IClock.js";
import { DatabaseBackupService } from "../../infrastructure/backup/DatabaseBackupService.js";
import { LocalBackupStorage } from "../../infrastructure/backup/LocalBackupStorage.js";
import { PgClientTools } from "../../infrastructure/backup/PgClientTools.js";
import { PostgresBackupCatalog } from "../../infrastructure/backup/PostgresBackupCatalog.js";
import type { PostgresConnectionFactory } from "../../infrastructure/database/postgres/PostgresConnectionFactory.js";
import type { TenantDatabaseNaming } from "../../infrastructure/database/postgres/TenantDatabaseNaming.js";
import {
  OWNER_PASSWORD,
  ProvisionedTenants,
  type ProvisionedTenant,
} from "../../testing/fixtures/ProvisionedTenants.js";
import { signaturePng } from "../../testing/fixtures/signaturePng.js";
import { StaffFixtures } from "../../testing/fixtures/StaffFixtures.js";
import { createTestContainer } from "../../testing/testContainer.js";
import { testConfig } from "../../testing/testDatabase.js";
import { disposeContainer } from "../dependency-injection/container.js";
import { TYPES } from "../dependency-injection/types.js";

/**
 * The M2 exit criterion (docs/30): money through every module of the private beta — remittances,
 * an invoice paid and the payment reversed, and a work and pay agreement from signature to
 * ownership transfer (pay, arrears, restructure, a cost charged to the agreement, paid in full,
 * transfer letter signed by both) — with the books checked after every step (ledger balanced,
 * allocations and sub-ledgers agreeing), and finally a backup restored and verified with the
 * same checks.
 */

class TestClock implements IClock {
  private offsetMs = 0;
  now = () => new Date(Date.now() + this.offsetMs);
  advanceDays(days: number) {
    this.offsetMs += days * 86_400_000;
  }
}

const clock = new TestClock();
let container: Container;
let app: Express;
let t: ProvisionedTenant;
let ownerToken: string;
let checklist: { items: { key: string; ok: boolean }[] };
let categories: Record<string, string>;

const api = () => request(app);
const owner = () => ({ Authorization: `Bearer ${ownerToken}` });
const digits = (n: number) => String(Math.floor(Math.random() * 10 ** n)).padStart(n, "0");
const day = (offset: number) =>
  new Date(clock.now().getTime() + offset * 86_400_000).toISOString().slice(0, 10);
const momo = () => ({ method: "momo", momoNetwork: "mtn", reference: `E2E-${digits(6)}` });
const drawn = { type: "drawn", png: signaturePng() };

async function login(identifier: string): Promise<string> {
  const res = await api()
    .post("/api/v1/auth/login")
    .set("X-Tenant", t.slug)
    .send({ identifier, password: OWNER_PASSWORD });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data.accessToken as string;
}

/** Moves the clock and signs the owner in again (tokens expire with the clock). */
async function travel(days: number) {
  clock.advanceDays(days);
  ownerToken = await login(t.ownerEmail);
}

/** The books are intact: every integrity check passes and the trial balance balances. */
async function booksIntact(step: string) {
  const res = await api().get("/api/v1/ledger/integrity").set(owner());
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const failed = (res.body.data.checks as { name: string; passed: boolean }[]).filter(
    (c) => !c.passed,
  );
  expect(failed, `${step}: ${JSON.stringify(failed)}`).toEqual([]);
  const tb = await api().get("/api/v1/ledger/trial-balance").set(owner());
  expect(tb.body.data.balanced, step).toBe(true);
}

const dailyTask = (name: string) =>
  t.tenant.run(() =>
    container
      .get<ITenantDailyTask[]>(TYPES.TenantDailyTasks)
      .find((task) => task.name === name)!
      .run(day(0)),
  );

async function newDriver(employmentType: string) {
  const phone = `+23324${digits(7)}`;
  const id = (
    await api()
      .post("/api/v1/drivers")
      .set(owner())
      .send({
        firstName: "Esi",
        lastName: `Mensah${digits(3)}`,
        phone,
        ghanaCardNumber: `GHA-${digits(9)}-1`,
        licenceNumber: `DL-${randomUUID().slice(0, 6)}`,
        licenceClass: "B",
        licenceExpiresOn: "2030-01-01",
        employmentType,
      })
  ).body.data.id as string;
  await api()
    .post(`/api/v1/drivers/${id}/guarantors`)
    .set(owner())
    .send({ name: "Yaw", phone: `020${digits(7)}` });
  await api().post(`/api/v1/drivers/${id}/activate`).set(owner()).send({});
  return { id, phone };
}

async function newVehicle() {
  return (
    await api()
      .post("/api/v1/vehicles")
      .set(owner())
      .send({ make: "Toyota", model: "Vitz", plateNumber: `GR ${digits(4)}-26`, odometer: 1_000 })
  ).body.data.id as string;
}

beforeAll(async () => {
  container = await createTestContainer({ AUTH_RATE_LIMIT_MAX: "10000", RATE_LIMIT_MAX: "100000" });
  container.rebind<IClock>(TYPES.Clock).toConstantValue(clock);
  app = container.get<Express>(TYPES.HttpApp);
  const staff = await new StaffFixtures(container).create(["super_admin"]);
  t = await new ProvisionedTenants(container, app, staff).create();
  ownerToken = t.ownerAccessToken;
  await api().patch("/api/v1/settings/documents").set(owner()).send({ requireOtp: false });
  await api().patch("/api/v1/settings/workpay").set(owner()).send({ driverExpenses: "agreement" });
  const handover = await api().get("/api/v1/settings/assignments").set(owner());
  checklist = {
    items: (handover.body.data.handoverItems as { key: string }[]).map((i) => ({
      key: i.key,
      ok: true,
    })),
  };
  const tree = await api().get("/api/v1/expense-categories").set(owner());
  categories = Object.fromEntries(
    (tree.body.data as { code: string; id: string }[]).map((c) => [c.code, c.id]),
  );
  await api()
    .post("/api/v1/expense-approval-rules")
    .set(owner())
    .send({ name: "Small spend", maxAmount: "5000.00", action: "auto_approve", priority: 10 });
}, 120_000);

afterAll(async () => {
  await disposeContainer(container);
});

describe("money flows end to end", () => {
  it("collects remittances", async () => {
    const driver = await newDriver("remittance");
    const vehicle = await newVehicle();
    const assigned = await api()
      .post(`/api/v1/vehicles/${vehicle}/assignment`)
      .set(owner())
      .send({
        driverId: driver.id,
        odometer: 1_000,
        checklist,
        terms: { mode: "fixed_target", target: "150.00", frequency: "daily" },
        startedAt: new Date(`${day(-3)}T06:00:00Z`).toISOString(),
      });
    expect(assigned.status, JSON.stringify(assigned.body)).toBe(201);
    await dailyTask("remittances");
    const rows = (await api().get(`/api/v1/remittances?driverId=${driver.id}`).set(owner())).body
      .data as { id: string; periodStart: string }[];
    const first = rows.find((r) => r.periodStart === day(-3))!;
    const paid = await api()
      .post(`/api/v1/remittances/${first.id}/record`)
      .set(owner())
      .send({ amount: "150.00", method: "bank_transfer" });
    expect(paid.body.data.status).toBe("paid");
    await booksIntact("remittances");
  });

  it("takes an invoice payment and reverses it", async () => {
    const customer = (
      await api()
        .post("/api/v1/customers")
        .set(owner())
        .send({ type: "individual", firstName: "Ama", lastName: "Owusu", phone: `024${digits(7)}` })
    ).body.data.id as string;
    const draft = await api()
      .post("/api/v1/invoices")
      .set(owner())
      .send({
        partyType: "customer",
        partyId: customer,
        lines: [{ description: "Car hire", quantity: 2, unitPrice: "400.00" }],
      });
    const invoice = await api().post(`/api/v1/invoices/${draft.body.data.id}/issue`).set(owner());
    expect(invoice.status, JSON.stringify(invoice.body)).toBe(200);
    const payment = await api()
      .post("/api/v1/payments")
      .set(owner())
      .send({
        direction: "in",
        partyType: "customer",
        partyId: customer,
        amount: "1000.00",
        ...momo(),
        allocations: [{ invoiceId: invoice.body.data.id, amount: "800.00" }],
      });
    expect(payment.status, JSON.stringify(payment.body)).toBe(201);
    await booksIntact("invoice paid");
    await api()
      .post(`/api/v1/payments/${payment.body.data.id}/reverse`)
      .set(owner())
      .send({ reason: "Bounced" });
    await booksIntact("payment reversed");
  });

  describe("a work and pay agreement from signature to ownership", () => {
    let agreement: string;
    let vehicle: string;
    let driverPhone: string;
    let driverToken: string;
    const balance = async () =>
      (await api().get(`/api/v1/workpay/agreements/${agreement}/balance`).set(owner())).body
        .data as {
        status: string;
        outstanding: { amountMinor: number };
        penaltiesOutstanding: { amountMinor: number };
        chargesOutstanding: { amountMinor: number };
      };
    const pay = (amount: string) =>
      api()
        .post(`/api/v1/workpay/agreements/${agreement}/payments`)
        .set(owner())
        .send({ amount, ...momo() });
    const sign = async (as: Record<string, string>, documentId: string) => {
      const tasks = (await api().get("/api/v1/me/signatures").set(as)).body.data as {
        signer: { id: string };
        document: { id: string };
      }[];
      const task = tasks.find((x) => x.document.id === documentId)!;
      const signed = await api()
        .post(`/api/v1/me/signatures/${task.signer.id}/sign`)
        .set(as)
        .send({ signature: drawn, consent: true });
      expect(signed.status, JSON.stringify(signed.body)).toBe(200);
    };

    it("is signed, takes the deposit and starts", async () => {
      const driver = await newDriver("workpay");
      driverPhone = driver.phone;
      const access = await api().post(`/api/v1/drivers/${driver.id}/app-access`).set(owner());
      const token = /#token=([A-Za-z0-9_-]+)/.exec(
        access.body.data.invitation.webUrl as string,
      )![1]!;
      await api()
        .post("/api/v1/auth/invitations/accept")
        .set("X-Tenant", t.slug)
        .send({ token, password: OWNER_PASSWORD });
      driverToken = await login(driverPhone);
      vehicle = await newVehicle();
      const draft = await api()
        .post("/api/v1/workpay/agreements")
        .set(owner())
        .send({
          vehicleId: vehicle,
          driverId: driver.id,
          terms: {
            vehicleValue: "6000.00",
            pricing: { kind: "total", total: "7200.00" },
            deposit: "1200.00",
            frequency: "weekly",
            periods: 6,
            firstDueOn: day(7),
            roundTo: "1.00",
          },
          graceDays: 2,
          penalty: { kind: "flat", amount: "20.00" },
          insurance: "driver",
        });
      expect(draft.status, JSON.stringify(draft.body)).toBe(201);
      agreement = draft.body.data.id as string;
      const sent = await api()
        .post(`/api/v1/workpay/agreements/${agreement}/send-for-signature`)
        .set(owner())
        .send({});
      for (const as of [owner(), { Authorization: `Bearer ${driverToken}` }])
        await sign(as, sent.body.data.document.id as string);
      await api()
        .post(`/api/v1/workpay/agreements/${agreement}/deposit`)
        .set(owner())
        .send({ amount: "1200.00", ...momo() });
      const active = await api()
        .post(`/api/v1/workpay/agreements/${agreement}/activate`)
        .set(owner())
        .send({ odometer: 1_100, checklist });
      expect(active.body.data.status).toBe("active");
      await booksIntact("agreement started");
    });

    it("is paid, falls into arrears with a late fee, and is restructured", async () => {
      expect((await pay("1000.00")).status).toBe(201);
      await booksIntact("first instalment paid");
      await travel(17); // instalment 2 due day 14, grace 2: overdue from day 17
      await dailyTask("workpay_arrears");
      expect(await balance()).toMatchObject({
        status: "in_arrears",
        penaltiesOutstanding: { amountMinor: 2_000 },
      });
      await booksIntact("in arrears");
      const res = await api()
        .post(`/api/v1/workpay/agreements/${agreement}/restructure`)
        .set(owner())
        .send({ frequency: "monthly", periods: 3, firstDueOn: day(10), reason: "Hard month" });
      expect(res.body.data).toMatchObject({
        status: "active",
        outstanding: { amountMinor: 500_000 },
      });
      await booksIntact("restructured");
    });

    it("carries the driver's insurance as a charge on the agreement", async () => {
      const expense = await api()
        .post("/api/v1/expenses")
        .set(owner())
        .send({
          categoryId: categories.insurance,
          description: "Comprehensive insurance",
          payeeName: "Star Assurance",
          amount: "250.00",
          vehicleIds: [vehicle],
        });
      await api().post(`/api/v1/expenses/${expense.body.data.expense.id}/submit`).set(owner());
      expect((await balance()).chargesOutstanding.amountMinor).toBe(25_000);
      await booksIntact("charge added");
    });

    it("is paid in full and the vehicle becomes the driver's once both sign the letter", async () => {
      const b = await balance();
      const all =
        b.outstanding.amountMinor +
        b.penaltiesOutstanding.amountMinor +
        b.chargesOutstanding.amountMinor;
      const res = await pay((all / 100).toFixed(2));
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.data.balance.status).toBe("completed");
      await booksIntact("paid in full");

      const transfer = await api()
        .get(`/api/v1/workpay/agreements/${agreement}/transfer`)
        .set(owner());
      const letter = transfer.body.data.document.id as string;
      driverToken = await login(driverPhone);
      await sign(owner(), letter);
      await sign({ Authorization: `Bearer ${driverToken}` }, letter);
      const car = await api().get(`/api/v1/vehicles/${vehicle}`).set(owner());
      expect(car.body.data).toMatchObject({ status: "transferred", ownershipType: "driver_owned" });
      await booksIntact("ownership transferred");
    });
  });

  it("backs the tenant up and restores it with the books intact", async () => {
    const config = testConfig();
    const keys = generateKeyPairSync("rsa", { modulusLength: 3072 });
    const directory = await mkdtemp(join(tmpdir(), "autoforce-e2e-"));
    try {
      const service = new DatabaseBackupService({
        connections: container.get<PostgresConnectionFactory>(TYPES.PostgresConnectionFactory),
        naming: container.get<TenantDatabaseNaming>(TYPES.TenantDatabaseNaming),
        tools: new PgClientTools({
          mode: (process.env.BACKUP_PG_TOOLS as "local" | "docker" | undefined) ?? "docker",
          image: config.backup.pgTools.image,
        }),
        storage: new LocalBackupStorage(directory),
        catalog: new PostgresBackupCatalog(container.get<pg.Pool>(TYPES.PlatformDatabasePool)),
        platformDatabase: config.database.platformDatabase,
        tenantTemplateDatabase: config.database.tenantTemplateDatabase,
        publicKey: keys.publicKey,
      });
      const backup = await service.backupTenant(t.tenantId);
      const report = await service.verify(backup.id, keys.privateKey);
      const failed = report.checks.filter((c) => !c.passed);
      expect(failed, JSON.stringify(failed)).toEqual([]);
      expect(report.checks.map((c) => c.name)).toEqual(
        expect.arrayContaining([
          "row counts",
          "integrity: trial balance",
          "integrity: work and pay receivables",
          "integrity: work and pay unearned income",
        ]),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 180_000);
});
