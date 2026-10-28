import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { Container } from "inversify";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MaintenanceAlerts } from "../../application/use-cases/maintenance/MaintenanceAlerts.js";
import {
  ProvisionedTenants,
  type ProvisionedTenant,
} from "../../testing/fixtures/ProvisionedTenants.js";
import { StaffFixtures } from "../../testing/fixtures/StaffFixtures.js";
import { createTestContainer } from "../../testing/testContainer.js";
import { disposeContainer } from "../dependency-injection/container.js";
import { TYPES } from "../dependency-injection/types.js";

/**
 * Maintenance KPIs, the compliance dashboard and the daily maintenance alerts (P6-5) end to end:
 * cost by kind and type with what insurers paid back, cost per km from the odometer, downtime and
 * availability, preventive against corrective work and failures by model; vehicles red, amber or
 * green on documents and fines with drivers' licences expiring; idle vehicles and work orders
 * past their expected time told once.
 */
let container: Container;
let app: Express;
let t: ProvisionedTenant;

type Money = { amountMinor: number };

const api = () => request(app);
const owner = () => ({ Authorization: `Bearer ${t.ownerAccessToken}` });
const digits = (n: number) => String(Math.floor(Math.random() * 10 ** n)).padStart(n, "0");
const DAY = 86_400_000;
const day = (offset: number) => new Date(Date.now() + offset * DAY).toISOString().slice(0, 10);

async function vehicle(make: string, model: string): Promise<{ id: string; plate: string }> {
  const plate = `GR ${digits(4)}-26`;
  const res = await api()
    .post("/api/v1/vehicles")
    .set(owner())
    .send({ make, model, plateNumber: plate, odometer: 10_000 });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return { id: res.body.data.id as string, plate };
}

async function workOrder(body: Record<string, unknown>): Promise<string> {
  const res = await api().post("/api/v1/work-orders").set(owner()).send(body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data.id as string;
}

const act = (id: string, path: string, body: Record<string, unknown> = {}) =>
  api().post(`/api/v1/work-orders/${id}/${path}`).set(owner()).send(body);

async function titles(): Promise<string[]> {
  const inbox = await api().get("/api/v1/notifications?limit=100").set(owner());
  return (inbox.body.data as { title: string }[]).map((n) => n.title);
}

beforeAll(async () => {
  container = await createTestContainer({ AUTH_RATE_LIMIT_MAX: "10000", RATE_LIMIT_MAX: "100000" });
  app = container.get<Express>(TYPES.HttpApp);
  const staff = await new StaffFixtures(container).create(["super_admin"]);
  t = await new ProvisionedTenants(container, app, staff).create();
});

afterAll(async () => {
  await disposeContainer(container);
});

describe("maintenance reports", () => {
  it("reports maintenance cost, cost per km, downtime and failures, compliance, and alerts idle and late vehicles", async () => {
    const a = await vehicle("Toyota", "Corolla");
    const b = await vehicle("Toyota", "Corolla");
    const c = await vehicle("Nissan", "Almera");
    // In the fleet for the last ten days.
    await t.tenant.query(
      "update vehicles set created_at = now() - interval '10 days' where id = any($1::uuid[])",
      [[a.id, b.id, c.id]],
    );
    for (const [id, value] of [
      [a.id, 13_000],
      [b.id, 11_000],
    ] as const)
      await api().post(`/api/v1/vehicles/${id}/odometer`).set(owner()).send({ value }).expect(201);
    const insurer = await api()
      .post("/api/v1/suppliers")
      .set(owner())
      .send({ name: "Star Assurance", type: "insurer" });

    // --- a service and a repair off the road, the insurer paying part ---
    const service = await workOrder({
      vehicleId: a.id,
      type: "preventive",
      title: "Oil change",
      lines: [
        { kind: "labour", description: "Labour", quantity: 1, unitCost: "200.00" },
        { kind: "part", description: "Oil and filter", quantity: 1, unitCost: "300.00" },
      ],
    });
    await act(service, "start").expect(200);
    await act(service, "complete").expect(200);
    const repair = await workOrder({
      vehicleId: a.id,
      type: "corrective",
      title: "Gearbox",
      offRoad: true,
      lines: [{ kind: "sublet", description: "Gearbox rebuild", quantity: 1, unitCost: "1000.00" }],
    });
    const done = await act(repair, "complete", {
      allocations: [{ payer: "insurer", amount: "400.00", insurerId: insurer.body.data.id }],
    });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    // Two days in the workshop.
    await t.tenant.query(
      "update work_orders set downtime_started_at = downtime_ended_at - interval '2 days' where id = $1",
      [repair],
    );
    const cancelled = await workOrder({
      vehicleId: b.id,
      type: "corrective",
      title: "False alarm",
    });
    await act(cancelled, "cancel", { reason: "Nothing wrong" }).expect(200);

    const kpis = await api().get("/api/v1/dashboards/maintenance").set(owner());
    expect(kpis.status, JSON.stringify(kpis.body)).toBe(200);
    const k = kpis.body.data;
    expect(k.vehicles).toBe(3);
    expect(k.cost).toMatchObject({
      total: { amountMinor: 150_000 },
      recovered: { amountMinor: 40_000 },
      business: { amountMinor: 110_000 },
      byKind: {
        labour: { amountMinor: 20_000 },
        part: { amountMinor: 30_000 },
        sublet: { amountMinor: 100_000 },
        other: { amountMinor: 0 },
      },
      perKm: { amountMinor: 38 },
    });
    expect(k.distanceKm).toBe(4_000);
    expect(k.workOrders).toEqual({ completed: 2, open: 0, offRoad: 0 });
    expect(k.preventive).toMatchObject({
      preventive: { workOrders: 1, cost: { amountMinor: 50_000 } },
      corrective: { workOrders: 1, cost: { amountMinor: 100_000 } },
      preventivePercent: 50,
    });
    expect(k.downtime.days).toBe(2);
    expect(k.downtime.availabilityPercent).toBeCloseTo(93.3, 0);
    expect(k.failures).toEqual({ count: 1, meanDaysBetween: 30 });
    expect(k.services).toEqual({ due: 0, overdue: 0 });
    const first = k.byVehicle[0];
    expect(first).toMatchObject({
      vehicleId: a.id,
      workOrders: 2,
      cost: { amountMinor: 150_000 },
      distance: { value: 3_000, unit: "km" },
      costPerDistance: { amountMinor: 50 },
      downtimeDays: 2,
      availabilityPercent: 80,
      failures: 1,
    });
    expect(
      (
        k.byModel as { make: string; failures: number; meanDaysBetweenFailures: number | null }[]
      ).map((r) => [r.make, r.failures, r.meanDaysBetweenFailures]),
    ).toEqual([
      ["Toyota", 1, 20],
      ["Nissan", 0, null],
    ]);
    expect(
      (k.series as { cost: Money; workOrders: number }[]).reduce((s, p) => s + p.workOrders, 0),
    ).toBe(2);

    // --- compliance: an expired insurance, a roadworthy expiring, a fine past its date ---
    const doc = (id: string, type: string, expiresOn: string) =>
      api().post(`/api/v1/vehicles/${id}/documents`).set(owner()).send({ type, expiresOn });
    await doc(a.id, "insurance", day(-5)).expect(201);
    await doc(b.id, "insurance", day(-400)).expect(201);
    await doc(b.id, "insurance", day(300)).expect(201); // renewed: the old one no longer counts
    await doc(b.id, "roadworthy", day(10)).expect(201);
    const fine = await api()
      .post("/api/v1/traffic-offences")
      .set(owner())
      .send({
        vehicleId: c.id,
        type: "parking",
        offenceAt: new Date(Date.now() - 20 * DAY).toISOString(),
        authority: "AMA",
        fine: "50.00",
        dueOn: day(-3),
      });
    expect(fine.status, JSON.stringify(fine.body)).toBe(201);
    const driver = await api()
      .post("/api/v1/drivers")
      .set(owner())
      .send({
        firstName: "Yaw",
        lastName: `Driver${digits(3)}`,
        phone: `+23324${digits(7)}`,
        ghanaCardNumber: `GHA-${digits(9)}-1`,
        licenceNumber: `DL-${randomUUID().slice(0, 6)}`,
        licenceClass: "B",
        licenceExpiresOn: day(12),
      });
    expect(driver.status, JSON.stringify(driver.body)).toBe(201);
    await api()
      .post(`/api/v1/drivers/${driver.body.data.id}/guarantors`)
      .set(owner())
      .send({ name: "Esi", phone: `+23320${digits(7)}` });
    await api()
      .post(`/api/v1/drivers/${driver.body.data.id}/activate`)
      .set(owner())
      .send({})
      .expect(200);

    const compliance = await api().get("/api/v1/dashboards/compliance").set(owner());
    expect(compliance.status, JSON.stringify(compliance.body)).toBe(200);
    const cd = compliance.body.data;
    expect(cd.summary).toEqual({
      vehicles: { red: 1, amber: 2, green: 0 },
      documentsExpired: 1,
      documentsExpiring: 1,
      licencesExpired: 0,
      licencesExpiring: 1,
      servicesOverdue: 0,
      servicesDue: 0,
      finesOverdue: 1,
      openIncidents: 0,
    });
    const levels = (cd.vehicles as { vehicleId: string; level: string }[]).map((v) => [
      v.vehicleId,
      v.level,
    ]);
    expect(levels[0]).toEqual([a.id, "red"]);
    expect(levels.slice(1).sort()).toEqual(
      [
        [b.id, "amber"],
        [c.id, "amber"],
      ].sort(),
    );
    expect(cd.drivers).toEqual([
      expect.objectContaining({ driverId: driver.body.data.id, expired: false }),
    ]);
    const soon = await api().get("/api/v1/dashboards/compliance?days=5").set(owner());
    expect(soon.body.data.summary.vehicles).toEqual({ red: 1, amber: 1, green: 1 });

    // --- the daily alerts: an idle vehicle and a work order past its time, each told once ---
    await t.tenant.query(
      "update vehicles set status_changed_at = now() - interval '10 days' where id = $1",
      [b.id],
    );
    const late = await workOrder({
      vehicleId: c.id,
      type: "corrective",
      title: "Brakes",
      offRoad: true,
      expectedBackAt: new Date(Date.now() + DAY).toISOString(),
    });
    await t.tenant.query(
      "update work_orders set expected_back_at = now() - interval '1 hour' where id = $1",
      [late],
    );
    const alerts = container.get<MaintenanceAlerts>(TYPES.MaintenanceAlerts);
    await t.tenant.run(() => alerts.run(day(0)));
    await t.tenant.run(() => alerts.run(day(0)));
    const inbox = await titles();
    expect(inbox.filter((x) => x === `${b.plate} has been idle 10 days`)).toHaveLength(1);
    expect(inbox.filter((x) => x.startsWith(`${a.plate} has been idle`))).toEqual([]);
    expect(inbox.filter((x) => x.startsWith(`${c.plate} is not back from WO-`))).toHaveLength(1);

    // --- the idle threshold is set per business ---
    const set = await api()
      .patch("/api/v1/settings/notifications")
      .set(owner())
      .send({ rules: { vehicle_idle: { afterDays: 30 } } });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(
      (set.body.data.rules as { key: string; afterDays?: number }[]).find(
        (r) => r.key === "vehicle_idle",
      ),
    ).toMatchObject({ afterDays: 30 });
  });
});
