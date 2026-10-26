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
 * Inspections and damages (P5-4) end to end: photos uploaded to the booking, the check-out
 * inspection (ID seen, checklist, every side photographed, damage already there), the check-in
 * inspection with a new damage, refuelling, cleaning and the damage estimate charged, the
 * differences, then the damage settled (final cost, insurance) and repaired.
 */
let container: Container;
let app: Express;
let platform: pg.Pool;
let t: ProvisionedTenant;
let hq: string;
let agent: string;
let suv: string;
let car: string;
let renter: string;

type Charge = { kind: string; total: { amountMinor: number } };
type Damage = {
  id: string;
  status: string;
  liability: string;
  foundAt: string | null;
  estimate: { amountMinor: number } | null;
};

const api = () => request(app);
const as = (token: string) => ({ Authorization: `Bearer ${token}` });
const owner = () => as(t.ownerAccessToken);
const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const SIDES = ["front", "back", "left", "right", "interior"] as const;
const ITEMS = [
  "spare_tyre",
  "jack_and_spanner",
  "warning_triangle",
  "fire_extinguisher",
  "vehicle_documents",
  "lights_and_tyres",
  "air_conditioning",
  "clean",
];
const checklist = (notOk: readonly string[] = []) =>
  ITEMS.map((key) => ({ key, ok: !notOk.includes(key) }));

const png = (size = 64) => {
  const bytes = Buffer.alloc(size, 7);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  return bytes;
};

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

/** Uploads a photo to the booking (or a damage) and confirms it; returns the file id. */
async function photo(path: string, token = agent): Promise<string> {
  const started = await api()
    .post(`${path}/photos`)
    .set(as(token))
    .send({ filename: "side.png", contentType: "image/png", sizeBytes: png().length });
  expect(started.status, JSON.stringify(started.body)).toBe(201);
  const { method, url, headers } = started.body.data.upload;
  await fetch(url, { method, headers, body: png() });
  const fileId = started.body.data.file.id as string;
  const done = await api().post(`${path}/photos/${fileId}/complete`).set(as(token));
  expect(done.status, JSON.stringify(done.body)).toBe(200);
  return fileId;
}

const allSides = async (bookingId: string) => {
  const photos = [];
  for (const view of SIDES)
    photos.push({ fileId: await photo(`/api/v1/rentals/${bookingId}`), view });
  return photos;
};

const step = (id: string, path: string, body: Record<string, unknown> = {}, token = agent) =>
  api().post(`/api/v1/rentals/${id}/${path}`).set(as(token)).send(body);

const charges = (res: request.Response) =>
  (res.body.data.charges as Charge[]).map((c) => [c.kind, c.total.amountMinor]);

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
    .send({ code: "SUV", name: "SUV", refuelPerQuarter: "50.00" });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  expect(created.body.data.refuelQuarterMinor).toBe(5_000);
  suv = created.body.data.id as string;
  const registered = await api()
    .post("/api/v1/vehicles")
    .set(owner())
    .send({ make: "Toyota", model: "RAV4", plateNumber: `GR ${randomUUID().slice(0, 4)}-27` });
  car = registered.body.data.id as string;
  await api()
    .put(`/api/v1/vehicles/${car}/rental-class`)
    .set(owner())
    .send({ classId: suv })
    .expect(200);
  await api()
    .post("/api/v1/rental-rate-plans")
    .set(owner())
    .send({
      code: "SUV-STD",
      name: "SUV standard",
      classId: suv,
      dailyRate: "300.00",
      includedKmPerDay: 100,
      extraKmRate: "2.00",
    })
    .expect(201);
  const settings = await api()
    .patch("/api/v1/settings/rentals")
    .set(owner())
    .send({ cleaningFee: "80.00" });
  expect(settings.body.data).toMatchObject({
    cleaningFee: "80.00",
    inspectionPhotoViews: [...SIDES],
    inspectionItems: expect.arrayContaining([{ key: "clean", label: "Clean inside and out" }]),
  });
  const customer = await api()
    .post("/api/v1/customers")
    .set(owner())
    .send({
      type: "individual",
      firstName: "Kofi",
      lastName: randomUUID().slice(0, 6),
      email: `renter-${randomUUID().slice(0, 8)}@example.com`,
      dateOfBirth: "1990-04-01",
      licenceNumber: "DL-55555",
      licenceClass: "B",
      licenceExpiresOn: "2030-01-01",
    });
  renter = customer.body.data.id as string;
});

afterAll(async () => {
  await disposeContainer(container);
});

describe("inspections and damages", () => {
  it("inspects at check-out and check-in, charges the return and settles the damage", async () => {
    const now = Date.now();
    const booked = await api()
      .post("/api/v1/rentals")
      .set(as(agent))
      .send({
        classId: suv,
        customerId: renter,
        pickupAt: iso(now + HOUR),
        returnAt: iso(now + 25 * HOUR),
        confirm: true,
      });
    expect(booked.status, JSON.stringify(booked.body)).toBe(201);
    const id = booked.body.data.id as string;

    // --- check-out ---
    const outPhotos = await allSides(id);
    const scratchPhoto = await photo(`/api/v1/rentals/${id}`);
    const out = {
      odometer: 8_000,
      fuel: "full",
      idChecked: true,
      checklist: checklist(),
      photos: outPhotos,
      damages: [
        {
          area: "front",
          severity: "minor",
          description: "Scratch on the bumper",
          photoIds: [scratchPhoto],
        },
      ],
    };
    const refusals: [Record<string, unknown>, string][] = [
      [{ idChecked: false }, "Check the renter's ID and driving licence"],
      [{ checklist: checklist().slice(1) }, "missing: Spare tyre"],
      [{ photos: outPhotos.slice(0, 4) }, "Photograph the interior of the vehicle"],
      [
        { photos: [...outPhotos.slice(0, 4), { fileId: randomUUID(), view: "interior" }] },
        "finished upload of this booking",
      ],
    ];
    for (const [change, message] of refusals) {
      const refused = await step(id, "checkout", { ...out, ...change });
      expect([refused.status, refused.body.error.message]).toEqual([
        422,
        expect.stringContaining(message),
      ]);
    }
    const checkedOut = await step(id, "checkout", out);
    expect(checkedOut.status, JSON.stringify(checkedOut.body)).toBe(200);

    // --- check-in ---
    const reused = await step(id, "checkin", {
      odometer: 8_050,
      fuel: "quarter",
      checklist: checklist(),
      photos: outPhotos,
    });
    expect([reused.status, reused.body.error.message]).toEqual([
      422,
      "A photo is already part of an inspection or a damage",
    ]);
    const inPhotos = await allSides(id);
    const dentPhoto = await photo(`/api/v1/rentals/${id}`);
    const back = {
      odometer: 8_050,
      fuel: "quarter",
      checklist: checklist(["clean"]),
      photos: inPhotos,
      needsCleaning: true,
      damages: [
        {
          area: "left",
          severity: "major",
          description: "Rear door pushed in",
          photoIds: [dentPhoto],
          estimate: "850.00",
          chargeCustomer: true,
        },
      ],
    };
    const noOverride = await step(id, "checkin", { ...back, waiveRefuel: true });
    expect(noOverride.status).toBe(403);
    const returned = await step(id, "checkin", back);
    expect(returned.status, JSON.stringify(returned.body)).toBe(200);
    // One day at ₵300; three quarter tanks at ₵50; cleaning ₵80; the damage estimate ₵850.
    expect(charges(returned)).toEqual([
      ["rental", 30_000],
      ["fuel_refill", 15_000],
      ["cleaning", 8_000],
      ["damage", 85_000],
    ]);
    // A major damage sends the vehicle to maintenance.
    expect((await api().get(`/api/v1/vehicles/${car}`).set(owner())).body.data.status).toBe(
      "in_maintenance",
    );

    const inspections = await api().get(`/api/v1/rentals/${id}/inspections`).set(as(agent));
    expect(inspections.status, JSON.stringify(inspections.body)).toBe(200);
    const view = inspections.body.data;
    expect(view.checkOut).toMatchObject({ stage: "check_out", odometer: 8_000, idChecked: true });
    expect(view.checkIn).toMatchObject({ stage: "check_in", odometer: 8_050, fuel: "quarter" });
    expect(view.differences).toMatchObject({
      km: 50,
      fuel: { out: "full", in: "quarter", quartersMissing: 3 },
      checklist: [{ key: "clean" }],
    });
    expect(view.differences.photos).toHaveLength(5);
    expect(view.photos).toHaveLength(12);
    const found = view.damages as Damage[];
    expect(found.map((d) => [d.foundAt, d.liability]).sort()).toEqual([
      ["check_in", "customer"],
      ["check_out", "business"],
    ]);
    expect(view.openDamages).toHaveLength(2);
    const dent = found.find((d) => d.foundAt === "check_in")!;

    // --- settling the damage ---
    const byAgent = await api()
      .patch(`/api/v1/vehicle-damages/${dent.id}`)
      .set(as(agent))
      .send({ finalCost: "700.00" });
    expect(byAgent.status).toBe(403);
    const final = await api()
      .patch(`/api/v1/vehicle-damages/${dent.id}`)
      .set(owner())
      .send({ finalCost: "700.00", workOrderRef: "GARAGE-881" });
    expect(final.status, JSON.stringify(final.body)).toBe(200);
    expect(final.body.data).toMatchObject({
      finalCost: expect.objectContaining({ amountMinor: 70_000 }),
      workOrderRef: "GARAGE-881",
    });
    await api()
      .patch(`/api/v1/vehicle-damages/${dent.id}`)
      .set(owner())
      .send({ liability: "insurance", claimRef: "CLM-2027-14" })
      .expect(200);
    const booking = await api().get(`/api/v1/rentals/${id}`).set(as(agent));
    expect(charges(booking).slice(3)).toEqual([
      ["damage", 85_000],
      ["damage", -15_000],
      ["damage", -70_000],
    ]);
    expect(booking.body.data.charged.amountMinor).toBe(53_000);
    expect(
      (booking.body.data.events as { type: string }[]).filter((e) => e.type === "damage_charged"),
    ).toHaveLength(2);

    const repaired = await api()
      .post(`/api/v1/vehicle-damages/${dent.id}/repaired`)
      .set(owner())
      .send({});
    expect(repaired.body.data.status).toBe("repaired");
    const again = await api()
      .post(`/api/v1/vehicle-damages/${dent.id}/repaired`)
      .set(owner())
      .send({});
    expect([again.status, again.body.error.message]).toEqual([
      422,
      "The damage is repaired already",
    ]);
    const map = await api()
      .get("/api/v1/vehicle-damages")
      .query({ vehicleId: car, status: "open" })
      .set(as(agent));
    expect((map.body.data as Damage[]).map((d) => d.foundAt)).toEqual(["check_out"]);
    const detail = await api().get(`/api/v1/vehicle-damages/${dent.id}`).set(as(agent));
    expect(detail.body.data.photos).toEqual([expect.objectContaining({ id: dentPhoto })]);

    const audit = await t.tenant.query<{ action: string }>(
      "select action from audit_logs where entity_type = 'vehicle_damage' and entity_id = $1 order by occurred_at",
      [dent.id],
    );
    expect(audit.map((r) => r.action)).toEqual([
      "vehicle_damage.settled",
      "vehicle_damage.settled",
      "vehicle_damage.repaired",
    ]);

    // The booking is done: no more inspection photos.
    const late = await api()
      .post(`/api/v1/rentals/${id}/photos`)
      .set(as(agent))
      .send({ filename: "x.png", contentType: "image/png", sizeBytes: 64 });
    expect(late.status).toBe(422);
  });

  it("records damages outside rentals, never charged to a renter", async () => {
    const byAgent = await api()
      .post("/api/v1/vehicle-damages")
      .set(as(agent))
      .send({ vehicleId: car, area: "roof", severity: "minor", description: "Hail dent" });
    expect(byAgent.status).toBe(403);
    const recorded = await api().post("/api/v1/vehicle-damages").set(owner()).send({
      vehicleId: car,
      area: "roof",
      severity: "minor",
      description: "Hail dent",
      estimate: "120.00",
    });
    expect(recorded.status, JSON.stringify(recorded.body)).toBe(201);
    const damage = recorded.body.data as Damage & { bookingId: string | null };
    expect(damage).toMatchObject({
      bookingId: null,
      liability: "undecided",
      estimate: expect.objectContaining({ amountMinor: 12_000 }),
    });
    const toRenter = await api()
      .patch(`/api/v1/vehicle-damages/${damage.id}`)
      .set(owner())
      .send({ liability: "customer" });
    expect([toRenter.status, toRenter.body.error.message]).toEqual([
      422,
      "A damage recorded outside a rental is not charged to a renter",
    ]);
    const shot = await photo(`/api/v1/vehicle-damages/${damage.id}`, t.ownerAccessToken);
    const detail = await api().get(`/api/v1/vehicle-damages/${damage.id}`).set(owner());
    expect(detail.body.data.photos).toEqual([expect.objectContaining({ id: shot })]);
    expect((await api().get(`/api/v1/vehicle-damages/${randomUUID()}`).set(owner())).status).toBe(
      404,
    );
  });
});
