import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { Container } from "inversify";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IJobHandler } from "../../application/jobs/IJobHandler.js";
import type { ISmsGateway } from "../../application/ports/INotifications.js";
import type { ServiceSchedule } from "../../application/use-cases/maintenance/ServiceSchedule.js";
import {
  ProvisionedTenants,
  type ProvisionedTenant,
} from "../../testing/fixtures/ProvisionedTenants.js";
import { StaffFixtures } from "../../testing/fixtures/StaffFixtures.js";
import { createTestContainer } from "../../testing/testContainer.js";
import { disposeContainer } from "../dependency-injection/container.js";
import { TYPES } from "../dependency-injection/types.js";

/**
 * Service plans and the due engine (P6-1) end to end: a plan from a template for the fleet, a
 * more specific plan for one model, odometer readings moving a task through upcoming, due and
 * overdue with the alerts to the staff and the assigned driver, a service recorded, the nightly
 * run catching the date, and a rental warned of a service falling due.
 */
class FakeSms implements ISmsGateway {
  readonly provider = "arkesel" as const;
  readonly sent: { to: string; text: string }[] = [];
  send(_account: Parameters<ISmsGateway["send"]>[0], to: string, text: string) {
    this.sent.push({ to, text });
    return Promise.resolve({ messageId: `s-${this.sent.length}` });
  }
}

let container: Container;
let app: Express;
let t: ProvisionedTenant;
const sms = new FakeSms();
let corolla: string;
let almera: string;
let driverPhone: string;

type Due = {
  id: string;
  status: string;
  vehicle: { id: string };
  task: { id: string; name: string };
  dueKm: number | null;
  dueOn: string | null;
  kmLeft: number | null;
};
type Schedule = { plan: { name: string } | null; due: Due[]; history: { taskName: string }[] };

const api = () => request(app);
const owner = () => ({ Authorization: `Bearer ${t.ownerAccessToken}` });
const digits = (n: number) => String(Math.floor(Math.random() * 10 ** n)).padStart(n, "0");
const HOUR = 3_600_000;

async function vehicle(make: string, model: string, odometer: number): Promise<string> {
  const res = await api()
    .post("/api/v1/vehicles")
    .set(owner())
    .send({ make, model, plateNumber: `GR ${digits(4)}-26`, odometer });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data.id as string;
}

const read = (id: string, value: number) =>
  api().post(`/api/v1/vehicles/${id}/odometer`).set(owner()).send({ value }).expect(201);

async function schedule(id: string): Promise<Schedule> {
  const res = await api().get(`/api/v1/vehicles/${id}/service-schedule`).set(owner());
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data as Schedule;
}

/** Sends queued SMS and returns what went to `phone`. */
async function smsTo(phone: string): Promise<string[]> {
  const before = sms.sent.length;
  const send = container
    .get<IJobHandler[]>(TYPES.NotificationJobHandlers)
    .find((h) => h.job === "notifications.send")!;
  await t.tenant.run(() => send.handle({ tenantId: t.tenantId }, { jobId: "j", attempt: 1 }));
  return sms.sent
    .slice(before)
    .filter((m) => m.to === phone)
    .map((m) => m.text);
}

async function inbox(): Promise<string[]> {
  const res = await api().get("/api/v1/notifications?limit=100").set(owner());
  return (res.body.data as { title: string }[]).map((n) => n.title);
}

beforeAll(async () => {
  container = await createTestContainer({ AUTH_RATE_LIMIT_MAX: "10000", RATE_LIMIT_MAX: "100000" });
  container.rebind<ISmsGateway[]>(TYPES.SmsGateways).toConstantValue([sms]);
  app = container.get<Express>(TYPES.HttpApp);
  const staff = await new StaffFixtures(container).create(["super_admin"]);
  t = await new ProvisionedTenants(container, app, staff).create();
  await api()
    .put("/api/v1/settings/notifications/sms")
    .set(owner())
    .send({ provider: "arkesel", senderId: "AutoFleet", credentials: { apiKey: "k" } })
    .expect(200);
  await api().patch("/api/v1/settings/notifications").set(owner()).send({ quietHours: null });

  driverPhone = `+23324${digits(7)}`;
  const driver = await api()
    .post("/api/v1/drivers")
    .set(owner())
    .send({
      firstName: "Kwame",
      lastName: "Mensah",
      phone: driverPhone,
      ghanaCardNumber: `GHA-${digits(9)}-1`,
      licenceNumber: `DL-${randomUUID().slice(0, 6)}`,
      licenceClass: "B",
      licenceExpiresOn: "2030-01-01",
    });
  expect(driver.status, JSON.stringify(driver.body)).toBe(201);
  const driverId = driver.body.data.id as string;
  await api()
    .post(`/api/v1/drivers/${driverId}/guarantors`)
    .set(owner())
    .send({ name: "Yaw", phone: `+23320${digits(7)}` });
  await api().post(`/api/v1/drivers/${driverId}/activate`).set(owner()).send({}).expect(200);

  corolla = await vehicle("Toyota", "Corolla", 10_000);
  almera = await vehicle("Nissan", "Almera", 2_000);
  const settings = await api().get("/api/v1/settings/assignments").set(owner());
  const checklist = {
    items: (settings.body.data.handoverItems as { key: string }[]).map((i) => ({
      key: i.key,
      ok: true,
    })),
  };
  const assigned = await api()
    .post(`/api/v1/vehicles/${corolla}/assignment`)
    .set(owner())
    .send({
      driverId,
      odometer: 10_000,
      checklist,
      terms: { mode: "fixed_target", target: "250.00", frequency: "daily" },
    });
  expect(assigned.status, JSON.stringify(assigned.body)).toBe(201);
});

afterAll(async () => {
  await disposeContainer(container);
});

describe("service plans and the due engine", () => {
  it("schedules from plans, alerts on readings, records services and runs nightly", async () => {
    const templates = await api().get("/api/v1/service-plan-templates").set(owner());
    expect((templates.body.data as { key: string }[]).map((x) => x.key)).toEqual([
      "standard",
      "heavy_use",
    ]);

    // --- the fleet on the standard template ---
    const standard = await api()
      .post("/api/v1/service-plans")
      .set(owner())
      .send({ appliesTo: "all", template: "standard" });
    expect(standard.status, JSON.stringify(standard.body)).toBe(201);
    expect(standard.body.data).toMatchObject({ name: "Standard service", template: "standard" });
    let s = await schedule(almera);
    expect(s.plan?.name).toBe("Standard service");
    expect(s.due).toHaveLength(6);
    const oil = s.due.find((d) => d.task.name === "Engine oil and filter")!;
    expect(oil).toMatchObject({ status: "scheduled", dueKm: 7_000, kmLeft: 5_000 });
    expect(oil.dueOn).not.toBeNull();
    // Nothing pressing yet.
    expect((await api().get("/api/v1/service-due").set(owner())).body.data).toEqual([]);

    // --- a plan for the Corolla model takes over from the fleet plan ---
    const refused = await api()
      .post("/api/v1/service-plans")
      .set(owner())
      .send({ name: "Corolla", appliesTo: "make_model", tasks: [{ name: "Oil", everyKm: 3_000 }] });
    expect(refused.status).toBe(422);
    const mine = await api()
      .post("/api/v1/service-plans")
      .set(owner())
      .send({
        name: "Corolla taxi",
        appliesTo: "make_model",
        make: "toyota",
        model: "Corolla",
        tasks: [{ name: "Oil", everyKm: 3_000, everyDays: 60 }],
      });
    expect(mine.status, JSON.stringify(mine.body)).toBe(201);
    s = await schedule(corolla);
    expect(s.plan?.name).toBe("Corolla taxi");
    expect(s.due).toEqual([
      expect.objectContaining({
        status: "scheduled",
        dueKm: 13_000,
        task: expect.objectContaining({ name: "Oil" }),
      }),
    ]);
    const taskId = s.due[0]!.task.id;

    // --- readings: upcoming (staff only), due and overdue (the driver too) ---
    await read(corolla, 12_500);
    expect((await schedule(corolla)).due[0]!.status).toBe("upcoming");
    expect(await smsTo(driverPhone)).toEqual([]);
    expect((await inbox()).filter((x) => x.endsWith("Oil coming up"))).toHaveLength(1);

    await read(corolla, 13_100);
    expect((await schedule(corolla)).due[0]!.status).toBe("due");
    expect(await smsTo(driverPhone)).toEqual([
      expect.stringMatching(
        /Kwame Mensah, .* is due for Oil \(at 13,000 km or on \d{4}-\d{2}-\d{2}\)/,
      ),
    ]);
    await read(corolla, 13_200);
    expect(await smsTo(driverPhone)).toEqual([]); // once per status

    await read(corolla, 13_600);
    const due = await api().get("/api/v1/service-due").set(owner());
    expect(due.status, JSON.stringify(due.body)).toBe(200);
    expect((due.body.data as Due[])[0]).toMatchObject({
      status: "overdue",
      vehicle: { id: corolla },
      kmLeft: -600,
    });
    expect(await smsTo(driverPhone)).toHaveLength(1);
    expect((await inbox()).filter((x) => x.endsWith("Oil overdue"))).toHaveLength(1);

    // --- the service done: counted again from it ---
    const ahead = await api()
      .post(`/api/v1/vehicles/${corolla}/services`)
      .set(owner())
      .send({ taskId, doneOn: new Date(Date.now() + 48 * HOUR).toISOString().slice(0, 10) });
    expect(ahead.status).toBe(422);
    const over = await api()
      .post(`/api/v1/vehicles/${corolla}/services`)
      .set(owner())
      .send({ taskId, odometer: 20_000 });
    expect(over.status).toBe(422);
    const done = await api()
      .post(`/api/v1/vehicles/${corolla}/services`)
      .set(owner())
      .send({ taskId, note: "Synthetic oil", workOrderRef: "JC-114" });
    expect(done.status, JSON.stringify(done.body)).toBe(201);
    expect(done.body.data.record).toMatchObject({ odometer: 13_600, workOrderRef: "JC-114" });
    s = done.body.data.schedule as Schedule;
    expect(s.due[0]).toMatchObject({ status: "scheduled", dueKm: 16_600 });
    expect(s.history).toEqual([expect.objectContaining({ taskName: "Oil" })]);
    expect(
      (await api().get(`/api/v1/service-due?vehicleId=${corolla}`).set(owner())).body.data,
    ).toEqual([]);

    // --- nightly: the date catches up without a reading ---
    const engine = container.get<ServiceSchedule>(TYPES.ServiceSchedule);
    const later = new Date(Date.now() + 61 * 24 * HOUR).toISOString().slice(0, 10);
    await t.tenant.run(() => engine.run(later));
    expect((await schedule(corolla)).due[0]!.status).toBe("due");
    await t.tenant.run(() => engine.run(new Date().toISOString().slice(0, 10)));

    // --- a rental crossing a due service is warned ---
    await read(almera, 7_050);
    const suv = await api()
      .post("/api/v1/vehicle-classes")
      .set(owner())
      .send({ code: "ECO", name: "Economy" });
    await api()
      .put(`/api/v1/vehicles/${almera}/rental-class`)
      .set(owner())
      .send({ classId: suv.body.data.id })
      .expect(200);
    await api()
      .post("/api/v1/rental-rate-plans")
      .set(owner())
      .send({ code: "ECO", name: "Economy", classId: suv.body.data.id, dailyRate: "200.00" })
      .expect(201);
    const customer = await api()
      .post("/api/v1/customers")
      .set(owner())
      .send({
        type: "individual",
        firstName: "Esi",
        lastName: "Asante",
        phone: `+23324${digits(7)}`,
        dateOfBirth: "1990-01-01",
        ghanaCardNumber: `GHA-${digits(9)}-0`,
        licenceNumber: "DL-1234",
        licenceClass: "B",
        licenceExpiresOn: "2030-01-01",
      });
    expect(customer.status, JSON.stringify(customer.body)).toBe(201);
    const booked = await api()
      .post("/api/v1/rentals")
      .set(owner())
      .send({
        vehicleId: almera,
        customerId: customer.body.data.id,
        pickupAt: new Date(Date.now() + 2 * HOUR).toISOString(),
        returnAt: new Date(Date.now() + 26 * HOUR).toISOString(),
      });
    expect(booked.status, JSON.stringify(booked.body)).toBe(201);
    expect(booked.body.data.warnings).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/Engine oil and filter falls due .*before the return/),
      ]),
    );

    // --- the model plan switched off: the Corolla is back on the fleet plan ---
    await api()
      .patch(`/api/v1/service-plans/${mine.body.data.id}`)
      .set(owner())
      .send({ active: false })
      .expect(200);
    s = await schedule(corolla);
    expect(s.plan?.name).toBe("Standard service");
    expect(s.due).toHaveLength(6);
    expect(s.history).toHaveLength(1);
  });
});
