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
 * The availability engine (P5-2): the exclusion constraint, concurrent holds of one vehicle and
 * of a class, turnaround, lapsed holds, maintenance blocks moving class bookings, availability
 * with prices and the calendar.
 */
let container: Container;
let app: Express;
let platform: pg.Pool;
let t: ProvisionedTenant;
let hq: string;
let agent: string;
let suv: string;
let cars: string[];
const codes = new Map<string, string>();

const api = () => request(app);
const as = (token: string) => ({ Authorization: `Bearer ${token}` });
const owner = () => as(t.ownerAccessToken);
// Accra is UTC; the dates are in the future of the test run.
const day = (d: number, hour = 9, minute = 0) =>
  `2027-03-${String(d).padStart(2, "0")}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00Z`;

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

async function vehicleIn(classId: string | null): Promise<string> {
  const registered = await api()
    .post("/api/v1/vehicles")
    .set(owner())
    .send({ make: "Toyota", model: "RAV4", plateNumber: `GR ${randomUUID().slice(0, 4)}-27` });
  expect(registered.status, JSON.stringify(registered.body)).toBe(201);
  const id = registered.body.data.id as string;
  codes.set(id, registered.body.data.code as string);
  if (classId !== null)
    await api()
      .put(`/api/v1/vehicles/${id}/rental-class`)
      .set(owner())
      .send({ classId })
      .expect(200);
  return id;
}

const hold = (body: Record<string, unknown>, token = agent) =>
  api().post("/api/v1/rentals/holds").set(as(token)).send(body);

const release = (id: string, token = t.ownerAccessToken) =>
  api().post(`/api/v1/vehicle-blocks/${id}/release`).set(as(token)).send({ reason: "Test over" });

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
    .send({ code: "SUV", name: "SUV", turnaroundMinutes: 60 });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  suv = created.body.data.id as string;
  expect(created.body.data.turnaroundMinutes).toBe(60);
  cars = [];
  for (let i = 0; i < 3; i++) cars.push(await vehicleIn(suv));
  await api()
    .post("/api/v1/rental-rate-plans")
    .set(owner())
    .send({ code: "SUV-STD", name: "SUV standard", classId: suv, dailyRate: "300.00" })
    .expect(201);
});

afterAll(async () => {
  await disposeContainer(container);
});

describe("the database", () => {
  it("refuses two live blocks of a vehicle that overlap, whoever writes them", async () => {
    const insert = (from: string, to: string, status = "confirmed") =>
      t.tenant.query<{ id: string }>(
        `insert into vehicle_blocks (vehicle_id, branch_id, reason, status, starts_at, ends_at,
           blocked_until, released_at)
         values ($1, $2, 'other', $3, $4, $5, $5, case when $3 = 'released' then now() end)
         returning id`,
        [cars[0], hq, status, from, to],
      );
    const first = await insert(day(1), day(3));
    await expect(insert(day(2), day(4))).rejects.toMatchObject({ code: "23P01" });
    await expect(insert(day(2), day(4), "released")).resolves.toBeDefined();
    // Back to back is fine: ranges are half-open.
    const next = await insert(day(3), day(4));
    await t.tenant.query(
      "update vehicle_blocks set status = 'released', released_at = now() where id = any($1)",
      [[first[0]!.id, next[0]!.id]],
    );
  });
});

describe("holds", () => {
  it("lets one of many concurrent holds of a vehicle through", async () => {
    const body = { vehicleId: cars[0], pickupAt: day(5), returnAt: day(7) };
    const results = await Promise.all(Array.from({ length: 8 }, () => hold(body)));
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 409, 409, 409, 409, 409, 409, 409]);
    const refused = results.find((r) => r.status === 409)!;
    expect(refused.body.error.code).toBe("VEHICLE_UNAVAILABLE");
    const won = results.find((r) => r.status === 201)!.body.data;
    expect(won).toMatchObject({
      vehicleId: cars[0],
      classId: null,
      reason: "rental",
      status: "hold",
      endsAt: "2027-03-07T09:00:00.000Z",
      blockedUntil: "2027-03-07T10:00:00.000Z",
    });
    await release(won.id as string).expect(200);
  });

  it("gives concurrent class holds different vehicles until the class is full", async () => {
    const body = { classId: suv, branchId: hq, pickupAt: day(10), returnAt: day(12) };
    const results = await Promise.all(Array.from({ length: 6 }, () => hold(body)));
    const won = results
      .filter((r) => r.status === 201)
      .map((r) => r.body.data as { id: string; vehicleId: string; classId: string });
    expect(won).toHaveLength(3);
    expect(new Set(won.map((b) => b.vehicleId))).toEqual(new Set(cars));
    expect(won.every((b) => b.classId === suv)).toBe(true);
    const refused = results.find((r) => r.status === 409)!;
    expect(refused.body.error.message).toContain("No SUV is free");
    for (const b of won) await release(b.id).expect(200);
  });

  it("keeps the class turnaround after a rental, and lets lapsed holds go", async () => {
    const first = await hold({ vehicleId: cars[1], pickupAt: day(14), returnAt: day(16) });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const tooSoon = await hold({
      vehicleId: cars[1],
      pickupAt: day(16, 9, 30),
      returnAt: day(17),
    });
    expect([tooSoon.status, tooSoon.body.error.message]).toEqual([
      409,
      `${codes.get(cars[1]!)} is held for a rental from 2027-03-14T09:00:00.000Z to 2027-03-16T10:00:00.000Z`,
    ]);
    const after = await hold({ vehicleId: cars[1], pickupAt: day(16, 10), returnAt: day(17) });
    expect(after.status).toBe(201);

    // The first hold lapses: the vehicle is free again for its times.
    await t.tenant.query(
      "update vehicle_blocks set expires_at = now() - interval '1 minute' where id = $1",
      [first.body.data.id],
    );
    const retaken = await hold({ vehicleId: cars[1], pickupAt: day(14), returnAt: day(15) });
    expect(retaken.status, JSON.stringify(retaken.body)).toBe(201);
    const lapsed = await api().get(`/api/v1/vehicle-blocks/${first.body.data.id}`).set(owner());
    expect(lapsed.body.data).toMatchObject({ status: "released", releasedReason: "Hold lapsed" });
    expect((await release(first.body.data.id as string)).body.error.code).toBe(
      "VEHICLE_BLOCK_RULE",
    );
    for (const id of [after.body.data.id, retaken.body.data.id] as string[])
      await release(id, agent).expect(200);
  });

  it("refuses holds that cannot be", async () => {
    const past = await hold({
      classId: suv,
      pickupAt: "2020-01-01T09:00:00Z",
      returnAt: "2020-01-02T09:00:00Z",
    });
    expect([past.status, past.body.error.code]).toEqual([422, "VEHICLE_BLOCK_RULE"]);
    const backwards = await hold({ classId: suv, pickupAt: day(20), returnAt: day(19) });
    expect(backwards.status).toBe(422);
    const neither = await hold({ pickupAt: day(19), returnAt: day(20) });
    expect(neither.status).toBe(422);
    const unclassed = await vehicleIn(null);
    await api()
      .post(`/api/v1/vehicles/${unclassed}/status`)
      .set(owner())
      .send({ status: "in_maintenance", reason: "Gearbox" });
    const offRoad = await hold({ vehicleId: unclassed, pickupAt: day(19), returnAt: day(20) });
    expect([offRoad.status, offRoad.body.error.message]).toEqual([
      409,
      `${codes.get(unclassed)} is not offered for rent (in_maintenance)`,
    ]);
  });
});

describe("blocks", () => {
  it("moves class bookings off a vehicle going to maintenance, or refuses", async () => {
    const booked = await hold({ classId: suv, pickupAt: day(22), returnAt: day(24) });
    expect(booked.status).toBe(201);
    const onVehicle = booked.body.data.vehicleId as string;
    const maintenance = {
      vehicleId: onVehicle,
      reason: "maintenance",
      startsAt: day(21),
      endsAt: day(25),
      note: "Service",
    };
    expect(
      (await api().post("/api/v1/vehicle-blocks").set(as(agent)).send(maintenance)).status,
    ).toBe(403);
    const refused = await api().post("/api/v1/vehicle-blocks").set(owner()).send(maintenance);
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toContain("is held for a rental");

    const placed = await api()
      .post("/api/v1/vehicle-blocks")
      .set(owner())
      .send({ ...maintenance, displace: true });
    expect(placed.status, JSON.stringify(placed.body)).toBe(201);
    expect(placed.body.data.block).toMatchObject({ reason: "maintenance", status: "confirmed" });
    expect(placed.body.data.moved).toEqual([
      { blockId: booked.body.data.id, fromVehicleId: onVehicle, toVehicleId: expect.any(String) },
    ]);
    const moved = await api().get(`/api/v1/vehicle-blocks/${booked.body.data.id}`).set(as(agent));
    expect(moved.body.data.vehicleId).not.toBe(onVehicle);

    // A hold of one named vehicle cannot be moved: maintenance over it is refused.
    const named = await hold({ vehicleId: onVehicle, pickupAt: day(26), returnAt: day(27) });
    const over = await api()
      .post("/api/v1/vehicle-blocks")
      .set(owner())
      .send({ ...maintenance, startsAt: day(26), endsAt: null, displace: true });
    expect(over.status).toBe(409);

    // The agent moves the class booking to the last vehicle; a named one must be in the class.
    const target = cars.find((c) => c !== onVehicle && c !== moved.body.data.vehicleId)!;
    const swapped = await api()
      .post(`/api/v1/vehicle-blocks/${booked.body.data.id}/move`)
      .set(as(agent))
      .send({ vehicleId: target });
    expect(swapped.body.data.vehicleId).toBe(target);
    expect(
      (
        await api()
          .post(`/api/v1/vehicle-blocks/${named.body.data.id}/move`)
          .set(as(agent))
          .send({})
      ).status,
    ).toBe(422);

    // Maintenance ends early; the times change, with the same checks.
    const shorter = await api()
      .patch(`/api/v1/vehicle-blocks/${placed.body.data.block.id}`)
      .set(owner())
      .send({ endsAt: day(23) });
    expect(shorter.body.data.endsAt).toBe("2027-03-23T09:00:00.000Z");
    const longer = await api()
      .patch(`/api/v1/vehicle-blocks/${placed.body.data.block.id}`)
      .set(owner())
      .send({ endsAt: day(27) });
    expect(longer.status).toBe(409);
    expect(
      (
        await api()
          .patch(`/api/v1/vehicle-blocks/${placed.body.data.block.id}`)
          .set(as(agent))
          .send({ note: "x" })
      ).status,
    ).toBe(404);

    const rows = await t.tenant.query<{ action: string }>(
      `select action from audit_logs where entity_type = 'vehicle_block' and entity_id = $1
        order by occurred_at`,
      [booked.body.data.id],
    );
    expect(rows.map((r) => r.action)).toEqual([
      "rental.hold_placed",
      "vehicle.block_moved",
      "vehicle.block_moved",
    ]);
    for (const id of [booked.body.data.id, named.body.data.id, placed.body.data.block.id])
      await release(id as string).expect(200);
  });
});

describe("availability and the calendar", () => {
  it("lists free vehicles of each class with the price", async () => {
    const taken = await hold({ vehicleId: cars[2], pickupAt: day(28), returnAt: day(30) });
    const found = await api()
      .get("/api/v1/rentals/availability")
      .query({ from: day(29), to: day(31) })
      .set(as(agent));
    expect(found.status, JSON.stringify(found.body)).toBe(200);
    expect(found.body.data).toEqual([
      expect.objectContaining({
        classId: suv,
        vehicles: 3,
        free: [
          expect.objectContaining({ id: cars[0], code: codes.get(cars[0]!) }),
          expect.objectContaining({ id: cars[1], code: codes.get(cars[1]!) }),
        ],
        price: expect.objectContaining({
          days: 2,
          total: expect.objectContaining({ amountMinor: 60_000 }),
        }),
        priceNote: null,
      }),
    ]);

    const calendar = await api()
      .get("/api/v1/rentals/calendar")
      .query({ from: "2027-03-28", to: "2027-03-31" })
      .set(as(agent));
    expect(calendar.status, JSON.stringify(calendar.body)).toBe(200);
    const row = (calendar.body.data.vehicles as { id: string; blocks: unknown[] }[]).find(
      (v) => v.id === cars[2],
    )!;
    expect(row.blocks).toEqual([
      expect.objectContaining({ id: taken.body.data.id, reason: "rental", status: "hold" }),
    ]);
    expect(calendar.body.data.classes).toEqual([
      expect.objectContaining({
        classId: suv,
        days: [
          { date: "2027-03-28", vehicles: 3, free: 2 },
          { date: "2027-03-29", vehicles: 3, free: 2 },
          { date: "2027-03-30", vehicles: 3, free: 2 },
          { date: "2027-03-31", vehicles: 3, free: 3 },
        ],
      }),
    ]);
    const tooLong = await api()
      .get("/api/v1/rentals/calendar")
      .query({ from: "2027-01-01", to: "2027-06-01" })
      .set(as(agent));
    expect(tooLong.status).toBe(422);
    await release(taken.body.data.id as string).expect(200);
  });
});
