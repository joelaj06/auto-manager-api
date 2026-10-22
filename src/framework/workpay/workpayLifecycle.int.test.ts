import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { Container } from "inversify";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ITenantDailyTask } from "../../application/jobs/ITenantDailyTask.js";
import type { IClock } from "../../application/ports/IClock.js";
import {
  OWNER_PASSWORD,
  ProvisionedTenants,
  type ProvisionedTenant,
} from "../../testing/fixtures/ProvisionedTenants.js";
import { signaturePng } from "../../testing/fixtures/signaturePng.js";
import { StaffFixtures } from "../../testing/fixtures/StaffFixtures.js";
import { createTestContainer } from "../../testing/testContainer.js";
import { disposeContainer } from "../dependency-injection/container.js";
import { TYPES } from "../dependency-injection/types.js";

/** Moved forward to let time pass (tokens are issued again after a move). */
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
const drawn = { type: "drawn", png: signaturePng() };
const momo = () => ({ method: "momo", momoNetwork: "mtn", reference: `WP-${digits(6)}` });

type Running = { id: string; vehicle: string; driver: string };

/** Moves the clock and signs the owner in again. */
async function travel(days: number) {
  clock.advanceDays(days);
  const login = await api()
    .post("/api/v1/auth/login")
    .set("X-Tenant", t.slug)
    .send({ identifier: t.ownerEmail, password: OWNER_PASSWORD });
  ownerToken = login.body.data.accessToken as string;
}

/** A signed, started agreement for a new driver and vehicle. */
async function running(fields: Record<string, unknown>): Promise<Running> {
  const driver = (
    await api()
      .post("/api/v1/drivers")
      .set(owner())
      .send({
        firstName: "Kofi",
        lastName: `Driver${digits(3)}`,
        phone: `+23324${digits(7)}`,
        ghanaCardNumber: `GHA-${digits(9)}-1`,
        licenceNumber: `DL-${randomUUID().slice(0, 6)}`,
        licenceClass: "B",
        licenceExpiresOn: "2030-01-01",
        employmentType: "workpay",
      })
  ).body.data.id as string;
  await api()
    .post(`/api/v1/drivers/${driver}/guarantors`)
    .set(owner())
    .send({ name: "Yaw", phone: `020${digits(7)}` });
  await api().post(`/api/v1/drivers/${driver}/activate`).set(owner()).send({});
  const access = await api().post(`/api/v1/drivers/${driver}/app-access`).set(owner());
  const token = /#token=([A-Za-z0-9_-]+)/.exec(access.body.data.invitation.webUrl as string)![1]!;
  const driverToken = (
    await api()
      .post("/api/v1/auth/invitations/accept")
      .set("X-Tenant", t.slug)
      .send({ token, password: OWNER_PASSWORD })
  ).body.data.accessToken as string;
  const vehicle = (
    await api()
      .post("/api/v1/vehicles")
      .set(owner())
      .send({ make: "Toyota", model: "Vitz", plateNumber: `GR ${digits(4)}-26`, odometer: 1_000 })
  ).body.data.id as string;

  const draft = await api()
    .post("/api/v1/workpay/agreements")
    .set(owner())
    .send({ vehicleId: vehicle, driverId: driver, ...fields });
  expect(draft.status, JSON.stringify(draft.body)).toBe(201);
  const id = draft.body.data.id as string;
  const sent = await api()
    .post(`/api/v1/workpay/agreements/${id}/send-for-signature`)
    .set(owner())
    .send({});
  const documentId = sent.body.data.document.id as string;
  for (const as of [owner(), { Authorization: `Bearer ${driverToken}` }]) {
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
  }
  await api()
    .post(`/api/v1/workpay/agreements/${id}/deposit`)
    .set(owner())
    .send({ amount: "2000.00", ...momo() });
  const active = await api()
    .post(`/api/v1/workpay/agreements/${id}/activate`)
    .set(owner())
    .send({ odometer: 1_100, checklist });
  expect(active.status, JSON.stringify(active.body)).toBe(200);
  return { id, vehicle, driver };
}

const terms = (periods: number) => ({
  vehicleValue: "10000.00",
  pricing: { kind: "total", total: "12000.00" },
  deposit: "2000.00",
  frequency: "weekly",
  periods,
  firstDueOn: day(7),
  roundTo: "1.00",
});

const balanceOf = async (id: string) =>
  (await api().get(`/api/v1/workpay/agreements/${id}/balance`).set(owner())).body.data as Record<
    string,
    unknown
  > & { outstanding: { amountMinor: number } };

const trialBalanced = async () =>
  (await api().get("/api/v1/ledger/trial-balance").set(owner())).body.data.balanced as boolean;

beforeAll(async () => {
  container = await createTestContainer({ AUTH_RATE_LIMIT_MAX: "10000", RATE_LIMIT_MAX: "100000" });
  container.rebind<IClock>(TYPES.Clock).toConstantValue(clock);
  app = container.get<Express>(TYPES.HttpApp);
  const staff = await new StaffFixtures(container).create(["super_admin"]);
  t = await new ProvisionedTenants(container, app, staff).create();
  ownerToken = t.ownerAccessToken;
  await api().patch("/api/v1/settings/documents").set(owner()).send({ requireOtp: false });
  const settings = await api().patch("/api/v1/settings/workpay").set(owner()).send({
    settlementDiscountPercent: "50",
    repossessionRefundPercent: "10",
    driverExpenses: "agreement",
  });
  expect(settings.status, JSON.stringify(settings.body)).toBe(200);
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
});

afterAll(async () => {
  await disposeContainer(container);
});

describe("work and pay lifecycle", () => {
  describe("holidays, restructures and early settlement", () => {
    let a: Running;
    let settlement: string;

    it("gives a payment holiday: the instalments move later, the term gets longer", async () => {
      a = await running({ terms: terms(10) });
      const res = await api()
        .post(`/api/v1/workpay/agreements/${a.id}/payment-holiday`)
        .set(owner())
        .send({ from: day(7), periods: 2, reason: "Vehicle in the workshop" });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.data).toMatchObject({
        status: "active",
        outstanding: { amountMinor: 1_000_000 },
        nextDue: { number: 11, dueOn: day(21), outstanding: { amountMinor: 100_000 } },
      });
      const history = await api()
        .get(`/api/v1/workpay/agreements/${a.id}/reschedules`)
        .set(owner());
      expect(history.body.data[0]).toMatchObject({
        kind: "holiday",
        moved: { amountMinor: 1_000_000 },
        movedNumbers: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      });
    });

    it("restructures what is left over a new monthly schedule", async () => {
      const res = await api()
        .post(`/api/v1/workpay/agreements/${a.id}/restructure`)
        .set(owner())
        .send({ frequency: "monthly", periods: 5, firstDueOn: day(30), reason: "Lower income" });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.data.nextDue).toMatchObject({
        number: 21,
        dueOn: day(30),
        outstanding: { amountMinor: 200_000 },
      });
      const agreement = await api().get(`/api/v1/workpay/agreements/${a.id}`).set(owner());
      const schedule = agreement.body.data.schedule as { number: number; status: string }[];
      expect(schedule).toHaveLength(25);
      expect(schedule[0]!.status).toBe("rescheduled");
      expect(agreement.body.data.rescheduledBasis).toEqual({ frequency: "monthly", daysOff: [] });
    });

    it("quotes and takes an early settlement with half the markup off", async () => {
      await api()
        .post(`/api/v1/workpay/agreements/${a.id}/payments`)
        .set(owner())
        .send({ amount: "2000.00", ...momo() });
      const figures = await api()
        .get(`/api/v1/workpay/agreements/${a.id}/closing-figures`)
        .set(owner());
      // 8,000.00 left; markup share 8,000 × 2,000 / 12,000 = 1,333.33; half off.
      expect(figures.body.data).toMatchObject({
        instalmentsOutstanding: { amountMinor: 800_000 },
        instalmentsPaid: { amountMinor: 200_000 },
        settlement: { discount: { amountMinor: 66_667 }, payoff: { amountMinor: 733_333 } },
        suggestedRepossessionRefund: { amountMinor: 20_000 },
      });
      const special = await api()
        .post(`/api/v1/workpay/agreements/${a.id}/settlement-quotes`)
        .set(owner())
        .send({ discountPercent: "100" });
      expect(special.status, JSON.stringify(special.body)).toBe(201); // the owner may
      const quote = await api()
        .post(`/api/v1/workpay/agreements/${a.id}/settlement-quotes`)
        .set(owner())
        .send({});
      expect(quote.body.data).toMatchObject({
        status: "open",
        validUntil: day(7),
        payoff: { amountMinor: 733_333 },
      });
      const wrong = await api()
        .post(`/api/v1/workpay/agreements/${a.id}/settle`)
        .set(owner())
        .send({ quoteId: quote.body.data.id, amount: "8000.00", ...momo() });
      expect(wrong.body.error.message).toMatch(/Settling today takes/);
      const res = await api()
        .post(`/api/v1/workpay/agreements/${a.id}/settle`)
        .set(owner())
        .send({ quoteId: quote.body.data.id, amount: "7333.33", ...momo() });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.data.balance).toMatchObject({
        status: "completed",
        outstanding: { amountMinor: 0 },
      });
      settlement = res.body.data.payment.id as string;
      const receipt = await api().get(`/api/v1/payments/${settlement}/receipt`).set(owner());
      expect(receipt.body.data.appliedTo[0].description).toMatch(
        /settled early: instalments 22–25/,
      );
      expect(await trialBalanced()).toBe(true);
    });

    it("reopens the agreement, discount and all, when the settlement payment is reversed", async () => {
      const res = await api()
        .post(`/api/v1/payments/${settlement}/reverse`)
        .set(owner())
        .send({ reason: "Bounced" });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(await balanceOf(a.id)).toMatchObject({
        status: "active",
        outstanding: { amountMinor: 800_000 },
      });
      expect(await trialBalanced()).toBe(true);
    });
  });

  describe("downtime, driver costs and termination", () => {
    let b: Running;

    it("takes the vehicle off the road and suggests a holiday when the owner is responsible", async () => {
      b = await running({ terms: terms(20), maintenance: "owner", insurance: "driver" });
      const down = await api()
        .post(`/api/v1/workpay/agreements/${b.id}/downtime`)
        .set(owner())
        .send({ reason: "Gearbox repair" });
      expect(down.status, JSON.stringify(down.body)).toBe(201);
      expect(down.body.data).toMatchObject({ ownerFault: true, endedOn: null });
      const car = await api().get(`/api/v1/vehicles/${b.vehicle}`).set(owner());
      expect(car.body.data.status).toBe("in_maintenance");
      const byHand = await api()
        .post(`/api/v1/vehicles/${b.vehicle}/status`)
        .set(owner())
        .send({ status: "available", reason: "Fixed" });
      expect(byHand.body.error.message).toMatch(/through the agreement/);

      await travel(15);
      const up = await api()
        .post(`/api/v1/workpay/agreements/${b.id}/downtime/end`)
        .set(owner())
        .send({});
      expect(up.body.data).toMatchObject({
        endedOn: day(0),
        suggestedHoliday: { from: day(-15), periods: 2 },
      });
      const back = await api().get(`/api/v1/vehicles/${b.vehicle}`).set(owner());
      expect(back.body.data.status).toBe("on_workpay");
    });

    it("charges the driver's insurance to the agreement, paid before instalments", async () => {
      const created = await api()
        .post("/api/v1/expenses")
        .set(owner())
        .send({
          categoryId: categories.insurance,
          description: "Third party insurance",
          payeeName: "Star Assurance",
          amount: "300.00",
          vehicleIds: [b.vehicle],
        });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      expect(created.body.data.expense).toMatchObject({ chargeToDriver: true, driverId: b.driver });
      const submitted = await api()
        .post(`/api/v1/expenses/${created.body.data.expense.id}/submit`)
        .set(owner());
      expect(submitted.body.data.status).toBe("approved");
      const balance = await balanceOf(b.id);
      expect(balance).toMatchObject({ chargesOutstanding: { amountMinor: 30_000 } });
      const paid = await api()
        .post(`/api/v1/workpay/agreements/${b.id}/payments`)
        .set(owner())
        .send({ amount: "500.00", ...momo() });
      expect(paid.body.data.allocations[0]).toMatchObject({
        kind: "charge",
        instalmentNumber: null,
        amount: { amountMinor: 30_000 },
      });
    });

    it("terminates by agreement with the vehicle handed back and what the driver still owes", async () => {
      const notReturned = await api()
        .post(`/api/v1/workpay/agreements/${b.id}/terminate`)
        .set(owner())
        .send({ reason: "mutual" });
      expect(notReturned.body.error.message).toMatch(/Hand the vehicle back/);
      const res = await api()
        .post(`/api/v1/workpay/agreements/${b.id}/terminate`)
        .set(owner())
        .send({
          reason: "mutual",
          notes: "Driver relocating",
          owedByDriver: "100.00",
          handback: { odometer: 5_000, checklist },
        });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.data.status).toBe("terminated");
      const agreement = await api().get(`/api/v1/workpay/agreements/${b.id}`).set(owner());
      expect(agreement.body.data.closure).toMatchObject({
        reason: "mutual",
        on: day(0),
        owedMinor: 10_000,
      });
      const car = await api().get(`/api/v1/vehicles/${b.vehicle}`).set(owner());
      expect(car.body.data.status).toBe("available");
      expect(
        (
          await api()
            .post(`/api/v1/workpay/agreements/${b.id}/payments`)
            .set(owner())
            .send({
              amount: "10.00",
              ...momo(),
            })
        ).body.error.message,
      ).toMatch(/once the agreement has started/);
      expect(await trialBalanced()).toBe(true);
    });
  });

  describe("default and repossession", () => {
    let c: Running;

    it("repossesses only once the agreement is in arrears", async () => {
      c = await running({ terms: terms(4), graceDays: 0 });
      const early = await api()
        .post(`/api/v1/workpay/agreements/${c.id}/repossess`)
        .set(owner())
        .send({ odometer: 2_000, checklist });
      expect(early.body.error.message).toMatch(/in arrears or defaulted/);

      await travel(8);
      await t.tenant.run(() =>
        container
          .get<ITenantDailyTask[]>(TYPES.TenantDailyTasks)
          .find((task) => task.name === "workpay_arrears")!
          .run(day(0)),
      );
      expect((await balanceOf(c.id)).status).toBe("in_arrears");

      const res = await api()
        .post(`/api/v1/workpay/agreements/${c.id}/repossess`)
        .set(owner())
        .send({
          odometer: 2_000,
          checklist,
          condition: "Dented rear door",
          refundToDriver: "50.00",
        });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.data.status).toBe("repossessed");
      const car = await api().get(`/api/v1/vehicles/${c.vehicle}`).set(owner());
      expect(car.body.data.status).toBe("repossessed");
      const restock = await api()
        .post(`/api/v1/vehicles/${c.vehicle}/status`)
        .set(owner())
        .send({ status: "reconditioning", reason: "Back in stock" });
      expect(restock.status, JSON.stringify(restock.body)).toBe(200);
      expect(await trialBalanced()).toBe(true);
    });
  });
});
