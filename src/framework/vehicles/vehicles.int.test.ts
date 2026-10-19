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

let container: Container;
let app: Express;
let platform: pg.Pool;
let t: ProvisionedTenant;
let hq: string;
let kumasi: string;
let officer: string;

const api = () => request(app);
const as = (token: string) => ({ Authorization: `Bearer ${token}` });
const owner = () => as(t.ownerAccessToken);
const plate = () =>
  `GR ${String(Math.floor(Math.random() * 9000) + 1000)}-${randomUUID().slice(0, 2).toUpperCase()}`;

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

/** A Fleet Officer limited to one branch, signed in. */
async function fleetOfficer(branchId: string): Promise<string> {
  const roles = await api().get("/api/v1/roles").set(owner());
  const roleId = (roles.body.data as { id: string; systemKey: string | null }[]).find(
    (r) => r.systemKey === "fleet_officer",
  )!.id;
  const email = `officer-${randomUUID().slice(0, 8)}@example.com`;
  const invited = await api()
    .post("/api/v1/users/invitations")
    .set(owner())
    .send({ name: "Fleet Officer", email, branchIds: [branchId], roles: [{ roleId, branchId }] });
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

async function register(body: Record<string, unknown>, token = t.ownerAccessToken) {
  return api()
    .post("/api/v1/vehicles")
    .set(as(token))
    .send({ make: "Toyota", model: "Corolla", plateNumber: plate(), ...body });
}

beforeAll(async () => {
  container = await createTestContainer({ AUTH_RATE_LIMIT_MAX: "10000" });
  app = container.get<Express>(TYPES.HttpApp);
  platform = container.get<pg.Pool>(TYPES.PlatformDatabasePool);
  const staff = await new StaffFixtures(container).create(["super_admin"]);
  t = await new ProvisionedTenants(container, app, staff).create();
  const branches = await api().get("/api/v1/branches").set(owner());
  hq = (branches.body.data as { id: string; isDefault: boolean }[]).find((b) => b.isDefault)!.id;
  const created = await api()
    .post("/api/v1/branches")
    .set(owner())
    .send({ code: "KSI", name: "Kumasi" });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  kumasi = created.body.data.id;
  officer = await fleetOfficer(kumasi);
});

afterAll(async () => {
  await disposeContainer(container);
});

describe("register", () => {
  it("registers a vehicle with a code, a normalised plate, the catalogue make and a first reading", async () => {
    const res = await register({
      plateNumber: "gr 4821 - 19",
      make: "toyota",
      model: "corolla",
      year: 2019,
      odometer: 84_500,
      financials: { acquisitionDate: "2025-01-10", acquisitionCost: "120000.00" },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data).toMatchObject({
      code: "VEH-00001",
      plateNumber: "GR 4821-19",
      make: "Toyota",
      model: "Corolla",
      status: "available",
      branchId: hq,
      odometer: { value: 84_500, unit: "km" },
      financials: { acquisitionCost: { amountMinor: 12_000_000, currency: "GHS" } },
    });
    expect(res.body.data.makeId).not.toBeNull();
    expect(res.body.data.modelId).not.toBeNull();

    const duplicate = await register({ plateNumber: "GR4821-19" });
    expect([duplicate.status, duplicate.body.error.code]).toEqual([409, "VEHICLE_EXISTS"]);
    const statusOnly = await register({ status: "on_rent" });
    expect(statusOnly.status).toBe(400);
  });

  it("keeps vehicles of other branches and cost figures away from a branch fleet officer", async () => {
    const atHq = await register({});
    const atKumasi = await register({ branchId: kumasi });
    const own = await register({}, officer);
    expect(own.status, JSON.stringify(own.body)).toBe(201);
    expect(own.body.data.branchId).toBe(kumasi);
    expect(own.body.data.financials).toBeUndefined();

    const list = await api().get("/api/v1/vehicles").set(as(officer));
    const ids = (list.body.data as { id: string }[]).map((v) => v.id);
    expect(ids).toContain(atKumasi.body.data.id);
    expect(ids).not.toContain(atHq.body.data.id);
    expect((await api().get(`/api/v1/vehicles/${atHq.body.data.id}`).set(as(officer))).status).toBe(
      404,
    );
    const elsewhere = await register({ branchId: hq }, officer);
    expect(elsewhere.body.error.code).toBe("BRANCH_OUT_OF_SCOPE");
    const costs = await api()
      .patch(`/api/v1/vehicles/${atKumasi.body.data.id}`)
      .set(as(officer))
      .send({ financials: { acquisitionCost: "1000" } });
    expect(costs.status).toBe(403);
  });

  it("pages, searches by any spelling of the plate and filters by status", async () => {
    const target = await register({ plateNumber: "AS 777-26" });
    const found = await api().get("/api/v1/vehicles?search=as777").set(owner());
    expect((found.body.data as { id: string }[]).map((v) => v.id)).toEqual([target.body.data.id]);
    const first = await api().get("/api/v1/vehicles?limit=2").set(owner());
    expect(first.body.data).toHaveLength(2);
    const second = await api()
      .get(`/api/v1/vehicles?limit=2&cursor=${first.body.meta.nextCursor}`)
      .set(owner());
    expect(second.body.data[0].id).not.toBe(first.body.data[1].id);
    expect((await api().get("/api/v1/vehicles?status=on_rent").set(owner())).body.data).toEqual([]);
  });
});

describe("status", () => {
  it("allows only manual transitions, with a reason, and keeps the history", async () => {
    const v = (await register({})).body.data;
    const rent = await api()
      .post(`/api/v1/vehicles/${v.id}/status`)
      .set(owner())
      .send({ status: "on_rent", reason: "customer" });
    expect([rent.status, rent.body.error.code]).toEqual([422, "VEHICLE_STATUS_TRANSITION"]);
    const options = await api().get(`/api/v1/vehicles/${v.id}/status-options`).set(owner());
    expect(options.body.data).toContain("in_maintenance");
    expect(options.body.data).not.toContain("on_rent");

    const workshop = await api()
      .post(`/api/v1/vehicles/${v.id}/status`)
      .set(owner())
      .send({ status: "in_maintenance", reason: "Brake pads" });
    expect(workshop.body.data.status).toBe("in_maintenance");
    const history = await api().get(`/api/v1/vehicles/${v.id}/status-history`).set(owner());
    expect(
      (history.body.data as { from: string | null; to: string; reason: string }[]).map((h) => [
        h.from,
        h.to,
        h.reason,
      ]),
    ).toEqual([
      ["available", "in_maintenance", "Brake pads"],
      [null, "available", "Registered"],
    ]);
  });
});

describe("odometer", () => {
  it("refuses lower readings unless the odometer was replaced", async () => {
    const v = (await register({ odometer: 10_000 })).body.data;
    const read = (body: Record<string, unknown>) =>
      api().post(`/api/v1/vehicles/${v.id}/odometer`).set(owner()).send(body);
    expect((await read({ value: 10_500 })).status).toBe(201);
    const lower = await read({ value: 9_000 });
    expect([lower.status, lower.body.error.code]).toEqual([422, "ODOMETER_INVALID"]);
    expect((await read({ value: 12, replacement: true, note: "Cluster replaced" })).status).toBe(
      201,
    );
    const vehicle = await api().get(`/api/v1/vehicles/${v.id}`).set(owner());
    expect(vehicle.body.data.odometer.value).toBe(12);
    const readings = await api().get(`/api/v1/vehicles/${v.id}/odometer`).set(owner());
    expect((readings.body.data as { value: number }[]).map((r) => r.value)).toEqual([
      12, 10_500, 10_000,
    ]);
  });
});

describe("documents and compliance", () => {
  it("turns a vehicle green once its required documents are in force", async () => {
    const v = (await register({})).body.data;
    const before = await api().get(`/api/v1/vehicles/${v.id}/documents`).set(owner());
    expect(before.body.data.compliance).toMatchObject({ level: "red", canOperate: false });
    const board = await api().get("/api/v1/vehicles/compliance?level=red").set(owner());
    expect((board.body.data.vehicles as { vehicleId: string }[]).map((r) => r.vehicleId)).toContain(
      v.id,
    );

    const add = (body: Record<string, unknown>) =>
      api().post(`/api/v1/vehicles/${v.id}/documents`).set(owner()).send(body);
    expect((await add({ type: "registration", number: "GR 1" })).status).toBe(201);
    const insurance = await add({
      type: "insurance",
      provider: "SIC",
      issuedOn: "2026-01-01",
      expiresOn: "2099-01-01",
      cost: "1500.00",
    });
    expect(insurance.body.data).toMatchObject({
      reminderDays: [30, 14, 3],
      cost: { amountMinor: 150_000 },
    });
    await add({ type: "roadworthy", issuedOn: "2026-01-01", expiresOn: "2099-01-01" });
    const after = await api().get(`/api/v1/vehicles/${v.id}/documents`).set(owner());
    expect(after.body.data.compliance).toMatchObject({ level: "green", canOperate: true });

    const scan = await api()
      .post(`/api/v1/vehicles/${v.id}/documents/${insurance.body.data.id}/files`)
      .set(owner())
      .send({ filename: "policy.png", contentType: "image/png", sizeBytes: png().length });
    expect(scan.status, JSON.stringify(scan.body)).toBe(201);
    const { method, url, headers } = scan.body.data.upload;
    expect((await fetch(url, { method, headers, body: png() })).ok).toBe(true);
    const done = await api()
      .post(
        `/api/v1/vehicles/${v.id}/documents/${insurance.body.data.id}/files/${scan.body.data.file.id}/complete`,
      )
      .set(owner());
    expect(done.body.data.status).toBe("ready");
  });
});

describe("photos, groups and overview", () => {
  it("makes the first photo primary and shows it on the overview", async () => {
    const v = (await register({})).body.data;
    const started = await api()
      .post(`/api/v1/vehicles/${v.id}/photos`)
      .set(owner())
      .send({ filename: "front.png", contentType: "image/png", sizeBytes: png().length });
    const { method, url, headers } = started.body.data.upload;
    await fetch(url, { method, headers, body: png() });
    const photo = await api()
      .post(`/api/v1/vehicles/${v.id}/photos/${started.body.data.file.id}/complete`)
      .set(owner());
    expect(photo.body.data.primary).toBe(true);

    const overview = await api().get(`/api/v1/vehicles/${v.id}/overview`).set(owner());
    expect(overview.body.data).toMatchObject({
      primaryPhoto: { id: started.body.data.file.id },
      branch: { id: hq },
      compliance: { level: "red" },
      kpis: null,
    });
    expect(overview.body.data.timeline.items[0]).toMatchObject({ kind: "status" });
  });

  it("groups vehicles and filters by group", async () => {
    const group = await api()
      .post("/api/v1/vehicle-groups")
      .set(owner())
      .send({ name: "Uber fleet" });
    expect(group.status).toBe(201);
    const v = (await register({ groupIds: [group.body.data.id] })).body.data;
    const w = (await register({})).body.data;
    await api()
      .post(`/api/v1/vehicle-groups/${group.body.data.id}/members`)
      .set(owner())
      .send({ add: [w.id] });
    const listed = await api().get(`/api/v1/vehicles?groupId=${group.body.data.id}`).set(owner());
    expect((listed.body.data as { id: string }[]).map((x) => x.id).sort()).toEqual(
      [v.id, w.id].sort(),
    );
    const taken = await api()
      .post("/api/v1/vehicle-groups")
      .set(owner())
      .send({ name: "uber FLEET" });
    expect(taken.status).toBe(409);
  });
});

describe("custom fields and settings", () => {
  it("requires the business's required custom fields", async () => {
    const settings = await api()
      .patch("/api/v1/settings/vehicles")
      .set(owner())
      .send({
        customFields: [{ key: "tracker_id", label: "Tracker ID", type: "text", required: true }],
      });
    expect(settings.status, JSON.stringify(settings.body)).toBe(200);
    expect((await register({})).body.error.code).toBe("INVALID_VEHICLE");
    const ok = await register({ customFields: { tracker_id: "TRK-9" } });
    expect(ok.body.data.customFields).toEqual({ tracker_id: "TRK-9" });
    await api().patch("/api/v1/settings/vehicles").set(owner()).send({ customFields: [] });
  });
});

describe("import and export", () => {
  it("previews every row, then creates all rows or none", async () => {
    const csv = [
      "plate_number,make,model,year,odometer,branch_code,tags",
      "GT 1001-24,Kia,Rio,2020,5000,KSI,uber;ac",
      "GT 1002-24,Hyundai,Elantra,1900,,,",
      "GT 1001-24,Kia,Picanto,2021,,,",
    ].join("\n");
    const preview = await api()
      .post("/api/v1/vehicles/import")
      .set(owner())
      .send({ csv, commit: true });
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(preview.body.data).toMatchObject({ valid: false, committed: false, created: 0 });
    expect((preview.body.data.rows as { line: number; ok: boolean }[]).map((r) => r.ok)).toEqual([
      true,
      false,
      false,
    ]);
    expect(preview.body.data.rows[2].error).toMatch(/already has the plate number/);

    const good = csv.split("\n").slice(0, 2).join("\n");
    const committed = await api()
      .post("/api/v1/vehicles/import")
      .set(owner())
      .send({ csv: good, commit: true });
    expect(committed.body.data).toMatchObject({ valid: true, committed: true, created: 1 });
    const found = await api().get("/api/v1/vehicles?search=GT1001-24").set(owner());
    expect(found.body.data[0]).toMatchObject({ branchId: kumasi, tags: ["uber", "ac"] });
    expect(found.body.data[0].odometer.value).toBe(5_000);

    const exported = await api().get("/api/v1/vehicles/export").set(owner());
    expect(exported.headers["content-type"]).toContain("text/csv");
    expect(exported.text.split("\r\n")[0]).toContain("acquisition_cost");
    expect(exported.text).toContain("GT 1001-24");
    const officerExport = await api().get("/api/v1/vehicles/export").set(as(officer));
    expect(officerExport.text.split("\r\n")[0]).not.toContain("acquisition_cost");
  });

  it("serves an import template", async () => {
    const template = await api().get("/api/v1/vehicles/import/template").set(owner());
    expect(template.text.split("\r\n")[0]).toMatch(/^plate_number,vin,make,model/);
  });
});

describe("branches and removal", () => {
  it("blocks deactivating a branch until its vehicles are transferred", async () => {
    const extra = await api()
      .post("/api/v1/branches")
      .set(owner())
      .send({ code: "TKD", name: "Takoradi" });
    const branchId = extra.body.data.id as string;
    const v = (await register({ branchId })).body.data;
    const blocked = await api()
      .post(`/api/v1/branches/${branchId}/deactivate`)
      .set(owner())
      .send({ reason: "closing the yard" });
    expect([blocked.status, blocked.body.error.message]).toEqual([
      422,
      expect.stringMatching(/1 vehicle is still in this branch/),
    ]);
    const moved = await api()
      .post("/api/v1/vehicles/transfer")
      .set(owner())
      .send({ vehicleIds: [v.id], branchId: hq, reason: "closing the yard" });
    expect(moved.body.data[0].branchId).toBe(hq);
    const done = await api()
      .post(`/api/v1/branches/${branchId}/deactivate`)
      .set(owner())
      .send({ reason: "closing the yard" });
    expect(done.status, JSON.stringify(done.body)).toBe(204);
  });

  it("removes a mistaken entry and frees its plate", async () => {
    const v = (await register({ plateNumber: "WR 55-26" })).body.data;
    const removed = await api()
      .delete(`/api/v1/vehicles/${v.id}`)
      .set(owner())
      .send({ reason: "Entered twice" });
    expect(removed.status).toBe(204);
    expect((await api().get(`/api/v1/vehicles/${v.id}`).set(owner())).status).toBe(404);
    expect((await register({ plateNumber: "WR 55-26" })).status).toBe(201);
    expect(
      (await api().delete(`/api/v1/vehicles/${v.id}`).set(as(officer)).send({ reason: "nope" }))
        .status,
    ).toBe(403);
  });
});
