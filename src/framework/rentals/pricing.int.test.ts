import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { Container } from "inversify";
import type pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
 * Rental pricing (P5-1): classes and their vehicles, rate plans with seasons, extras, zones,
 * promo codes and holidays, and quotes priced over HTTP as the pricing fixtures say.
 */
let container: Container;
let app: Express;
let platform: pg.Pool;
let t: ProvisionedTenant;
let hq: string;
let agent: string;
let suv: string;
let vehicle: string;
let seat: string;
let gps: string;
let airport: string;

const api = () => request(app);
const as = (token: string) => ({ Authorization: `Bearer ${token}` });
const owner = () => as(t.ownerAccessToken);
// 2 November 2026 is a Monday; Accra is UTC.
const MON = "2026-11-02T09:00:00Z";

async function lastEmail(to: string, template: string): Promise<string> {
  const { rows } = await platform.query<{ body_text: string }>(
    `select body_text from email_deliveries where recipient = $1 and template = $2
      order by created_at desc limit 1`,
    [to, template],
  );
  return rows[0]!.body_text;
}

/** A Rental Agent in the head office, signed in. */
async function rentalAgent(): Promise<string> {
  const roles = await api().get("/api/v1/roles").set(owner());
  const roleId = (roles.body.data as { id: string; systemKey: string | null }[]).find(
    (r) => r.systemKey === "rental_agent",
  )!.id;
  const email = `agent-${randomUUID().slice(0, 8)}@example.com`;
  const invited = await api()
    .post("/api/v1/users/invitations")
    .set(owner())
    .send({ name: "Rental Agent", email, branchIds: [hq], roles: [{ roleId, branchId: hq }] });
  expect(invited.status, JSON.stringify(invited.body)).toBe(201);
  const token = /#token=([A-Za-z0-9_-]+)/.exec(
    await lastEmail(email, "tenant.user_invitation"),
  )![1]!;
  const accepted = await api()
    .post("/api/v1/auth/invitations/accept")
    .set("X-Tenant", t.slug)
    .send({ token, password: OWNER_PASSWORD });
  return accepted.body.data.accessToken as string;
}

const quote = (body: Record<string, unknown>, token = t.ownerAccessToken) =>
  api()
    .post("/api/v1/rentals/quotes")
    .set(as(token))
    .send({ pickupAt: MON, returnAt: "2026-11-05T09:00:00Z", classId: suv, ...body });

beforeAll(async () => {
  container = await createTestContainer({ AUTH_RATE_LIMIT_MAX: "10000" });
  app = container.get<Express>(TYPES.HttpApp);
  platform = container.get<pg.Pool>(TYPES.PlatformDatabasePool);
  const staff = await new StaffFixtures(container).create(["super_admin"]);
  t = await new ProvisionedTenants(container, app, staff).create();
  const branches = await api().get("/api/v1/branches").set(owner());
  hq = (branches.body.data as { id: string; isDefault: boolean }[]).find((b) => b.isDefault)!.id;
  agent = await rentalAgent();
});

afterAll(async () => {
  await disposeContainer(container);
});

describe("the rate catalogue", () => {
  it("keeps classes and the vehicles in them", async () => {
    const created = await api()
      .post("/api/v1/vehicle-classes")
      .set(owner())
      .send({ code: "suv", name: "SUV", minDriverAge: 25 });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.data.code).toBe("SUV");
    suv = created.body.data.id as string;
    const again = await api()
      .post("/api/v1/vehicle-classes")
      .set(owner())
      .send({ code: "SUV", name: "Other" });
    expect([again.status, again.body.error.code]).toEqual([422, "RENTAL_RATE_RULE"]);
    expect(
      (
        await api()
          .post("/api/v1/vehicle-classes")
          .set(as(agent))
          .send({ code: "ECO", name: "Economy" })
      ).status,
    ).toBe(403);

    const registered = await api()
      .post("/api/v1/vehicles")
      .set(owner())
      .send({ make: "Toyota", model: "RAV4", plateNumber: `GR ${randomUUID().slice(0, 4)}-26` });
    expect(registered.status, JSON.stringify(registered.body)).toBe(201);
    vehicle = registered.body.data.id as string;
    await api()
      .put(`/api/v1/vehicles/${vehicle}/rental-class`)
      .set(owner())
      .send({ classId: suv })
      .expect(200);
    const classes = await api().get("/api/v1/vehicle-classes").set(as(agent));
    expect(classes.body.data).toEqual([
      expect.objectContaining({ id: suv, vehicles: 1, minDriverAge: 25 }),
    ]);
  });

  it("keeps rate plans with seasons, extras, zones, promo codes and holidays", async () => {
    const plan = await api()
      .post("/api/v1/rental-rate-plans")
      .set(owner())
      .send({
        code: "SUV-STD",
        name: "SUV standard",
        classId: suv,
        hourlyRate: "40.00",
        dailyRate: "300.00",
        weekendRate: "350.00",
        weeklyRate: "1800.00",
        monthlyRate: "6000.00",
        minHours: 3,
        includedKmPerDay: 200,
        extraKmRate: "1.50",
        chauffeurDaily: "150.00",
        seasons: [
          {
            name: "Christmas",
            startsOn: "2026-12-20",
            endsOn: "2026-12-31",
            adjustmentPercent: "25",
          },
        ],
      });
    expect(plan.status, JSON.stringify(plan.body)).toBe(201);
    expect(plan.body.data).toMatchObject({
      dailyMinor: 30_000,
      currency: "GHS",
      seasons: [{ name: "Christmas", adjustmentPercent: "25" }],
    });
    const fetched = await api()
      .get(`/api/v1/rental-rate-plans/${plan.body.data.id}`)
      .set(as(agent));
    expect(fetched.body.data.seasons[0]).toMatchObject({
      startsOn: "2026-12-20",
      endsOn: "2026-12-31",
    });
    const both = await api()
      .post("/api/v1/rental-rate-plans")
      .set(owner())
      .send({ code: "BAD", name: "Bad", classId: suv, vehicleId: vehicle, dailyRate: "1.00" });
    expect(both.body.error.code).toBe("RENTAL_RATE_RULE");

    const extra = (body: Record<string, unknown>) =>
      api().post("/api/v1/rental-extras").set(owner()).send(body);
    const seatRes = await extra({
      code: "SEAT",
      name: "Child seat",
      category: "equipment",
      charge: "per_day",
      price: "20.00",
      maxCharge: "80.00",
      maxQuantity: 2,
    });
    expect(seatRes.status, JSON.stringify(seatRes.body)).toBe(201);
    seat = seatRes.body.data.id as string;
    gps = (
      await extra({
        code: "GPS",
        name: "GPS",
        category: "equipment",
        charge: "per_rental",
        price: "50.00",
        classIds: [suv],
      })
    ).body.data.id as string;
    expect(
      (
        await extra({
          code: "CAP",
          name: "Capped",
          category: "other",
          charge: "per_rental",
          price: "1.00",
          maxCharge: "5.00",
        })
      ).body.error.code,
    ).toBe("RENTAL_RATE_RULE");

    const zone = await api()
      .post("/api/v1/rental-zones")
      .set(owner())
      .send({ name: "Airport", deliveryFee: "50.00", collectionFee: "40.00" });
    expect(zone.status, JSON.stringify(zone.body)).toBe(201);
    airport = zone.body.data.id as string;

    const promo = await api()
      .post("/api/v1/rental-promo-codes")
      .set(owner())
      .send({ code: "easter10", discountPercent: "10", maxUses: 100 });
    expect(promo.status, JSON.stringify(promo.body)).toBe(201);
    expect(promo.body.data).toMatchObject({
      code: "EASTER10",
      discountPercent: "10",
      usedCount: 0,
    });
    const switched = await api()
      .patch(`/api/v1/rental-promo-codes/${promo.body.data.id}`)
      .set(owner())
      .send({ discount: "25.00" });
    expect(switched.body.data).toMatchObject({ discountPercent: null, discountMinor: 2_500 });
    await api()
      .patch(`/api/v1/rental-promo-codes/${promo.body.data.id}`)
      .set(owner())
      .send({ discountPercent: "10" })
      .expect(200);
    expect((await api().get("/api/v1/rental-promo-codes").set(as(agent))).status).toBe(403);

    const holiday = await api()
      .post("/api/v1/public-holidays")
      .set(owner())
      .send({ date: "2026-11-03", name: "Test holiday" });
    expect(holiday.status, JSON.stringify(holiday.body)).toBe(201);
    const twice = await api()
      .post("/api/v1/public-holidays")
      .set(owner())
      .send({ date: "2026-11-03", name: "Again" });
    expect(twice.body.error.code).toBe("RENTAL_RATE_RULE");
    expect((await api().get("/api/v1/public-holidays?year=2026").set(as(agent))).body.data).toEqual(
      [expect.objectContaining({ date: "2026-11-03", name: "Test holiday" })],
    );

    const settings = await api()
      .patch("/api/v1/settings/rentals")
      .set(owner())
      .send({ graceMinutes: 30 });
    expect(settings.body.data).toMatchObject({
      graceMinutes: 30,
      weekendDays: [6, 7],
      maxDiscountPercent: "10",
    });
    const audited = await t.tenant.query<{ action: string }>(
      "select action from audit_logs where entity_type in ('rental_rate_plan', 'rental_promo_code')",
    );
    expect(audited.map((r) => r.action)).toEqual(
      expect.arrayContaining(["rental_rate_plan.created", "rental_promo_code.updated"]),
    );
  });
});

describe("quotes", () => {
  it("price a class over the holiday with extras, delivery and a promo code", async () => {
    const res = await quote({
      extras: [
        { extraId: seat, quantity: 1 },
        { extraId: gps, quantity: 1 },
      ],
      deliveryZoneId: airport,
      promoCode: "easter10",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const q = res.body.data;
    // Mon ₵300 + Tue holiday ₵350 + Wed ₵300 = ₵950, less 10 %; seat 3 days ₵60, GPS ₵50, delivery ₵50.
    expect(q.lines.map((l: { description: string }) => l.description)).toEqual([
      "Rental: 2 weekdays at ₵300.00",
      "Rental: 1 holiday at ₵350.00",
      "Child seat: 3 days at ₵20.00",
      "GPS",
      "Delivery to Airport",
    ]);
    expect(q.discounts.promo).toMatchObject({ code: "EASTER10", amount: { amountMinor: 9_500 } });
    expect(q.totals.total.amountMinor).toBe(95_000 - 9_500 + 6_000 + 5_000 + 5_000);
    expect(q).toMatchObject({
      tier: "daily",
      days: 3,
      branchId: hq,
      classId: suv,
      plan: { code: "SUV-STD" },
    });
    expect(q.mileage).toMatchObject({ unlimited: false, includedKm: 600 });
  });

  it("use a vehicle's own plan over its class's, and cap a short week at the weekly rate", async () => {
    await api()
      .post("/api/v1/rental-rate-plans")
      .set(owner())
      .send({ code: "RAV4", name: "This RAV4", vehicleId: vehicle, dailyRate: "250.00" })
      .expect(201);
    const own = await quote({
      classId: undefined,
      vehicleId: vehicle,
      pickupAt: "2026-11-09T09:00:00Z",
      returnAt: "2026-11-12T09:00:00Z",
    });
    expect(own.status, JSON.stringify(own.body)).toBe(200);
    expect(own.body.data).toMatchObject({
      plan: { code: "RAV4" },
      vehicleId: vehicle,
      classId: suv,
      totals: { total: { amountMinor: 75_000 } },
    });

    const week = await quote({
      pickupAt: "2026-11-09T09:00:00Z",
      returnAt: "2026-11-15T09:00:00Z",
    });
    expect(week.body.data).toMatchObject({
      cappedBy: "weekly",
      totals: { total: { amountMinor: 180_000 } },
    });
  });

  it("charge VAT per line when the business is registered", async () => {
    const tax = await api().put("/api/v1/settings/tax").set(owner()).send({
      scheme: "standard",
      vatNumber: "C0001234567",
      defaultSalesTaxCode: "VAT_STANDARD",
      pricesIncludeTax: false,
    });
    expect(tax.status, JSON.stringify(tax.body)).toBe(200);
    const res = await quote({ pickupAt: "2026-11-09T09:00:00Z", returnAt: "2026-11-12T09:00:00Z" });
    expect(res.body.data.totals).toMatchObject({
      net: { amountMinor: 90_000 },
      tax: { amountMinor: 18_000 },
      total: { amountMinor: 108_000 },
    });
    expect(res.body.data.lines[0].taxCode).toBe("VAT_STANDARD");
    await api()
      .put("/api/v1/settings/tax")
      .set(owner())
      .send({
        scheme: "not_registered",
        vatNumber: null,
        defaultSalesTaxCode: null,
        pricesIncludeTax: false,
      })
      .expect(200);
  });

  it("hold the agent to the discount limit and to the rates", async () => {
    const within = await quote({ discountPercent: "10" }, agent);
    expect(within.status, JSON.stringify(within.body)).toBe(200);
    expect(within.body.data.discounts.manual).toMatchObject({
      percent: "10",
      amount: { amountMinor: 9_500 },
    });
    const beyond = await quote({ discountPercent: "15" }, agent);
    expect([beyond.status, beyond.body.error.code]).toEqual([422, "RENTAL_PRICING"]);
    const agreed = await quote(
      { override: { amount: "800.00", reason: "Returning customer" } },
      agent,
    );
    expect(agreed.status).toBe(403);
    const byOwner = await quote({ override: { amount: "800.00", reason: "Returning customer" } });
    expect(byOwner.body.data).toMatchObject({
      totals: { total: { amountMinor: 80_000 } },
      discounts: { override: { computed: { amountMinor: 95_000 } } },
    });
  });

  it("refuse what cannot be priced", async () => {
    const backwards = await quote({ returnAt: MON });
    expect(backwards.body.error.code).toBe("RENTAL_PRICING");
    const unknownPromo = await quote({ promoCode: "NOPE99" });
    expect(unknownPromo.body.error.code).toBe("RENTAL_PRICING");
    const eco = await api()
      .post("/api/v1/vehicle-classes")
      .set(owner())
      .send({ code: "ECO", name: "Economy" });
    const noPlan = await quote({ classId: eco.body.data.id, extras: [] });
    expect(noPlan.body.error.message).toMatch(/No rate plan/);
    const gpsOnEco = await quote({
      classId: eco.body.data.id,
      extras: [{ extraId: gps, quantity: 1 }],
    });
    expect(gpsOnEco.body.error.code).toBe("RENTAL_PRICING");
  });
});
