import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { Container } from "inversify";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ProvisionedTenants,
  type ProvisionedTenant,
} from "../../testing/fixtures/ProvisionedTenants.js";
import { StaffFixtures } from "../../testing/fixtures/StaffFixtures.js";
import { createTestContainer } from "../../testing/testContainer.js";
import { disposeContainer } from "../dependency-injection/container.js";
import { TYPES } from "../dependency-injection/types.js";

let container: Container;
let app: Express;
let t: ProvisionedTenant;
let checklist: { items: { key: string; ok: boolean }[]; fuelLevel: string };

const api = () => request(app);
const owner = () => ({ Authorization: `Bearer ${t.ownerAccessToken}` });
const digits = (n: number) => String(Math.floor(Math.random() * 10 ** n)).padStart(n, "0");

async function activeDriver(name = "Kwame"): Promise<string> {
  const created = await api()
    .post("/api/v1/drivers")
    .set(owner())
    .send({
      firstName: name,
      lastName: "Mensah",
      phone: `024${digits(7)}`,
      ghanaCardNumber: `GHA-${digits(9)}-1`,
      licenceNumber: `DL-${randomUUID().slice(0, 6)}`,
      licenceClass: "B",
      licenceExpiresOn: "2030-01-01",
    });
  const id = created.body.data.id as string;
  await api()
    .post(`/api/v1/drivers/${id}/guarantors`)
    .set(owner())
    .send({ name: "Yaw Boateng", phone: `020${digits(7)}` });
  const active = await api().post(`/api/v1/drivers/${id}/activate`).set(owner()).send({});
  expect(active.status, JSON.stringify(active.body)).toBe(200);
  return id;
}

async function vehicle(): Promise<string> {
  const res = await api()
    .post("/api/v1/vehicles")
    .set(owner())
    .send({
      make: "Toyota",
      model: "Corolla",
      plateNumber: `GR ${digits(4)}-26`,
      odometer: 10_000,
    });
  return res.body.data.id as string;
}

const assign = (vehicleId: string, driverId: string, body: Record<string, unknown> = {}) =>
  api()
    .post(`/api/v1/vehicles/${vehicleId}/assignment`)
    .set(owner())
    .send({
      driverId,
      odometer: 10_000,
      checklist,
      terms: { mode: "fixed_target", target: "250.00", frequency: "daily", daysOff: [0] },
      ...body,
    });

beforeAll(async () => {
  container = await createTestContainer({ AUTH_RATE_LIMIT_MAX: "10000" });
  app = container.get<Express>(TYPES.HttpApp);
  const staff = await new StaffFixtures(container).create(["super_admin"]);
  t = await new ProvisionedTenants(container, app, staff).create();
  const settings = await api().get("/api/v1/settings/assignments").set(owner());
  checklist = {
    items: (settings.body.data.handoverItems as { key: string }[]).map((i) => ({
      key: i.key,
      ok: true,
    })),
    fuelLevel: "half",
  };
});

afterAll(async () => {
  await disposeContainer(container);
});

describe("vehicle assignments", () => {
  it("assigns an active driver with terms, warns about compliance and links both sides", async () => {
    const v = await vehicle();
    const d = await activeDriver();
    const res = await assign(v, d);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data.assignment).toMatchObject({
      type: "remittance",
      startOdometer: 10_000,
      terms: {
        mode: "fixed_target",
        target: { amountMinor: 25_000 },
        frequency: "daily",
        daysOff: [0],
      },
      vehicle: { id: v },
      driver: { id: d, name: "Kwame Mensah" },
    });
    expect(res.body.data.warnings.join(" ")).toMatch(/roadworthy missing/);

    const car = await api().get(`/api/v1/vehicles/${v}/overview`).set(owner());
    expect(car.body.data.vehicle.status).toBe("assigned");
    expect(car.body.data.currentDriver).toMatchObject({ driverId: d, name: "Kwame Mensah" });
    const driver = await api().get(`/api/v1/drivers/${d}`).set(owner());
    expect(driver.body.data.currentAssignment.vehicle.id).toBe(v);
    const history = await api().get(`/api/v1/vehicles/${v}/status-history`).set(owner());
    expect(history.body.data[0]).toMatchObject({
      from: "available",
      to: "assigned",
      ref: { type: "assignment" },
    });
  });

  it("keeps one driver per vehicle and one vehicle per driver", async () => {
    const v1 = await vehicle();
    const v2 = await vehicle();
    const d1 = await activeDriver();
    const d2 = await activeDriver();
    expect((await assign(v1, d1)).status).toBe(201);
    const taken = await assign(v1, d2);
    expect([taken.status, taken.body.error.code]).toEqual([422, "ASSIGNMENT_RULE"]);
    const busy = await assign(v2, d1);
    expect([busy.status, busy.body.error.code]).toEqual([409, "ASSIGNMENT_CONFLICT"]);

    const suspend = await api()
      .post(`/api/v1/drivers/${d1}/suspend`)
      .set(owner())
      .send({ reason: "Shortfalls" });
    expect(suspend.body.error.message).toMatch(/end the assignment/);
  });

  it("hands over in one step and answers who was driving at a given time", async () => {
    const v = await vehicle();
    const first = await activeDriver("Ama");
    const second = await activeDriver("Kofi");
    await assign(v, first, { startedAt: new Date(Date.now() - 3_600_000).toISOString() });
    const before = new Date(Date.now() - 60_000).toISOString();

    const handover = await api()
      .post(`/api/v1/vehicles/${v}/assignment/handover`)
      .set(owner())
      .send({ toDriverId: second, odometer: 10_180, checklist, reason: "Shift change" });
    expect(handover.status, JSON.stringify(handover.body)).toBe(200);
    expect(handover.body.data.assignment.driver.id).toBe(second);

    const at = await api()
      .get(`/api/v1/vehicles/${v}/assignment-at?at=${encodeURIComponent(before)}`)
      .set(owner());
    expect(at.body.data.driver.id).toBe(first);
    const list = await api().get(`/api/v1/assignments?vehicleId=${v}`).set(owner());
    expect(
      (list.body.data as { driver: { id: string }; distance: number | null }[]).map((a) => [
        a.driver.id,
        a.distance,
      ]),
    ).toEqual([
      [second, null],
      [first, 180],
    ]);
    expect((await api().get(`/api/v1/vehicles/${v}`).set(owner())).body.data).toMatchObject({
      status: "assigned",
      odometer: { value: 10_180 },
    });
  });

  it("takes the vehicle back to the workshop and refuses overlapping late entries", async () => {
    const v = await vehicle();
    const d = await activeDriver();
    await assign(v, d, { startedAt: new Date(Date.now() - 7_200_000).toISOString() });
    const end = (body: Record<string, unknown>) =>
      api()
        .post(`/api/v1/vehicles/${v}/assignment/end`)
        .set(owner())
        .send({ checklist, reason: "Engine noise", vehicleStatus: "in_maintenance", ...body });
    const lower = await end({ odometer: 9_000 });
    expect(lower.status).toBe(422);
    const ended = await end({ odometer: 10_300 });
    expect(ended.status, JSON.stringify(ended.body)).toBe(200);
    expect(ended.body.data).toMatchObject({ endReason: "Engine noise", distance: 300 });
    expect((await api().get(`/api/v1/vehicles/${v}`).set(owner())).body.data.status).toBe(
      "in_maintenance",
    );
    expect(
      (await api().post(`/api/v1/drivers/${d}/suspend`).set(owner()).send({ reason: "Shortfalls" }))
        .status,
    ).toBe(200);

    await api()
      .post(`/api/v1/vehicles/${v}/status`)
      .set(owner())
      .send({ status: "available", reason: "Repaired" });
    const other = await activeDriver();
    const overlapping = await assign(v, other, {
      odometer: 10_300,
      startedAt: new Date(Date.now() - 3_600_000).toISOString(),
    });
    expect([overlapping.status, overlapping.body.error.code]).toEqual([409, "ASSIGNMENT_CONFLICT"]);
  });

  it("checks the checklist, the terms and the business's compliance rule", async () => {
    const v = await vehicle();
    const d = await activeDriver();
    const partial = await assign(v, d, { checklist: { items: [checklist.items[0]] } });
    expect(partial.body.error.message).toMatch(/Answer every checklist item/);
    const noTarget = await assign(v, d, { terms: { mode: "fixed_target" } });
    expect(noTarget.body.error.message).toMatch(/amount and a period/);

    await api()
      .patch("/api/v1/settings/vehicles")
      .set(owner())
      .send({ compliance: { enforcement: "block" } });
    const blocked = await assign(v, d);
    expect([blocked.status, blocked.body.error.code]).toEqual([422, "VEHICLE_NOT_COMPLIANT"]);
    await api()
      .patch("/api/v1/settings/vehicles")
      .set(owner())
      .send({ compliance: { enforcement: "warn" } });

    expect((await assign(v, d)).status).toBe(201);
    const terms = await api()
      .patch(`/api/v1/vehicles/${v}/assignment/terms`)
      .set(owner())
      .send({ mode: "variable" });
    expect(terms.body.data.terms).toEqual({
      mode: "variable",
      target: null,
      frequency: null,
      daysOff: [],
    });
  });
});
