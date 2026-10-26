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
 * The booking lifecycle (P5-3) end to end: reserve → confirm → check out → check in (late, with
 * extra km) → close; holds taken over, class bookings moved, changes and extensions re-quoted,
 * cancellations and no-shows with the policy fees, lapsed reservations, renter rules.
 */
let container: Container;
let app: Express;
let platform: pg.Pool;
let t: ProvisionedTenant;
let hq: string;
let agent: string;
let suv: string;
let cars: string[];
let adult: string;
let young: string;
let unlicensed: string;

type Booking = {
  id: string;
  number: string;
  status: string;
  blockId: string;
  vehicle: { id: string };
  charges: { kind: string; total: { amountMinor: number } }[];
  charged: { amountMinor: number };
  events: { type: string }[];
  warnings: string[];
};

const api = () => request(app);
const as = (token: string) => ({ Authorization: `Bearer ${token}` });
const owner = () => as(t.ownerAccessToken);
const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const future = (d: number, hour = 9) =>
  `2027-05-${String(d).padStart(2, "0")}T${String(hour).padStart(2, "0")}:00:00.000Z`;

async function lastEmail(to: string, template: string): Promise<string> {
  const { rows } = await platform.query<{ body_text: string }>(
    `select body_text from email_deliveries where recipient = $1 and template = $2
      order by created_at desc limit 1`,
    [to, template],
  );
  return rows[0]!.body_text;
}

async function rentalAgent(): Promise<string> {
  const roles = await api().get("/api/v1/roles").set(owner());
  const roleId = (roles.body.data as { id: string; systemKey: string | null }[]).find(
    (r) => r.systemKey === "rental_agent",
  )!.id;
  const email = `agent-${randomUUID().slice(0, 8)}@example.com`;
  await api()
    .post("/api/v1/users/invitations")
    .set(owner())
    .send({ name: "Rental Agent", email, branchIds: [hq], roles: [{ roleId, branchId: hq }] })
    .expect(201);
  const token = /#token=([A-Za-z0-9_-]+)/.exec(
    await lastEmail(email, "tenant.user_invitation"),
  )![1]!;
  const accepted = await api()
    .post("/api/v1/auth/invitations/accept")
    .set("X-Tenant", t.slug)
    .send({ token, password: OWNER_PASSWORD });
  return accepted.body.data.accessToken as string;
}

async function customer(fields: Record<string, unknown>): Promise<string> {
  const created = await api()
    .post("/api/v1/customers")
    .set(owner())
    .send({
      type: "individual",
      firstName: "Ama",
      lastName: randomUUID().slice(0, 6),
      email: `renter-${randomUUID().slice(0, 8)}@example.com`,
      ...fields,
    });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return created.body.data.id as string;
}

const book = (body: Record<string, unknown>, token = agent) =>
  api()
    .post("/api/v1/rentals")
    .set(as(token))
    .send({ classId: suv, customerId: adult, ...body });

const step = (id: string, path: string, body: Record<string, unknown> = {}, token = agent) =>
  api().post(`/api/v1/rentals/${id}/${path}`).set(as(token)).send(body);

const data = (res: request.Response) => res.body.data as Booking;
const kinds = (b: Booking) => b.charges.map((c) => [c.kind, c.total.amountMinor]);

beforeAll(async () => {
  container = await createTestContainer({ AUTH_RATE_LIMIT_MAX: "10000" });
  app = container.get<Express>(TYPES.HttpApp);
  platform = container.get<pg.Pool>(TYPES.PlatformDatabasePool);
  const staff = await new StaffFixtures(container).create(["super_admin"]);
  t = await new ProvisionedTenants(container, app, staff).create();
  const branches = await api().get("/api/v1/branches").set(owner());
  hq = (branches.body.data as { id: string; isDefault: boolean }[]).find((b) => b.isDefault)!.id;
  agent = await rentalAgent();

  const created = await api()
    .post("/api/v1/vehicle-classes")
    .set(owner())
    .send({ code: "SUV", name: "SUV", turnaroundMinutes: 60, minDriverAge: 25 });
  suv = created.body.data.id as string;
  cars = [];
  for (let i = 0; i < 3; i++) {
    const registered = await api()
      .post("/api/v1/vehicles")
      .set(owner())
      .send({ make: "Toyota", model: "RAV4", plateNumber: `GR ${randomUUID().slice(0, 4)}-27` });
    const id = registered.body.data.id as string;
    await api()
      .put(`/api/v1/vehicles/${id}/rental-class`)
      .set(owner())
      .send({ classId: suv })
      .expect(200);
    cars.push(id);
  }
  await api()
    .post("/api/v1/rental-rate-plans")
    .set(owner())
    .send({
      code: "SUV-STD",
      name: "SUV standard",
      classId: suv,
      hourlyRate: "40.00",
      dailyRate: "300.00",
      includedKmPerDay: 100,
      extraKmRate: "2.00",
    })
    .expect(201);
  const licence = { licenceNumber: "DL-12345", licenceClass: "B", licenceExpiresOn: "2030-01-01" };
  adult = await customer({ dateOfBirth: "1990-04-01", ...licence });
  young = await customer({ dateOfBirth: "2006-01-01", ...licence });
  unlicensed = await customer({ dateOfBirth: "1985-01-01" });
});

afterAll(async () => {
  await disposeContainer(container);
});

describe("the booking life cycle", () => {
  it("runs from reservation to close, charging the late return and the extra km", async () => {
    const now = Date.now();
    const pickupAt = now - 47 * HOUR;
    const reserved = await book({ pickupAt: iso(pickupAt), returnAt: iso(now + HOUR) });
    expect(reserved.status, JSON.stringify(reserved.body)).toBe(201);
    const booking = data(reserved);
    expect(booking).toMatchObject({ status: "reserved", warnings: [] });
    expect(booking.number).toMatch(/^RNT-\d{4}-\d{6}$/);
    expect(kinds(booking)).toEqual([["rental", 60_000]]);
    const block = await api().get(`/api/v1/vehicle-blocks/${booking.blockId}`).set(as(agent));
    expect(block.body.data).toMatchObject({
      status: "hold",
      refType: "rental_booking",
      refId: booking.id,
    });

    const early = await step(booking.id, "checkout", { odometer: 5_000, fuel: "full" });
    expect([early.status, early.body.error.message]).toEqual([
      422,
      "Confirm the reservation before the keys are handed over",
    ]);
    expect(data(await step(booking.id, "confirm")).status).toBe("confirmed");

    const out = await step(booking.id, "checkout", { odometer: 5_000, fuel: "full" });
    expect(out.status, JSON.stringify(out.body)).toBe(200);
    expect(data(out).status).toBe("checked_out");
    const vehicle = data(out).vehicle.id;
    expect((await api().get(`/api/v1/vehicles/${vehicle}`).set(owner())).body.data.status).toBe(
      "on_rent",
    );
    expect(
      (await api().get(`/api/v1/vehicle-blocks/${booking.blockId}`).set(as(agent))).body.data
        .status,
    ).toBe("out");

    // Two hours on: the booked return (two days after pickup) was an hour ago.
    await t.tenant.query(
      `update rental_bookings set pickup_at = pickup_at - interval '2 hours',
          return_at = return_at - interval '2 hours', checked_out_at = checked_out_at - interval '2 hours'
        where id = $1`,
      [booking.id],
    );
    await t.tenant.query(
      `update vehicle_blocks set starts_at = starts_at - interval '2 hours',
          ends_at = ends_at - interval '2 hours', blocked_until = blocked_until - interval '2 hours'
        where id = $1`,
      [booking.blockId],
    );
    await t.tenant.query(
      `update odometer_readings set read_at = read_at - interval '2 hours'
        where source = 'rental' and ref_id = $1`,
      [booking.id],
    );
    await t.tenant.query(
      "update vehicles set odometer_read_at = odometer_read_at - interval '2 hours' where id = $1",
      [booking.vehicle.id],
    );
    const back = await step(booking.id, "checkin", {
      odometer: 5_300,
      fuel: "half",
      returnedAt: iso(pickupAt - 2 * HOUR + 49 * HOUR),
    });
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    // 49 hours kept for 48 booked: an hour at ₵40; 300 km for 200 included: 100 km at ₵2.
    expect(kinds(data(back))).toEqual([
      ["rental", 60_000],
      ["late_return", 4_000],
      ["mileage", 20_000],
    ]);
    expect(data(back)).toMatchObject({
      status: "returned",
      charged: expect.objectContaining({ amountMinor: 84_000 }),
      return: expect.objectContaining({ odometer: 5_300, km: 300, fuel: "half" }),
    });
    expect((await api().get(`/api/v1/vehicles/${vehicle}`).set(owner())).body.data).toMatchObject({
      status: "available",
      odometer: expect.objectContaining({ value: 5_300 }),
    });

    const closed = await step(booking.id, "close");
    expect(data(closed).status).toBe("closed");
    expect(data(closed).events.map((e) => e.type)).toEqual([
      "reserved",
      "confirmed",
      "checked_out",
      "returned",
      "closed",
    ]);
    const audit = await t.tenant.query<{ action: string }>(
      "select action from audit_logs where entity_type = 'rental_booking' and entity_id = $1 order by occurred_at",
      [booking.id],
    );
    expect(audit.map((r) => r.action)).toEqual([
      "rental_booking.created",
      "rental_booking.confirmed",
      "rental_booking.checked_out",
      "rental_booking.returned",
      "rental_booking.closed",
    ]);
    const listed = await api().get("/api/v1/rentals").query({ status: "closed" }).set(as(agent));
    expect((listed.body.data as Booking[]).map((b) => b.id)).toContain(booking.id);
  });

  it("takes over a hold, moves the class booking, and re-quotes changes and extensions", async () => {
    const hold = await api()
      .post("/api/v1/rentals/holds")
      .set(as(agent))
      .send({ classId: suv, pickupAt: future(3), returnAt: future(5), customerId: adult });
    expect(hold.status).toBe(201);
    const reserved = await book({
      pickupAt: future(3),
      returnAt: future(5),
      holdId: hold.body.data.id,
    });
    expect(reserved.status, JSON.stringify(reserved.body)).toBe(201);
    const booking = data(reserved);
    expect(booking.vehicle.id).toBe(hold.body.data.vehicleId);
    expect(
      (await api().get(`/api/v1/vehicle-blocks/${hold.body.data.id}`).set(as(agent))).body.data,
    ).toMatchObject({ status: "released", releasedReason: "Taken over by a booking" });
    expect(
      (await book({ pickupAt: future(3), returnAt: future(5), holdId: hold.body.data.id })).status,
    ).toBe(422);

    const moved = await step(booking.id, "vehicle", {});
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(data(moved).vehicle.id).not.toBe(booking.vehicle.id);
    const release = await api()
      .post(`/api/v1/vehicle-blocks/${booking.blockId}/release`)
      .set(owner())
      .send({ reason: "By hand" });
    expect([release.status, release.body.error.code]).toEqual([422, "VEHICLE_BLOCK_RULE"]);

    // One more day: re-quoted, the difference charged; the vehicle is kept.
    const changed = await api()
      .patch(`/api/v1/rentals/${booking.id}`)
      .set(as(agent))
      .send({ returnAt: future(6) });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect(kinds(data(changed))).toEqual([
      ["rental", 60_000],
      ["change", 30_000],
    ]);
    expect(data(changed).vehicle.id).toBe(data(moved).vehicle.id);

    expect((await step(booking.id, "extend", { returnAt: future(7) })).status).toBe(422);
    await step(booking.id, "confirm").expect(200);
    const extended = await step(booking.id, "extend", { returnAt: future(7) });
    expect(kinds(data(extended)).at(-1)).toEqual(["extension", 30_000]);

    // The next booking of that vehicle is in the way of a further extension.
    const next = await book({
      classId: null,
      vehicleId: data(moved).vehicle.id,
      pickupAt: future(8),
      returnAt: future(9),
    });
    expect(next.status, JSON.stringify(next.body)).toBe(201);
    const blocked = await step(booking.id, "extend", { returnAt: future(8, 12) });
    expect([blocked.status, blocked.body.error.code]).toEqual([409, "VEHICLE_UNAVAILABLE"]);
    for (const id of [booking.id, data(next).id])
      await step(id, "cancel", { reason: "Test over" }).expect(200);
  });
});

describe("bookings that do not happen", () => {
  it("cancel free early, with the late fee later, and charge no-shows", async () => {
    const now = Date.now();
    const free = data(
      await book({ pickupAt: iso(now + 72 * HOUR), returnAt: iso(now + 96 * HOUR) }),
    );
    const cancelled = await step(free.id, "cancel", { reason: "Plans changed" });
    expect(data(cancelled)).toMatchObject({
      status: "cancelled",
      charged: expect.objectContaining({ amountMinor: 0 }),
    });
    expect(kinds(data(cancelled))).toEqual([
      ["rental", 30_000],
      ["cancellation", -30_000],
    ]);
    expect(
      (await api().get(`/api/v1/vehicle-blocks/${free.blockId}`).set(as(agent))).body.data.status,
    ).toBe("released");

    const late = data(
      await book({ pickupAt: iso(now + 5 * HOUR), returnAt: iso(now + 29 * HOUR) }),
    );
    const lateCancel = data(await step(late.id, "cancel", { reason: "Plans changed" }));
    expect(kinds(lateCancel).at(-1)).toEqual(["cancellation_fee", 7_500]);
    expect(lateCancel.charged.amountMinor).toBe(7_500);

    const missed = data(
      await book({ pickupAt: iso(now - HOUR), returnAt: iso(now + 23 * HOUR), confirm: true }),
    );
    expect(missed.status).toBe("confirmed");
    const waived = await step(missed.id, "no-show", { reason: "Did not come", waiveFee: true });
    expect(waived.status).toBe(403);
    const noShow = data(await step(missed.id, "no-show", { reason: "Did not come" }));
    expect(noShow.status).toBe("no_show");
    expect(kinds(noShow).at(-1)).toEqual(["no_show_fee", 15_000]);
  });

  it("show lapsed reservations as expired, and confirm them while the vehicle is free", async () => {
    const reserved = data(await book({ pickupAt: future(20), returnAt: future(21) }));
    await t.tenant.query(
      "update rental_bookings set expires_at = now() - interval '1 minute' where id = $1",
      [reserved.id],
    );
    await t.tenant.query(
      "update vehicle_blocks set expires_at = now() - interval '1 minute' where id = $1",
      [reserved.blockId],
    );
    expect(data(await api().get(`/api/v1/rentals/${reserved.id}`).set(as(agent))).status).toBe(
      "expired",
    );
    const expired = await api().get("/api/v1/rentals").query({ status: "expired" }).set(as(agent));
    expect((expired.body.data as Booking[]).map((b) => b.id)).toEqual([reserved.id]);
    const confirmed = await step(reserved.id, "confirm");
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    expect(data(confirmed).status).toBe("confirmed");
    expect(data(confirmed).blockId).not.toBe(reserved.blockId);
    await step(reserved.id, "cancel", { reason: "Test over" }).expect(200);
  });
});

describe("renter rules", () => {
  it("refuse drivers under the class age and licences ending before the return", async () => {
    const tooYoung = await book({ customerId: young, pickupAt: future(24), returnAt: future(25) });
    expect([tooYoung.status, tooYoung.body.error.code]).toEqual([422, "RENTAL_BOOKING_RULE"]);
    expect(tooYoung.body.error.message).toContain("SUV drivers are at least 25");

    const noLicence = await book({
      customerId: unlicensed,
      pickupAt: future(24),
      returnAt: future(25),
    });
    expect(noLicence.status).toBe(201);
    expect(data(noLicence).warnings).toEqual([
      expect.stringContaining("driving licence is not recorded"),
    ]);
    await step(data(noLicence).id, "cancel", { reason: "Test over" }).expect(200);

    const expiring = await customer({
      dateOfBirth: "1980-01-01",
      licenceNumber: "DL-999",
      licenceExpiresOn: "2027-05-24",
    });
    const refused = await book({
      customerId: expiring,
      pickupAt: future(24),
      returnAt: future(25),
    });
    expect(refused.body.error.message).toContain("expires on 2027-05-24, before the return");
  });
});
