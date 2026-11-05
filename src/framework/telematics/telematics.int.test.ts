import type { Express } from "express";
import type { Container } from "inversify";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TelematicsDaily } from "../../application/use-cases/telematics/TelematicsDaily.js";
import {
  ProvisionedTenants,
  type ProvisionedTenant,
} from "../../testing/fixtures/ProvisionedTenants.js";
import { StaffFixtures } from "../../testing/fixtures/StaffFixtures.js";
import { createTestContainer } from "../../testing/testContainer.js";
import { disposeContainer } from "../dependency-injection/container.js";
import { TYPES } from "../dependency-injection/types.js";

/**
 * Telematics and GPS (P9-4) end to end: a provider connected with a secret token, positions
 * pushed and resent, an unknown tracker linked to its vehicle, a trip from the depot with an
 * over-speed spell and a geofence exit told to staff and acknowledged, the live map, the track,
 * utilisation from ignition and its report, a Flespi tracker added up front, and the daily run
 * syncing the odometer, telling a silent tracker and purging old positions.
 */
let container: Container;
let app: Express;
let t: ProvisionedTenant;
let vehicleA: string;
let vehicleB: string;
let connectionId: string;
let token: string;
let ingestPath: string;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- response bodies are checked by expect()
type Body = any;

const api = () => request(app);
const owner = () => ({ Authorization: `Bearer ${t.ownerAccessToken}` });
const digits = (n: number) => String(Math.floor(Math.random() * 10 ** n)).padStart(n, "0");
const DEPOT = { latitude: 5.6037, longitude: -0.187 };
const start = Date.now() - 2 * 3_600_000;

function ok(res: request.Response, status = 200): Body {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res.body.data;
}

const push = (body: unknown, bearer: string | null = token, path = ingestPath) => {
  const req = api().post(path);
  return (bearer === null ? req : req.set("Authorization", `Bearer ${bearer}`)).send(
    body as object,
  );
};

async function vehicle(odometer: number): Promise<string> {
  return ok(
    await api()
      .post("/api/v1/vehicles")
      .set(owner())
      .send({ make: "Toyota", model: "Corolla", plateNumber: `GT ${digits(4)}-26`, odometer }),
    201,
  ).id as string;
}

/** A drive out of the depot: 30 s apart, over the limit for a minute, then parked. */
function drive(identifier: string): Body[] {
  const points: Body[] = [];
  const speeds = [0, 40, 60, 80, 115, 125, 118, 70, 40, 0, 0];
  speeds.forEach((speedKmh, i) => {
    points.push({
      deviceId: identifier,
      recordedAt: new Date(start + i * 30_000).toISOString(),
      latitude: DEPOT.latitude,
      // About 330 m east every 30 s, out of the 1 km depot fence by the fourth position, then
      // idling where it stopped.
      longitude: DEPOT.longitude + Math.min(i, 9) * 0.003,
      speedKmh,
      heading: 90,
      ignition: i < speeds.length - 1,
      odometerKm: 20_000 + i * 0.3,
    });
  });
  return points;
}

beforeAll(async () => {
  container = await createTestContainer({ AUTH_RATE_LIMIT_MAX: "10000", RATE_LIMIT_MAX: "100000" });
  app = container.get<Express>(TYPES.HttpApp);
  const staff = await new StaffFixtures(container).create(["super_admin"]);
  t = await new ProvisionedTenants(container, app, staff).create();
  vehicleA = await vehicle(19_000);
  vehicleB = await vehicle(5_000);
}, 120_000);

afterAll(async () => {
  await disposeContainer(container);
});

describe("telematics", () => {
  it("connects a provider with a token shown once and refuses pushes without it", async () => {
    const created = ok(
      await api()
        .post("/api/v1/telematics/connections")
        .set(owner())
        .send({ name: "Fleet trackers", provider: "generic" }),
      201,
    );
    connectionId = created.connection.id;
    token = created.token;
    expect(token).toMatch(/^afgps_/);
    expect(created.ingestUrl).toContain(`/api/v1/webhooks/telematics/${t.slug}/${connectionId}`);
    ingestPath = new URL(created.ingestUrl).pathname;
    expect(created.connection.tokenHint).toBe(token.slice(-4));
    const listed = ok(await api().get("/api/v1/telematics/connections").set(owner()));
    expect(JSON.stringify(listed)).not.toContain(token);

    expect((await push(drive("IMEI-A"), null)).status).toBe(401);
    expect((await push(drive("IMEI-A"), `afgps_${"x".repeat(40)}`)).status).toBe(401);
    expect(
      (await push(drive("IMEI-A"), token, `/api/v1/webhooks/telematics/nobody/${connectionId}`))
        .status,
    ).toBe(401);
  });

  it("adds an unknown tracker unlinked, then follows it once linked to its vehicle", async () => {
    const first = ok(await push({ positions: drive("IMEI-A").slice(0, 2) }));
    expect(first).toMatchObject({ accepted: 2, duplicates: 0, newDevices: 1 });
    const unlinked = ok(await api().get("/api/v1/telematics/devices?unlinked=true").set(owner()));
    expect(unlinked).toHaveLength(1);
    const device = unlinked[0];
    expect(device).toMatchObject({ identifier: "IMEI-A", vehicleId: null });
    expect(device.last.latitude).toBeCloseTo(DEPOT.latitude, 4);

    ok(
      await api()
        .patch(`/api/v1/telematics/devices/${device.id}`)
        .set(owner())
        .send({ vehicleId: vehicleA, label: "Dashboard unit" }),
    );
    // A vehicle has one tracker.
    const second = ok(
      await api()
        .post("/api/v1/telematics/devices")
        .set(owner())
        .send({ connectionId, identifier: "IMEI-SPARE", vehicleId: vehicleA }),
      422,
    );
    expect(second).toBeUndefined();

    await api()
      .post("/api/v1/telematics/geofences")
      .set(owner())
      .send({
        name: "Depot",
        shape: { kind: "circle", center: DEPOT, radiusM: 1_000 },
        alertOn: "exit",
      })
      .expect(201);
    const all = drive("IMEI-A");
    const pushed = ok(await push(all));
    expect(pushed).toMatchObject({ accepted: all.length - 2, duplicates: 2, rejected: 0 });
    // Resent: stored once.
    expect(ok(await push(all))).toMatchObject({ accepted: 0, duplicates: all.length });
  });

  it("records the trip, the over-speed spell and the geofence exit, and tells staff", async () => {
    const from = new Date(start - 60_000).toISOString();
    const to = new Date().toISOString();
    const trips = ok(
      await api()
        .get(`/api/v1/telematics/trips?vehicleId=${vehicleA}&from=${from}&to=${to}`)
        .set(owner()),
    );
    expect(trips).toHaveLength(1);
    const trip = trips[0];
    expect(trip.endedAt).not.toBeNull();
    // The two positions sent before the tracker was linked belong to no vehicle.
    expect(trip.distanceKm).toBeGreaterThan(2);
    expect(trip.maxSpeedKmh).toBe(125);
    expect(trip.idleSeconds).toBe(30);

    const events = ok(
      await api().get(`/api/v1/telematics/events?vehicleId=${vehicleA}`).set(owner()),
    );
    const kinds = (events as { kind: string }[]).map((e) => e.kind).sort();
    expect(kinds).toEqual(["geofence_exit", "overspeed"]);
    const overspeed = (events as Body[]).find((e) => e.kind === "overspeed");
    expect(overspeed).toMatchObject({ maxSpeedKmh: 125, limitKmh: 100 });
    expect(overspeed.endedAt).not.toBeNull();
    expect((events as Body[]).find((e) => e.kind === "geofence_exit").geofenceName).toBe("Depot");

    const inbox = await api().get("/api/v1/notifications?pageSize=50").set(owner());
    const titles = (inbox.body.data as { title: string }[]).map((n) => n.title).join(" | ");
    expect(titles).toContain("is over the speed limit");
    expect(titles).toContain("left Depot");

    const acknowledged = ok(
      await api()
        .post(`/api/v1/telematics/events/${overspeed.id}/acknowledge`)
        .set(owner())
        .send({ note: "Spoke to the driver" }),
    );
    expect(acknowledged.acknowledgedAt).not.toBeNull();
    const open = ok(await api().get("/api/v1/telematics/events?open=true").set(owner()));
    expect((open as { kind: string }[]).map((e) => e.kind)).toEqual(["geofence_exit"]);
    const again = await api()
      .post(`/api/v1/telematics/events/${overspeed.id}/acknowledge`)
      .set(owner())
      .send({});
    expect(again.status).toBe(422);
  });

  it("shows the live map, the track and utilisation from ignition", async () => {
    const live = ok(await api().get("/api/v1/telematics/live").set(owner()));
    const a = (live as Body[]).find((d) => d.vehicleId === vehicleA);
    // Its last position was taken over an hour ago, though received just now.
    expect(a).toMatchObject({ state: "offline", onTrip: false });

    const track = ok(
      await api()
        .get(
          `/api/v1/vehicles/${vehicleA}/track?from=${new Date(start - 60_000).toISOString()}&to=${new Date().toISOString()}`,
        )
        .set(owner()),
    );
    expect(track).toHaveLength(9);

    const usage = ok(
      await api().get(`/api/v1/telematics/utilisation?vehicleId=${vehicleA}`).set(owner()),
    );
    const row = usage.vehicles[0];
    expect(row).toMatchObject({ trips: 1, activeDays: 1, overspeedEvents: 1, maxSpeedKmh: 125 });
    expect(row.engineHours).toBeCloseTo(300 / 3600, 1);
    expect(usage.workingHoursPerDay).toBe(10);

    const report = await api()
      .post("/api/v1/reports/telematics_utilisation/run")
      .set(owner())
      .send({ params: {} });
    expect(report.status, JSON.stringify(report.body)).toBe(200);
    expect(JSON.stringify(report.body.data.rows)).toContain('"trips":1');
  });

  it("reads a Flespi tracker added up front", async () => {
    const flespi = ok(
      await api()
        .post("/api/v1/telematics/connections")
        .set(owner())
        .send({ name: "flespi stream", provider: "flespi" }),
      201,
    );
    ok(
      await api().post("/api/v1/telematics/devices").set(owner()).send({
        connectionId: flespi.connection.id,
        identifier: "352093081234567",
        vehicleId: vehicleB,
      }),
      201,
    );
    const at = Date.now() / 1000 - 600;
    const result = ok(
      await push(
        [0, 30, 60].map((s) => ({
          ident: "352093081234567",
          timestamp: at + s,
          "position.latitude": 5.55,
          "position.longitude": -0.2 + s * 0.0001,
          "position.speed": 30,
          "engine.ignition.status": true,
          "vehicle.mileage": 5_100 + s / 30,
        })),
        flespi.token,
        new URL(flespi.ingestUrl).pathname,
      ),
    );
    expect(result).toMatchObject({ accepted: 3, newDevices: 0 });
    const live = ok(await api().get("/api/v1/telematics/live").set(owner()));
    expect((live as Body[]).find((d) => d.vehicleId === vehicleB)).toMatchObject({
      state: "moving",
      onTrip: true,
    });
  });

  it("syncs the odometer, tells a silent tracker and purges old positions every day", async () => {
    // The reading at registration came before the drive.
    await t.tenant.query(
      "update odometer_readings set read_at = read_at - interval '1 day' where vehicle_id = $1",
      [vehicleA],
    );
    await t.tenant.query(
      "update vehicles set odometer_read_at = odometer_read_at - interval '1 day' where id = $1",
      [vehicleA],
    );
    await t.tenant.query(
      "update telematics_devices set last_received_at = now() - interval '30 hours' where vehicle_id = $1",
      [vehicleA],
    );
    await t.tenant.query(
      "update telematics_positions set recorded_at = recorded_at - interval '400 days' where vehicle_id = $1",
      [vehicleA],
    );
    const daily = container.get<TelematicsDaily>(TYPES.TelematicsDaily);
    await t.tenant.run(() => daily.run(new Date().toISOString().slice(0, 10)));

    const v = await t.tenant.query<{ current_odometer: number }>(
      "select current_odometer from vehicles where id = $1",
      [vehicleA],
    );
    expect(v[0]!.current_odometer).toBe(20_003);
    const readings = await t.tenant.query<{ source: string }>(
      "select source from odometer_readings where vehicle_id = $1 order by read_at desc limit 1",
      [vehicleA],
    );
    expect(readings[0]!.source).toBe("telematics");

    const inbox = await api().get("/api/v1/notifications?pageSize=50").set(owner());
    expect(JSON.stringify(inbox.body.data)).toContain("No position from");
    const left = await t.tenant.query<{ n: number }>(
      "select count(*)::int as n from telematics_positions where vehicle_id = $1",
      [vehicleA],
    );
    expect(left[0]!.n).toBe(0);
    // Trips and daily totals stay.
    const trips = await t.tenant.query("select 1 from telematics_trips where vehicle_id = $1", [
      vehicleA,
    ]);
    expect(trips).toHaveLength(1);
    // Running again records and tells nothing new.
    await t.tenant.run(() => daily.run(new Date().toISOString().slice(0, 10)));
    const count = await t.tenant.query<{ n: number }>(
      "select count(*)::int as n from odometer_readings where vehicle_id = $1 and source = 'telematics'",
      [vehicleA],
    );
    expect(count[0]!.n).toBe(1);
  });

  it("stops taking positions from a disabled connection or with an old token", async () => {
    const rotated = ok(
      await api().post(`/api/v1/telematics/connections/${connectionId}/rotate-token`).set(owner()),
    );
    expect((await push(drive("IMEI-A"))).status).toBe(401);
    expect((await push(drive("IMEI-A"), rotated.token)).status).toBe(200);
    token = rotated.token;
    ok(
      await api()
        .patch(`/api/v1/telematics/connections/${connectionId}`)
        .set(owner())
        .send({ status: "disabled" }),
    );
    expect((await push(drive("IMEI-A"))).status).toBe(401);
  });
});
