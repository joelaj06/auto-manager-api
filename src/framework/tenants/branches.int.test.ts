import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { Container } from "inversify";
import type pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BranchReconciliation } from "../../application/use-cases/billing/BranchReconciliation.js";
import { TotpService } from "../../infrastructure/security/TotpService.js";
import {
  OWNER_PASSWORD,
  ProvisionedTenants,
  type ProvisionedTenant,
} from "../../testing/fixtures/ProvisionedTenants.js";
import { StaffFixtures, type TestStaff } from "../../testing/fixtures/StaffFixtures.js";
import { createTestContainer } from "../../testing/testContainer.js";
import { disposeContainer } from "../dependency-injection/container.js";
import { TYPES } from "../dependency-injection/types.js";

/**
 * Branch management and entitlements (P4-5): the price impact before adding a branch, the
 * deactivation wizard (checklist, moving everything live, then deactivating), removal of a
 * branch with no records, purchases confirmed by the tenant or by staff, and the reconcile of
 * billed branches against the tenant database (fixes, over the limit, the nightly job).
 */
const CONSOLE = "/api/platform/v1";
const PRICE = 25_000;
let container: Container;
let app: Express;
let platform: pg.Pool;
let admin: TestStaff;
let t: ProvisionedTenant;
let hq: string;
let kumasi: string;

const api = () => request(app);
const as = (token: string) => ({ Authorization: `Bearer ${token}` });
const staff = () => as(admin.accessToken);
let ownerToken: string;
const owner = () => as(ownerToken);
/** Branch membership changes bump permission versions: sign in again, as the apps refresh. */
async function signInAgain() {
  const res = await api()
    .post("/api/v1/auth/login")
    .set("X-Tenant", t.slug)
    .send({ identifier: t.ownerEmail, password: OWNER_PASSWORD });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  ownerToken = res.body.data.accessToken as string;
}
const reason = "Customer asked by phone";

const billed = async () =>
  (await api().get("/api/v1/billing/subscription").set(owner())).body.data.branchCount as number;

const createBranch = (code: string, body: Record<string, unknown> = {}) =>
  api()
    .post("/api/v1/branches")
    .set(owner())
    .send({ code, name: `Branch ${code}`, ...body });

beforeAll(async () => {
  container = await createTestContainer({ AUTH_RATE_LIMIT_MAX: "10000", RATE_LIMIT_MAX: "100000" });
  app = container.get<Express>(TYPES.HttpApp);
  platform = container.get<pg.Pool>(TYPES.PlatformDatabasePool);
  admin = await new StaffFixtures(container).create(["super_admin"]);
  const code = new TotpService().codeAt(admin.totpSecret, new Date(Date.now() + 30_000));
  await api()
    .post(`${CONSOLE}/auth/step-up`)
    .set(staff())
    .send({ password: admin.password, code })
    .expect(204);
  await api()
    .put(`${CONSOLE}/billing/plans/standard/price`)
    .set(staff())
    .send({ branchPriceMinor: PRICE, reason: "Price list" })
    .expect(200);
  t = await new ProvisionedTenants(container, app, admin).create();
  ownerToken = t.ownerAccessToken;
  const branches = await api().get("/api/v1/branches").set(owner());
  hq = (branches.body.data as { id: string; isDefault: boolean }[]).find((b) => b.isDefault)!.id;
});

afterAll(async () => {
  await disposeContainer(container);
});

describe("branches during the trial", () => {
  it("shows the price impact, and the billed count follows the active branches", async () => {
    const impact = await api().get("/api/v1/branches/price-impact").set(owner());
    expect(impact.body.data).toMatchObject({
      status: "trialing",
      activeBranches: 1,
      withinLimit: true,
      proration: null,
    });
    const created = await createBranch("KSI");
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    kumasi = created.body.data.id as string;
    expect(await billed()).toBe(2);
  });

  it("moves everything live to another branch before deactivating it", async () => {
    const vehicle = await api()
      .post("/api/v1/vehicles")
      .set(owner())
      .send({
        make: "Toyota",
        model: "Corolla",
        plateNumber: `GR ${randomUUID().slice(0, 4)}-26`,
        branchId: kumasi,
      });
    expect(vehicle.status, JSON.stringify(vehicle.body)).toBe(201);
    const driver = await api()
      .post("/api/v1/drivers")
      .set(owner())
      .send({
        firstName: "Kwame",
        lastName: "Mensah",
        phone: `024${String(Math.floor(Math.random() * 10_000_000)).padStart(7, "0")}`,
        ghanaCardNumber: `GHA-${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}-1`,
        licenceNumber: `DL-${randomUUID().slice(0, 6)}`,
        licenceClass: "B",
        licenceExpiresOn: "2030-01-01",
        branchId: kumasi,
      });
    expect(driver.status, JSON.stringify(driver.body)).toBe(201);

    const check = await api().get(`/api/v1/branches/${kumasi}/deactivation-check`).set(owner());
    expect(check.body.data.inventory).toMatchObject({
      vehicles: 1,
      drivers: 1,
      openCashSessions: 0,
    });
    expect(check.body.data.blockers).toHaveLength(2);
    const blocked = await api()
      .post(`/api/v1/branches/${kumasi}/deactivate`)
      .set(owner())
      .send({ reason });
    expect(blocked.body.error.code).toBe("BRANCH_DEACTIVATION_BLOCKED");

    const same = await api()
      .post(`/api/v1/branches/${kumasi}/reassign`)
      .set(owner())
      .send({ targetBranchId: kumasi, reason });
    expect(same.body.error.code).toBe("BRANCH_REASSIGNMENT_INVALID");
    const moved = await api()
      .post(`/api/v1/branches/${kumasi}/reassign`)
      .set(owner())
      .send({ targetBranchId: hq, reason });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(moved.body.data).toMatchObject({ vehicles: 1, drivers: 1 });
    await signInAgain();
    const vehicleNow = await api().get(`/api/v1/vehicles/${vehicle.body.data.id}`).set(owner());
    expect(vehicleNow.body.data.branchId).toBe(hq);

    expect(
      (await api().get(`/api/v1/branches/${kumasi}/deactivation-check`).set(owner())).body.data
        .blockers,
    ).toEqual([]);
    await api()
      .post(`/api/v1/branches/${kumasi}/deactivate`)
      .set(owner())
      .send({ reason })
      .expect(204);
    expect(await billed()).toBe(1);
  });

  it("removes only a branch without records", async () => {
    const mistake = await createBranch("TMP");
    expect(await billed()).toBe(2);
    await api()
      .post(`${CONSOLE}/tenants/${t.tenantId}/branches/${mistake.body.data.id}/remove`)
      .set(staff())
      .send({ reason: "Created by mistake" })
      .expect(204);
    const list = await api().get("/api/v1/branches").set(owner());
    expect(list.body.data.map((b: { code: string }) => b.code)).not.toContain("TMP");
    expect(await billed()).toBe(1);
    const head = await api().post(`/api/v1/branches/${hq}/remove`).set(owner()).send({ reason });
    expect(head.status).toBe(409);
    expect(head.body.error.code).toBe("BRANCH_REMOVAL_BLOCKED");
    expect(head.body.error.message).toMatch(/default branch/);
  });
});

describe("branches of a paying tenant", () => {
  beforeAll(async () => {
    await platform.query(
      "update subscriptions set trial_ends_at = now() - interval '1 day' where tenant_id = $1",
      [t.tenantId],
    );
    const invoice = await api()
      .post(`${CONSOLE}/tenants/${t.tenantId}/invoices`)
      .set(staff())
      .send({});
    expect(invoice.status, JSON.stringify(invoice.body)).toBe(201);
    await api()
      .post(`${CONSOLE}/billing/invoices/${invoice.body.data.id}/payments`)
      .set(staff())
      .send({
        method: "bank_transfer",
        reference: `BR-${randomUUID().slice(0, 8)}`,
        amountMinor: invoice.body.data.totalMinor,
        receivedAt: new Date().toISOString(),
      })
      .expect(200);
  });

  it("asks the tenant to confirm the price of one more branch", async () => {
    const impact = await api().get("/api/v1/branches/price-impact").set(owner());
    expect(impact.body.data).toMatchObject({
      status: "active",
      withinLimit: false,
      canBuy: true,
      branchPriceMinor: PRICE,
      branchesMonthlyBeforeMinor: PRICE,
      branchesMonthlyAfterMinor: 2 * PRICE,
      proration: { amountMinor: expect.any(Number) },
    });
    const refused = await api()
      .post(`/api/v1/branches/${kumasi}/reactivate`)
      .set(owner())
      .send({ reason });
    expect(refused.body.error.code).toBe("ENTITLEMENT_BRANCH_LIMIT");
    await api()
      .post(`/api/v1/branches/${kumasi}/reactivate`)
      .set(owner())
      .send({ reason, confirmBranchPurchase: true })
      .expect(204);
    expect(await billed()).toBe(2);
    const upcoming = await api().get("/api/v1/billing/upcoming").set(owner());
    expect(upcoming.body.data.lines.some((l: { kind: string }) => l.kind === "proration")).toBe(
      true,
    );
  });

  it("lets staff add a branch on the tenant's behalf after confirming the price", async () => {
    const path = `${CONSOLE}/tenants/${t.tenantId}/branches`;
    const impact = await api().get(`${path}/price-impact`).set(staff());
    expect(impact.body.data).toMatchObject({
      withinLimit: false,
      branchesMonthlyAfterMinor: 3 * PRICE,
    });
    const body = { code: "TKD", name: "Takoradi", reason };
    expect((await api().post(path).set(staff()).send(body)).body.error.code).toBe(
      "ENTITLEMENT_BRANCH_LIMIT",
    );
    const created = await api()
      .post(path)
      .set(staff())
      .send({ ...body, confirmBranchPurchase: true });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(await billed()).toBe(3);
    await api()
      .patch(`${path}/${created.body.data.id}`)
      .set(staff())
      .send({ name: "Takoradi Harbour", reason })
      .expect(204);
    const list = await api().get(path).set(staff());
    expect(list.body.data.find((b: { code: string }) => b.code === "TKD").name).toBe(
      "Takoradi Harbour",
    );
  });

  it("reconciles the billed count with the tenant database", async () => {
    const reconcile = () =>
      api().post(`${CONSOLE}/tenants/${t.tenantId}/branches/reconcile`).set(staff());
    await platform.query("update subscriptions set branch_count = 5 where tenant_id = $1", [
      t.tenantId,
    ]);
    expect((await reconcile()).body.data).toMatchObject({
      outcome: "fixed",
      activeBranches: 3,
      billedBefore: 5,
      billedAfter: 3,
    });

    // Billed for fewer than are active (e.g. staff reactivated around the limit): over the limit.
    await platform.query("update subscriptions set branch_count = 2 where tenant_id = $1", [
      t.tenantId,
    ]);
    await container.get<BranchReconciliation>(TYPES.BranchReconciliation).handle();
    const logged = await api()
      .get(`${CONSOLE}/billing/branch-reconciliations?tenantId=${t.tenantId}&limit=1`)
      .set(staff());
    expect(logged.body.data[0]).toMatchObject({
      outcome: "over_limit",
      source: "job",
      billedAfter: 2,
    });
    const over = await api().get(`${CONSOLE}/billing/over-limit`).set(staff());
    expect(over.body.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tenantId: t.tenantId, activeBranches: 3 }),
      ]),
    );
    expect((await createBranch("ACC", { confirmBranchPurchase: false })).body.error.code).toBe(
      "ENTITLEMENT_BRANCH_LIMIT",
    );

    await api()
      .put(`${CONSOLE}/tenants/${t.tenantId}/subscription/branches`)
      .set(staff())
      .send({ branchCount: 3, reason: "Bill the three active branches" })
      .expect(200);
    expect((await reconcile()).body.data.outcome).toBe("matched");
    const cleared = await api().get(`${CONSOLE}/billing/over-limit`).set(staff());
    expect(cleared.body.data.map((o: { tenantId: string }) => o.tenantId)).not.toContain(
      t.tenantId,
    );
  });
});
