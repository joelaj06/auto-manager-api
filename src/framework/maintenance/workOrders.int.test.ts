import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { Container } from "inversify";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

/**
 * Work orders (P6-2) end to end: a vehicle off the road for a job moving a class booking to
 * another vehicle, the lines and totals, a preventive order closing its service task, an issue
 * resolved with the driver paying a share, a rental damage repaired at the renter's cost, a
 * Work & Pay vehicle's downtime, a cancellation and the vendor's record.
 */
let container: Container;
let app: Express;
let t: ProvisionedTenant;
let checklist: { items: { key: string; ok: boolean }[] };
let workshop: string;
let driverId: string;

type Money = { amountMinor: number };
type Order = {
  id: string;
  number: string;
  status: string;
  offRoad: boolean;
  blockId: string | null;
  serviceTaskIds: string[];
  total: Money;
  byKind: Record<string, Money>;
  allocations: {
    payer: string;
    amount: Money;
    driverId: string | null;
    customerId: string | null;
  }[];
  expenseId: string | null;
  driverExpenseId: string | null;
  workpayAgreementId: string | null;
  downtimeHours: number | null;
};

const api = () => request(app);
const owner = () => ({ Authorization: `Bearer ${t.ownerAccessToken}` });
const digits = (n: number) => String(Math.floor(Math.random() * 10 ** n)).padStart(n, "0");
const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

async function vehicle(make: string, model: string, odometer = 1_000): Promise<string> {
  const res = await api()
    .post("/api/v1/vehicles")
    .set(owner())
    .send({ make, model, plateNumber: `GR ${digits(4)}-26`, odometer });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data.id as string;
}

const status = async (id: string) =>
  (await api().get(`/api/v1/vehicles/${id}`).set(owner())).body.data.status as string;

async function open(body: Record<string, unknown>): Promise<Order> {
  const res = await api().post("/api/v1/work-orders").set(owner()).send(body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data as Order;
}

const act = (id: string, path: string, body: Record<string, unknown> = {}) =>
  api().post(`/api/v1/work-orders/${id}/${path}`).set(owner()).send(body);

async function expense(id: string) {
  const rows = await t.tenant.query<{
    amount_minor: string;
    charge_to_driver: boolean;
    driver_id: string | null;
    payee_name: string | null;
    payee_id: string | null;
    source_type: string;
    status: string;
  }>(
    `select amount_minor, charge_to_driver, driver_id, payee_name, payee_id, source_type, status
       from expenses where id = $1`,
    [id],
  );
  return { ...rows[0]!, amount_minor: Number(rows[0]!.amount_minor) };
}

async function driver(employmentType?: string): Promise<{ id: string; token: string | null }> {
  const res = await api()
    .post("/api/v1/drivers")
    .set(owner())
    .send({
      firstName: "Kwame",
      lastName: `Driver${digits(3)}`,
      phone: `+23324${digits(7)}`,
      ghanaCardNumber: `GHA-${digits(9)}-1`,
      licenceNumber: `DL-${randomUUID().slice(0, 6)}`,
      licenceClass: "B",
      licenceExpiresOn: "2030-01-01",
      ...(employmentType === undefined ? {} : { employmentType }),
    });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const id = res.body.data.id as string;
  await api()
    .post(`/api/v1/drivers/${id}/guarantors`)
    .set(owner())
    .send({ name: "Yaw", phone: `+23320${digits(7)}` });
  await api().post(`/api/v1/drivers/${id}/activate`).set(owner()).send({}).expect(200);
  if (employmentType === undefined) return { id, token: null };
  const access = await api().post(`/api/v1/drivers/${id}/app-access`).set(owner());
  const token = /#token=([A-Za-z0-9_-]+)/.exec(access.body.data.invitation.webUrl as string)![1]!;
  const accepted = await api()
    .post("/api/v1/auth/invitations/accept")
    .set("X-Tenant", t.slug)
    .send({ token, password: OWNER_PASSWORD });
  return { id, token: accepted.body.data.accessToken as string };
}

beforeAll(async () => {
  container = await createTestContainer({ AUTH_RATE_LIMIT_MAX: "10000", RATE_LIMIT_MAX: "100000" });
  app = container.get<Express>(TYPES.HttpApp);
  const staff = await new StaffFixtures(container).create(["super_admin"]);
  t = await new ProvisionedTenants(container, app, staff).create();
  await api().patch("/api/v1/settings/documents").set(owner()).send({ requireOtp: false });
  const handover = await api().get("/api/v1/settings/assignments").set(owner());
  checklist = {
    items: (handover.body.data.handoverItems as { key: string }[]).map((i) => ({
      key: i.key,
      ok: true,
    })),
  };
  const vendor = await api()
    .post("/api/v1/suppliers")
    .set(owner())
    .send({ name: "Abossey Okai Motors", type: "workshop" });
  expect(vendor.status, JSON.stringify(vendor.body)).toBe(201);
  workshop = vendor.body.data.id as string;
  driverId = (await driver()).id;
});

afterAll(async () => {
  await disposeContainer(container);
});

describe("work orders", () => {
  it("takes a vehicle off the road, moves the class booking and repairs a rental damage at the renter's cost", async () => {
    // --- two cars in a class, a class booking on the first ---
    const cls = await api()
      .post("/api/v1/vehicle-classes")
      .set(owner())
      .send({ code: "CMP", name: "Compact" });
    const classId = cls.body.data.id as string;
    const cars = [await vehicle("Kia", "Picanto"), await vehicle("Kia", "Picanto")];
    for (const car of cars)
      await api()
        .put(`/api/v1/vehicles/${car}/rental-class`)
        .set(owner())
        .send({ classId })
        .expect(200);
    await api()
      .post("/api/v1/rental-rate-plans")
      .set(owner())
      .send({ code: "CMP", name: "Compact", classId, dailyRate: "200.00" })
      .expect(201);
    const rentals = await api()
      .patch("/api/v1/settings/rentals")
      .set(owner())
      .send({ inspectionPhotoViews: [] });
    expect(rentals.status, JSON.stringify(rentals.body)).toBe(200);
    const items = (rentals.body.data.inspectionItems as { key: string }[]).map((i) => ({
      key: i.key,
      ok: true,
    }));
    const customer = await api()
      .post("/api/v1/customers")
      .set(owner())
      .send({
        type: "individual",
        firstName: "Esi",
        lastName: randomUUID().slice(0, 6),
        phone: `+23324${digits(7)}`,
        dateOfBirth: "1990-01-01",
        licenceNumber: "DL-1234",
        licenceClass: "B",
        licenceExpiresOn: "2030-01-01",
      });
    expect(customer.status, JSON.stringify(customer.body)).toBe(201);
    const now = Date.now();
    const booked = await api()
      .post("/api/v1/rentals")
      .set(owner())
      .send({
        classId,
        vehicleId: cars[0],
        customerId: customer.body.data.id,
        pickupAt: iso(now + HOUR),
        returnAt: iso(now + 25 * HOUR),
        confirm: true,
      });
    expect(booked.status, JSON.stringify(booked.body)).toBe(201);
    const bookingId = booked.body.data.id as string;
    const [first, second] = (
      cars[0] === booked.body.data.vehicleId ? cars : [cars[1], cars[0]]
    ) as [string, string];

    // --- a work order on the booked car, off the road: the booking moves ---
    const job = await open({
      vehicleId: first,
      type: "corrective",
      title: "Gearbox noise",
      vendorId: workshop,
      offRoad: true,
      expectedBackAt: iso(now + 48 * HOUR),
      lines: [
        { kind: "labour", description: "Strip and inspect", quantity: 2.5, unitCost: "80.00" },
        {
          kind: "part",
          description: "Bearing kit",
          quantity: 2,
          unitCost: "125.50",
          partRef: "BK-7",
        },
      ],
    });
    expect(job).toMatchObject({
      number: expect.stringMatching(/^WO-\d{4}-\d{6}$/),
      status: "open",
      offRoad: true,
      total: { amountMinor: 45_100 },
      byKind: { labour: { amountMinor: 20_000 }, part: { amountMinor: 25_100 } },
    });
    expect(job.blockId).not.toBeNull();
    expect(await status(first)).toBe("in_maintenance");
    const moved = await api().get(`/api/v1/rentals/${bookingId}`).set(owner());
    expect(moved.body.data.vehicle.id).toBe(second);
    // One off-road work order at a time; nobody takes the block away by hand.
    const twice = await act(job.id, "off-road");
    expect([twice.status, twice.body.error.message]).toEqual([
      422,
      "The vehicle is already off the road",
    ]);
    const freed = await api().delete(`/api/v1/vehicle-blocks/${job.blockId}`).set(owner());
    expect(freed.status).not.toBe(200);

    // --- the job moves along and is re-costed ---
    expect((await act(job.id, "start")).body.data.status).toBe("in_progress");
    expect((await act(job.id, "awaiting-parts")).body.data.status).toBe("awaiting_parts");
    const relined = await api()
      .put(`/api/v1/work-orders/${job.id}/lines`)
      .set(owner())
      .send({
        lines: [
          { kind: "labour", description: "Rebuild", quantity: 3, unitCost: "80.00" },
          { kind: "part", description: "Bearing kit", quantity: 2, unitCost: "125.50" },
        ],
      });
    expect(relined.body.data.total).toMatchObject({ amountMinor: 49_100 });
    const resumed = await act(job.id, "start");
    expect(resumed.body.data.status).toBe("in_progress");

    // --- completed: the vendor's expense, the vehicle back on the road ---
    const rated = await act(job.id, "complete", {
      vendorInvoiceRef: "AOM-881",
      vendorRating: 4,
      allocations: [{ payer: "customer", amount: "491.00" }],
    });
    expect([rated.status, rated.body.error?.message]).toEqual([
      422,
      "Only the repair of a damage from a rental is charged to the renter",
    ]);
    const done = await act(job.id, "complete", { vendorInvoiceRef: "AOM-881", vendorRating: 4 });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    const order = done.body.data as Order;
    expect(order).toMatchObject({ status: "completed" });
    expect(order.allocations).toEqual([
      expect.objectContaining({
        payer: "company",
        amount: expect.objectContaining({ amountMinor: 49_100 }),
      }),
    ]);
    expect(order.downtimeHours).not.toBeNull();
    expect(await expense(order.expenseId!)).toMatchObject({
      amount_minor: 49_100,
      charge_to_driver: false,
      payee_id: workshop,
      source_type: "work_order",
    });
    expect(await status(first)).toBe("available");

    // --- the renter brings the other car back damaged ---
    const out = await api()
      .post(`/api/v1/rentals/${bookingId}/checkout`)
      .set(owner())
      .send({ odometer: 1_000, fuel: "full", idChecked: true, checklist: items, photos: [] });
    expect(out.status, JSON.stringify(out.body)).toBe(200);
    // On rental: no work order takes it off the road.
    const onRent = await open({ vehicleId: second, type: "inspection", title: "Check" });
    const refused = await act(onRent.id, "off-road");
    expect(refused.body.error.message).toMatch(/out on rental: check it in first/);
    await act(onRent.id, "cancel", { reason: "Opened too early" }).expect(200);
    const back = await api()
      .post(`/api/v1/rentals/${bookingId}/checkin`)
      .set(owner())
      .send({
        odometer: 1_080,
        fuel: "full",
        checklist: items,
        photos: [],
        damages: [
          {
            area: "left",
            severity: "minor",
            description: "Scraped door",
            estimate: "300.00",
            chargeCustomer: true,
          },
        ],
      });
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    const damages = await api().get(`/api/v1/vehicle-damages?bookingId=${bookingId}`).set(owner());
    const damageId = (damages.body.data as { id: string }[])[0]!.id;

    const repair = await open({
      vehicleId: second,
      type: "accident",
      title: "Door respray",
      damageId,
      vendorId: workshop,
      lines: [
        { kind: "sublet", description: "Panel beating and spray", quantity: 1, unitCost: "350.00" },
      ],
    });
    const part = await act(repair.id, "complete", {
      allocations: [{ payer: "customer", amount: "100.00" }],
    });
    expect(part.body.error.message).toBe("The renter pays all of the repair or none of it");
    const repaired = await act(repair.id, "complete", {
      allocations: [{ payer: "customer", amount: "350.00" }],
      vendorRating: 2,
    });
    expect(repaired.status, JSON.stringify(repaired.body)).toBe(200);
    expect((repaired.body.data as Order).allocations).toEqual([
      expect.objectContaining({
        payer: "company",
        amount: expect.objectContaining({ amountMinor: 0 }),
      }),
      expect.objectContaining({
        payer: "customer",
        customerId: customer.body.data.id,
        amount: expect.objectContaining({ amountMinor: 35_000 }),
      }),
    ]);
    const damage = await api().get(`/api/v1/vehicle-damages/${damageId}`).set(owner());
    expect(damage.body.data).toMatchObject({
      status: "repaired",
      liability: "customer",
      workOrderRef: (repaired.body.data as Order).number,
    });
    const rental = await api().get(`/api/v1/rentals/${bookingId}`).set(owner());
    expect(
      (rental.body.data.charges as { kind: string; total: Money }[])
        .filter((c) => c.kind === "damage")
        .map((c) => c.total.amountMinor),
    ).toEqual([30_000, 5_000]); // the estimate, then up to the final cost

    // --- the vendor's record ---
    const record = await api().get(`/api/v1/suppliers/${workshop}/work-orders`).set(owner());
    expect(record.status, JSON.stringify(record.body)).toBe(200);
    expect(record.body.data.record).toMatchObject({
      workOrders: 2,
      open: 0,
      completed: 2,
      spent: { amountMinor: 84_100 },
      averageRating: 3,
      ratings: 2,
    });
    expect(record.body.data.recent).toHaveLength(2);
  });

  it("closes service tasks, resolves the issue and charges the driver's share", async () => {
    const car = await vehicle("Toyota", "Corolla", 10_000);
    const plan = await api()
      .post("/api/v1/service-plans")
      .set(owner())
      .send({
        name: "Corolla taxi",
        appliesTo: "vehicle",
        vehicleId: car,
        tasks: [{ name: "Oil", everyKm: 3_000 }],
      });
    expect(plan.status, JSON.stringify(plan.body)).toBe(201);
    const assigned = await api()
      .post(`/api/v1/vehicles/${car}/assignment`)
      .set(owner())
      .send({
        driverId,
        odometer: 10_000,
        checklist,
        terms: { mode: "fixed_target", target: "250.00", frequency: "daily" },
      });
    expect(assigned.status, JSON.stringify(assigned.body)).toBe(201);
    await api()
      .post(`/api/v1/vehicles/${car}/odometer`)
      .set(owner())
      .send({ value: 12_600 })
      .expect(201);

    // --- preventive: the oil coming up is on the order ---
    const service = await open({ vehicleId: car, type: "preventive", title: "Oil change" });
    expect(service.serviceTaskIds).toHaveLength(1);
    await act(service.id, "start").expect(200);
    const serviced = await act(service.id, "complete", { odometer: 12_650 });
    expect(serviced.status, JSON.stringify(serviced.body)).toBe(200);
    // Nothing to cost: nothing posted.
    expect(serviced.body.data.expenseId).toBeNull();
    const schedule = await api().get(`/api/v1/vehicles/${car}/service-schedule`).set(owner());
    expect(schedule.body.data.due[0]).toMatchObject({ status: "scheduled", dueKm: 15_650 });
    expect(schedule.body.data.history).toEqual([
      expect.objectContaining({ taskName: "Oil", workOrderRef: serviced.body.data.number }),
    ]);

    // --- an issue the driver reported, fixed in-house with the driver paying part ---
    const issue = await api()
      .post(`/api/v1/vehicles/${car}/issues`)
      .set(owner())
      .send({ type: "damage", description: "Side mirror broken" });
    expect(issue.status, JSON.stringify(issue.body)).toBe(201);
    const fix = await open({
      vehicleId: car,
      type: "corrective",
      title: "Replace mirror",
      issueId: issue.body.data.id,
      offRoad: true,
      lines: [
        { kind: "labour", description: "Fit mirror", quantity: 1, unitCost: "100.00" },
        { kind: "part", description: "Mirror", quantity: 1, unitCost: "200.00" },
      ],
    });
    // An assigned car keeps its status while off the road.
    expect(await status(car)).toBe("assigned");
    const rating = await act(fix.id, "complete", { vendorRating: 5 });
    expect(rating.body.error.message).toBe("Only an outside vendor is rated");
    const fixed = await act(fix.id, "complete", {
      allocations: [{ payer: "driver", amount: "150.00" }],
    });
    expect(fixed.status, JSON.stringify(fixed.body)).toBe(200);
    const order = fixed.body.data as Order;
    expect(order.allocations).toEqual([
      expect.objectContaining({
        payer: "company",
        amount: expect.objectContaining({ amountMinor: 15_000 }),
      }),
      expect.objectContaining({ payer: "driver", driverId }),
    ]);
    // In-house labour is wages already paid: the business posts only its share of the part.
    expect(await expense(order.expenseId!)).toMatchObject({
      amount_minor: 5_000,
      payee_name: "In-house workshop",
      charge_to_driver: false,
    });
    expect(await expense(order.driverExpenseId!)).toMatchObject({
      amount_minor: 15_000,
      charge_to_driver: true,
      driver_id: driverId,
    });
    const resolved = await api().get(`/api/v1/vehicle-issues/${issue.body.data.id}`).set(owner());
    expect(resolved.body.data).toMatchObject({ status: "resolved" });
    expect(await status(car)).toBe("assigned");
    const list = await api().get(`/api/v1/work-orders?vehicleId=${car}`).set(owner());
    expect((list.body.data as Order[]).map((o) => o.status)).toEqual(["completed", "completed"]);
    expect(
      (await api().get(`/api/v1/work-orders?vehicleId=${car}&open=true`).set(owner())).body.data,
    ).toEqual([]);
  });

  it("starts and ends Work & Pay downtime with the job, and cancels", async () => {
    await api()
      .patch("/api/v1/settings/workpay")
      .set(owner())
      .send({ driverExpenses: "agreement" })
      .expect(200);
    const { id: wpDriver, token } = await driver("workpay");
    const car = await vehicle("Toyota", "Vitz");
    const draft = await api()
      .post("/api/v1/workpay/agreements")
      .set(owner())
      .send({
        vehicleId: car,
        driverId: wpDriver,
        terms: {
          vehicleValue: "10000.00",
          pricing: { kind: "total", total: "12000.00" },
          deposit: "2000.00",
          frequency: "weekly",
          periods: 20,
          firstDueOn: new Date(Date.now() + 7 * 24 * HOUR).toISOString().slice(0, 10),
          roundTo: "1.00",
        },
        maintenance: "owner",
        insurance: "driver",
      });
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    const agreement = draft.body.data.id as string;
    const sent = await api()
      .post(`/api/v1/workpay/agreements/${agreement}/send-for-signature`)
      .set(owner())
      .send({});
    const documentId = sent.body.data.document.id as string;
    for (const as of [owner(), { Authorization: `Bearer ${token}` }]) {
      const tasks = (await api().get("/api/v1/me/signatures").set(as)).body.data as {
        signer: { id: string };
        document: { id: string };
      }[];
      const task = tasks.find((x) => x.document.id === documentId)!;
      await api()
        .post(`/api/v1/me/signatures/${task.signer.id}/sign`)
        .set(as)
        .send({ signature: { type: "drawn", png: signaturePng() }, consent: true })
        .expect(200);
    }
    await api()
      .post(`/api/v1/workpay/agreements/${agreement}/deposit`)
      .set(owner())
      .send({ amount: "2000.00", method: "momo", momoNetwork: "mtn", reference: `WP-${digits(6)}` })
      .expect(200);
    const active = await api()
      .post(`/api/v1/workpay/agreements/${agreement}/activate`)
      .set(owner())
      .send({ odometer: 1_100, checklist });
    expect(active.status, JSON.stringify(active.body)).toBe(200);

    const job = await open({
      vehicleId: car,
      type: "accident",
      title: "Front bumper",
      vendorId: workshop,
    });
    const off = await act(job.id, "off-road", { expectedBackAt: iso(Date.now() + 72 * HOUR) });
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    expect(off.body.data).toMatchObject({ offRoad: true, workpayAgreementId: agreement });
    expect(await status(car)).toBe("in_maintenance");
    const downtime = await api()
      .get(`/api/v1/workpay/agreements/${agreement}/downtime`)
      .set(owner());
    expect(downtime.body.data).toEqual([
      expect.objectContaining({
        ownerFault: true,
        endedOn: null,
        reason: expect.stringContaining(job.number),
      }),
    ]);
    const later = await api()
      .patch(`/api/v1/work-orders/${job.id}`)
      .set(owner())
      .send({ expectedBackAt: iso(Date.now() + 96 * HOUR), priority: "high" });
    expect(later.body.data).toMatchObject({ priority: "high" });

    const cancelled = await act(job.id, "cancel", { reason: "Insurer's own garage takes it" });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(cancelled.body.data).toMatchObject({ status: "cancelled", expenseId: null });
    expect(await status(car)).toBe("on_workpay");
    const ended = await api().get(`/api/v1/workpay/agreements/${agreement}/downtime`).set(owner());
    expect((ended.body.data as { endedOn: string | null }[])[0]!.endedOn).not.toBeNull();
    const again = await act(job.id, "start");
    expect(again.body.error.message).toBe("The work order is cancelled: it cannot change");
  });
});
