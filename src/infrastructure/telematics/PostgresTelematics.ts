import type {
  ConnectionSecret,
  DeviceChanges,
  DeviceFilter,
  EventFilter,
  GeofenceInput,
  GeofenceView,
  ITelematics,
  LastFix,
  NewEvent,
  PositionView,
  ReceivedPosition,
  TelematicsConnection,
  TelematicsDevice,
  TelematicsEvent,
  TelematicsProvider,
  TelematicsSettings,
  TelematicsSettingsInput,
  Tracker,
  TripFilter,
  TripView,
  UsageIncrement,
  VehicleContext,
  VehicleUsage,
} from "../../application/ports/ITelematics.js";
import type { GeofenceArea, GeofenceShape, Point } from "../../domain/telematics/Geo.js";
import type { Fix, TrackerState } from "../../domain/telematics/Tracker.js";
import type { PostgresTransactionContext } from "../database/postgres/PostgresTransactionContext.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Row = Record<string, unknown>;

const n = (v: unknown): number => Number(v);
const nOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const text = (v: unknown): string | null => (typeof v === "string" ? v : null);
const date = (v: unknown): Date | null => (v instanceof Date ? v : null);
const vehicleName = "coalesce(v.plate_number, v.code)";

/** Builds `where` clauses with numbered parameters. */
class Where {
  readonly parts: string[] = [];
  readonly params: unknown[] = [];
  add(sql: string, value: unknown): this {
    this.params.push(value);
    this.parts.push(sql.replaceAll("?", `$${this.params.length}`));
    return this;
  }
  raw(sql: string): this {
    this.parts.push(sql);
    return this;
  }
  branches(column: string, ids: "all" | readonly string[]): this {
    return ids === "all" ? this : this.add(`${column} = any(?::uuid[])`, ids);
  }
  sql(): string {
    return this.parts.length === 0 ? "" : `where ${this.parts.join(" and ")}`;
  }
  next(value: unknown): string {
    this.params.push(value);
    return `$${this.params.length}`;
  }
}

const DEVICE = `
  select d.*, c.name::text as connection_name, v.branch_id, ${vehicleName} as vehicle_name
    from telematics_devices d
    join telematics_connections c on c.id = d.connection_id
    left join vehicles v on v.id = d.vehicle_id`;

function lastFix(r: Row): LastFix | null {
  const at = date(r.last_position_at);
  if (at === null) return null;
  return {
    at,
    latitude: n(r.last_latitude),
    longitude: n(r.last_longitude),
    speedKmh: n(r.last_speed_kmh ?? 0),
    heading: nOrNull(r.last_heading),
    ignition: typeof r.last_ignition === "boolean" ? r.last_ignition : null,
    odometerKm: nOrNull(r.last_odometer_km),
  };
}

const toDevice = (r: Row): TelematicsDevice => ({
  id: String(r.id),
  connectionId: String(r.connection_id),
  connectionName: String(r.connection_name),
  identifier: String(r.identifier),
  label: text(r.label),
  vehicleId: text(r.vehicle_id),
  vehicleName: text(r.vehicle_name),
  branchId: text(r.branch_id),
  status: r.status as TelematicsDevice["status"],
  syncOdometer: r.sync_odometer === true,
  odometerOffsetKm: n(r.odometer_offset_km),
  last: lastFix(r),
  lastReceivedAt: date(r.last_received_at),
  onTrip: r.trip_id !== null,
  createdAt: r.created_at as Date,
});

const toConnection = (r: Row): TelematicsConnection => ({
  id: String(r.id),
  name: String(r.name),
  provider: r.provider as TelematicsProvider,
  tokenHint: String(r.token_hint),
  status: r.status as TelematicsConnection["status"],
  lastReceivedAt: date(r.last_received_at),
  acceptedCount: n(r.accepted_count),
  rejectedCount: n(r.rejected_count),
  lastError: text(r.last_error),
  devices: n(r.devices),
  createdAt: r.created_at as Date,
});

function shapeOf(r: Row): GeofenceShape {
  return r.kind === "circle"
    ? {
        kind: "circle",
        center: { latitude: n(r.latitude), longitude: n(r.longitude) },
        radiusM: n(r.radius_m),
      }
    : { kind: "polygon", points: r.points as Point[] };
}

const toGeofence = (r: Row): GeofenceView => ({
  id: String(r.id),
  name: String(r.name),
  shape: shapeOf(r),
  branchId: text(r.branch_id),
  alertOn: r.alert_on as GeofenceView["alertOn"],
  active: r.active === true,
  createdAt: r.created_at as Date,
  updatedAt: r.updated_at as Date,
});

const TRIP = `
  select t.*, ${vehicleName} as vehicle_name,
         case when dr.id is null then null else dr.first_name || ' ' || dr.last_name end as driver_name
    from telematics_trips t
    left join vehicles v on v.id = t.vehicle_id
    left join drivers dr on dr.id = t.driver_id`;

const toTrip = (r: Row): TripView => ({
  id: String(r.id),
  deviceId: String(r.device_id),
  vehicleId: text(r.vehicle_id),
  vehicleName: text(r.vehicle_name),
  driverId: text(r.driver_id),
  driverName: text(r.driver_name),
  startedAt: r.started_at as Date,
  endedAt: date(r.ended_at),
  start: { latitude: n(r.start_latitude), longitude: n(r.start_longitude) },
  end:
    r.end_latitude === null ? null : { latitude: n(r.end_latitude), longitude: n(r.end_longitude) },
  distanceKm: Math.round(n(r.distance_m) / 100) / 10,
  movingSeconds: n(r.moving_seconds),
  idleSeconds: n(r.idle_seconds),
  maxSpeedKmh: n(r.max_speed_kmh),
  positions: n(r.positions),
  startOdometerKm: nOrNull(r.start_odometer_km),
  endOdometerKm: nOrNull(r.end_odometer_km),
});

const EVENT = `
  select e.*, ${vehicleName} as vehicle_name, g.name::text as geofence_name,
         case when dr.id is null then null else dr.first_name || ' ' || dr.last_name end as driver_name
    from telematics_events e
    join vehicles v on v.id = e.vehicle_id
    left join drivers dr on dr.id = e.driver_id
    left join geofences g on g.id = e.geofence_id`;

const toEvent = (r: Row): TelematicsEvent => ({
  id: String(r.id),
  kind: r.kind as TelematicsEvent["kind"],
  deviceId: String(r.device_id),
  vehicleId: String(r.vehicle_id),
  vehicleName: String(r.vehicle_name),
  branchId: String(r.branch_id),
  driverId: text(r.driver_id),
  driverName: text(r.driver_name),
  geofenceId: text(r.geofence_id),
  geofenceName: text(r.geofence_name),
  startedAt: r.started_at as Date,
  endedAt: date(r.ended_at),
  latitude: n(r.latitude),
  longitude: n(r.longitude),
  speedKmh: n(r.speed_kmh),
  maxSpeedKmh: nOrNull(r.max_speed_kmh),
  limitKmh: nOrNull(r.limit_kmh),
  acknowledgedBy: text(r.acknowledged_by),
  acknowledgedAt: date(r.acknowledged_at),
  note: text(r.note),
});

/** Telematics in the tenant's database (tenant migration 0047). */
export class PostgresTelematics implements ITelematics {
  constructor(private readonly transactions: PostgresTransactionContext) {}

  private get tx() {
    return this.transactions.current();
  }

  // --- settings ---

  async settings(): Promise<TelematicsSettings> {
    const { rows } = await this.tx.query<Row>("select * from telematics_settings");
    const r = rows[0]!;
    return {
      positionRetentionDays: n(r.position_retention_days),
      overspeedKmh: n(r.overspeed_kmh),
      overspeedMinSeconds: n(r.overspeed_min_seconds),
      workingHoursPerDay: n(r.working_hours_per_day),
      silentAfterHours: n(r.silent_after_hours),
      updatedAt: r.updated_at as Date,
    };
  }

  async saveSettings(input: TelematicsSettingsInput, userId: string): Promise<void> {
    await this.tx.query(
      `update telematics_settings
          set position_retention_days = $1, overspeed_kmh = $2, overspeed_min_seconds = $3,
              working_hours_per_day = $4, silent_after_hours = $5, updated_by = $6,
              updated_at = now()`,
      [
        input.positionRetentionDays,
        input.overspeedKmh,
        input.overspeedMinSeconds,
        input.workingHoursPerDay,
        input.silentAfterHours,
        userId,
      ],
    );
  }

  // --- connections ---

  private readonly CONNECTION = `
    select c.*, c.name::text as name,
           (select count(*) from telematics_devices d
             where d.connection_id = c.id and d.status = 'active')::int as devices
      from telematics_connections c`;

  async connections(): Promise<TelematicsConnection[]> {
    const { rows } = await this.tx.query<Row>(`${this.CONNECTION} order by c.name`);
    return rows.map(toConnection);
  }

  async connection(id: string): Promise<TelematicsConnection | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.tx.query<Row>(`${this.CONNECTION} where c.id = $1`, [id]);
    return rows[0] === undefined ? null : toConnection(rows[0]);
  }

  async secret(id: string): Promise<ConnectionSecret | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.tx.query<Row>(
      "select id, provider, status, token_hash from telematics_connections where id = $1",
      [id],
    );
    const r = rows[0];
    return r === undefined
      ? null
      : {
          id: String(r.id),
          provider: r.provider as TelematicsProvider,
          status: r.status as ConnectionSecret["status"],
          tokenHash: String(r.token_hash),
        };
  }

  async createConnection(input: Parameters<ITelematics["createConnection"]>[0]): Promise<void> {
    await this.tx.query(
      `insert into telematics_connections (id, name, provider, token_hash, token_hint, created_by)
       values ($1, $2, $3, $4, $5, $6)`,
      [input.id, input.name, input.provider, input.tokenHash, input.tokenHint, input.createdBy],
    );
  }

  async updateConnection(
    id: string,
    changes: Parameters<ITelematics["updateConnection"]>[1],
  ): Promise<void> {
    const columns: Record<string, string> = {
      name: "name",
      status: "status",
      tokenHash: "token_hash",
      tokenHint: "token_hint",
    };
    const sets: string[] = [];
    const params: unknown[] = [id];
    for (const [key, value] of Object.entries(changes)) {
      if (value === undefined) continue;
      params.push(value);
      sets.push(`${columns[key]} = $${params.length}`);
    }
    if (sets.length === 0) return;
    await this.tx.query(
      `update telematics_connections set ${sets.join(", ")}, updated_at = now() where id = $1`,
      params,
    );
  }

  async nameTaken(name: string, exceptId: string | null): Promise<boolean> {
    const { rows } = await this.tx.query(
      "select 1 from telematics_connections where name = $1 and id is distinct from $2",
      [name, exceptId],
    );
    return rows.length > 0;
  }

  async noteReceived(
    id: string,
    accepted: number,
    rejected: number,
    error: string | null,
    at: Date,
  ): Promise<void> {
    await this.tx.query(
      `update telematics_connections
          set last_received_at = $2, accepted_count = accepted_count + $3,
              rejected_count = rejected_count + $4, last_error = coalesce($5, last_error),
              updated_at = now()
        where id = $1`,
      [id, at, accepted, rejected, error],
    );
  }

  // --- trackers ---

  async devices(filter: DeviceFilter): Promise<TelematicsDevice[]> {
    const w = new Where().branches("v.branch_id", filter.branchIds);
    if (filter.connectionId !== undefined) w.add("d.connection_id = ?", filter.connectionId);
    if (filter.vehicleId !== undefined) w.add("d.vehicle_id = ?", filter.vehicleId);
    if (filter.unlinked === true) w.raw("d.vehicle_id is null");
    if (filter.status !== undefined) w.add("d.status = ?", filter.status);
    const { rows } = await this.tx.query<Row>(
      `${DEVICE} ${w.sql()} order by d.vehicle_id is null desc, vehicle_name, d.identifier
        limit ${w.next(filter.limit)}`,
      w.params,
    );
    return rows.map(toDevice);
  }

  async device(id: string): Promise<TelematicsDevice | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.tx.query<Row>(`${DEVICE} where d.id = $1`, [id]);
    return rows[0] === undefined ? null : toDevice(rows[0]);
  }

  async deviceCount(connectionId: string): Promise<number> {
    const { rows } = await this.tx.query<{ n: number }>(
      "select count(*)::int as n from telematics_devices where connection_id = $1",
      [connectionId],
    );
    return rows[0]!.n;
  }

  async createDevice(input: Parameters<ITelematics["createDevice"]>[0]): Promise<string> {
    const { rows } = await this.tx.query<{ id: string }>(
      `insert into telematics_devices (connection_id, identifier, label, vehicle_id, created_by)
       values ($1, $2, $3, $4, $5) returning id`,
      [input.connectionId, input.identifier, input.label, input.vehicleId, input.createdBy],
    );
    return rows[0]!.id;
  }

  async updateDevice(id: string, changes: DeviceChanges): Promise<void> {
    const columns: Record<keyof DeviceChanges, string> = {
      label: "label",
      vehicleId: "vehicle_id",
      status: "status",
      syncOdometer: "sync_odometer",
      odometerOffsetKm: "odometer_offset_km",
    };
    const sets: string[] = [];
    const params: unknown[] = [id];
    for (const [key, value] of Object.entries(changes) as [keyof DeviceChanges, unknown][]) {
      if (value === undefined) continue;
      params.push(value);
      sets.push(`${columns[key]} = $${params.length}`);
    }
    if (sets.length === 0) return;
    await this.tx.query(
      `update telematics_devices set ${sets.join(", ")}, updated_at = now() where id = $1`,
      params,
    );
  }

  async resetTracking(deviceId: string): Promise<void> {
    const tx = this.tx;
    await tx.query(
      `update telematics_trips t set ended_at = t.last_position_at
         from telematics_devices d
        where d.id = $1 and t.id = d.trip_id and t.ended_at is null`,
      [deviceId],
    );
    await tx.query(
      `update telematics_events e set ended_at = coalesce(d.last_position_at, e.started_at)
         from telematics_devices d
        where d.id = $1 and e.device_id = d.id and e.kind = 'overspeed' and e.ended_at is null`,
      [deviceId],
    );
    await tx.query("delete from telematics_geofence_states where device_id = $1", [deviceId]);
    await tx.query(
      `update telematics_devices
          set trip_id = null, overspeed_since = null, overspeed_max_kmh = null, updated_at = now()
        where id = $1`,
      [deviceId],
    );
  }

  async vehicleDevice(vehicleId: string): Promise<string | null> {
    const { rows } = await this.tx.query<{ id: string }>(
      "select id from telematics_devices where vehicle_id = $1 and status = 'active'",
      [vehicleId],
    );
    return rows[0]?.id ?? null;
  }

  // --- ingestion ---

  async lockTrackers(
    connectionId: string,
    identifiers: readonly string[],
    maxDevices: number,
  ): Promise<Map<string, Tracker>> {
    const tx = this.tx;
    const trackers = new Map<string, Tracker>();
    if (identifiers.length === 0) return trackers;
    const known = await tx.query<{ identifier: string }>(
      "select identifier from telematics_devices where connection_id = $1 and identifier = any($2)",
      [connectionId, identifiers],
    );
    const have = new Set(known.rows.map((r) => r.identifier));
    const room = Math.max(0, maxDevices - (await this.deviceCount(connectionId)));
    const missing = identifiers.filter((i) => !have.has(i)).slice(0, room);
    if (missing.length > 0)
      await tx.query(
        `insert into telematics_devices (connection_id, identifier)
         select $1, i from unnest($2::text[]) i
         on conflict (connection_id, identifier) do nothing`,
        [connectionId, missing],
      );
    // Locked in id order, so two requests for the same trackers never deadlock.
    const { rows } = await tx.query<Row>(
      `select d.*,
              exists (select 1 from telematics_events e
                       where e.device_id = d.id and e.kind = 'overspeed' and e.ended_at is null)
                as overspeed_open
         from telematics_devices d
        where d.connection_id = $1 and d.identifier = any($2)
        order by d.id
          for update of d`,
      [connectionId, identifiers],
    );
    const states = await tx.query<{ device_id: string; geofence_id: string; inside: boolean }>(
      "select device_id, geofence_id, inside from telematics_geofence_states where device_id = any($1)",
      [rows.map((r) => r.id)],
    );
    const inside = new Map<string, Record<string, boolean>>();
    for (const s of states.rows) {
      const of = inside.get(s.device_id) ?? {};
      of[s.geofence_id] = s.inside;
      inside.set(s.device_id, of);
    }
    for (const r of rows) {
      const last = lastFix(r);
      trackers.set(String(r.identifier), {
        deviceId: String(r.id),
        identifier: String(r.identifier),
        vehicleId: text(r.vehicle_id),
        status: r.status as Tracker["status"],
        tripId: text(r.trip_id),
        state: {
          last:
            last === null
              ? null
              : {
                  recordedAt: last.at,
                  latitude: last.latitude,
                  longitude: last.longitude,
                  speedKmh: last.speedKmh,
                  heading: last.heading,
                  ignition: last.ignition,
                  odometerKm: last.odometerKm,
                },
          tripOpen: r.trip_id !== null,
          overspeedSince: date(r.overspeed_since),
          overspeedMaxKmh: nOrNull(r.overspeed_max_kmh),
          overspeedOpen: r.overspeed_open === true,
          geofences: inside.get(String(r.id)) ?? {},
        },
      });
    }
    return trackers;
  }

  async activeGeofences(): Promise<GeofenceArea[]> {
    const { rows } = await this.tx.query<Row>(
      "select *, name::text as name from geofences where active order by id",
    );
    return rows.map((r) => ({
      id: String(r.id),
      name: String(r.name),
      shape: shapeOf(r),
      branchId: text(r.branch_id),
      alertOn: r.alert_on as GeofenceArea["alertOn"],
    }));
  }

  async vehicleContexts(vehicleIds: readonly string[]): Promise<Map<string, VehicleContext>> {
    const found = new Map<string, VehicleContext>();
    if (vehicleIds.length === 0) return found;
    const { rows } = await this.tx.query<Row>(
      `select v.id, ${vehicleName} as name, v.branch_id,
              (select a.driver_id from vehicle_assignments a
                where a.vehicle_id = v.id and a.ended_at is null limit 1) as driver_id
         from vehicles v where v.id = any($1)`,
      [vehicleIds],
    );
    for (const r of rows)
      found.set(String(r.id), {
        vehicleId: String(r.id),
        name: String(r.name),
        branchId: String(r.branch_id),
        driverId: text(r.driver_id),
      });
    return found;
  }

  async addPositions(
    deviceId: string,
    vehicleId: string | null,
    positions: readonly ReceivedPosition[],
  ): Promise<Set<number>> {
    if (positions.length === 0) return new Set();
    const { rows } = await this.tx.query<{ recorded_at: Date }>(
      `insert into telematics_positions
         (device_id, vehicle_id, recorded_at, latitude, longitude, speed_kmh, heading, ignition,
          odometer_km, attributes)
       select $1, $2, r.recorded_at, r.latitude, r.longitude, r.speed_kmh, r.heading, r.ignition,
              r.odometer_km, coalesce(r.attributes, '{}')
         from jsonb_to_recordset($3::jsonb) as r(recorded_at timestamptz, latitude numeric,
              longitude numeric, speed_kmh numeric, heading smallint, ignition boolean,
              odometer_km numeric, attributes jsonb)
       on conflict (device_id, recorded_at) do nothing
       returning recorded_at`,
      [
        deviceId,
        vehicleId,
        JSON.stringify(
          positions.map((p) => ({
            recorded_at: p.fix.recordedAt.toISOString(),
            latitude: p.fix.latitude,
            longitude: p.fix.longitude,
            speed_kmh: p.fix.speedKmh,
            heading: p.fix.heading,
            ignition: p.fix.ignition,
            odometer_km: p.fix.odometerKm,
            attributes: p.attributes,
          })),
        ),
      ],
    );
    return new Set(rows.map((r) => r.recorded_at.getTime()));
  }

  async saveTracker(
    deviceId: string,
    state: TrackerState,
    tripId: string | null,
    receivedAt: Date,
  ): Promise<void> {
    const last = state.last;
    await this.tx.query(
      `update telematics_devices
          set last_position_at = coalesce($2, last_position_at),
              last_latitude = coalesce($3, last_latitude),
              last_longitude = coalesce($4, last_longitude),
              last_speed_kmh = coalesce($5, last_speed_kmh),
              last_heading = case when $2::timestamptz is null then last_heading else $6 end,
              last_ignition = case when $2::timestamptz is null then last_ignition else $7 end,
              last_odometer_km = coalesce($8, last_odometer_km),
              trip_id = $9, overspeed_since = $10, overspeed_max_kmh = $11,
              last_received_at = $12, silent_notified_at = null, updated_at = now()
        where id = $1`,
      [
        deviceId,
        last?.recordedAt ?? null,
        last?.latitude ?? null,
        last?.longitude ?? null,
        last?.speedKmh ?? null,
        last?.heading ?? null,
        last?.ignition ?? null,
        last?.odometerKm ?? null,
        tripId,
        state.overspeedSince,
        state.overspeedMaxKmh,
        receivedAt,
      ],
    );
  }

  async saveGeofenceState(
    deviceId: string,
    geofenceId: string,
    inside: boolean,
    since: Date,
  ): Promise<void> {
    await this.tx.query(
      `insert into telematics_geofence_states (device_id, geofence_id, inside, since)
       values ($1, $2, $3, $4)
       on conflict (device_id, geofence_id) do update set inside = excluded.inside, since = excluded.since`,
      [deviceId, geofenceId, inside, since],
    );
  }

  async openTrip(
    deviceId: string,
    vehicle: VehicleContext | null,
    vehicleId: string | null,
    fix: Fix,
  ): Promise<string> {
    const { rows } = await this.tx.query<{ id: string }>(
      `insert into telematics_trips
         (device_id, vehicle_id, driver_id, started_at, start_latitude, start_longitude,
          max_speed_kmh, start_odometer_km, end_odometer_km, last_position_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $8, $4) returning id`,
      [
        deviceId,
        vehicleId,
        vehicle?.driverId ?? null,
        fix.recordedAt,
        fix.latitude,
        fix.longitude,
        fix.speedKmh,
        fix.odometerKm,
      ],
    );
    return rows[0]!.id;
  }

  async extendTrip(tripId: string, i: Parameters<ITelematics["extendTrip"]>[1]): Promise<void> {
    await this.tx.query(
      `update telematics_trips
          set distance_m = distance_m + $2, moving_seconds = moving_seconds + $3,
              idle_seconds = idle_seconds + $4, max_speed_kmh = greatest(max_speed_kmh, $5),
              positions = positions + 1, end_latitude = $6, end_longitude = $7,
              end_odometer_km = coalesce($8, end_odometer_km),
              last_position_at = greatest(last_position_at, $9)
        where id = $1`,
      [
        tripId,
        Math.round(i.distanceM * 10) / 10,
        i.movingSeconds,
        i.idleSeconds,
        i.maxSpeedKmh,
        i.fix.latitude,
        i.fix.longitude,
        i.fix.odometerKm,
        i.fix.recordedAt,
      ],
    );
  }

  async closeTrip(tripId: string, fix: Fix): Promise<void> {
    await this.tx.query(
      `update telematics_trips
          set ended_at = greatest(started_at, $2), end_latitude = $3, end_longitude = $4,
              end_odometer_km = coalesce($5, end_odometer_km),
              last_position_at = greatest(last_position_at, $2)
        where id = $1 and ended_at is null`,
      [tripId, fix.recordedAt, fix.latitude, fix.longitude, fix.odometerKm],
    );
  }

  async addUsage(vehicleId: string, day: string, i: UsageIncrement): Promise<void> {
    await this.tx.query(
      `insert into telematics_daily as d
         (vehicle_id, day, engine_seconds, moving_seconds, idle_seconds, distance_m, trips,
          max_speed_kmh, overspeed_events)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       on conflict (vehicle_id, day) do update
         set engine_seconds = d.engine_seconds + excluded.engine_seconds,
             moving_seconds = d.moving_seconds + excluded.moving_seconds,
             idle_seconds = d.idle_seconds + excluded.idle_seconds,
             distance_m = d.distance_m + excluded.distance_m,
             trips = d.trips + excluded.trips,
             max_speed_kmh = greatest(d.max_speed_kmh, excluded.max_speed_kmh),
             overspeed_events = d.overspeed_events + excluded.overspeed_events`,
      [
        vehicleId,
        day,
        i.engineSeconds ?? 0,
        i.movingSeconds ?? 0,
        i.idleSeconds ?? 0,
        Math.round((i.distanceM ?? 0) * 10) / 10,
        i.trips ?? 0,
        i.maxSpeedKmh ?? 0,
        i.overspeedEvents ?? 0,
      ],
    );
  }

  async openEvent(e: NewEvent): Promise<string> {
    const { rows } = await this.tx.query<{ id: string }>(
      `insert into telematics_events
         (kind, device_id, vehicle_id, branch_id, driver_id, geofence_id, started_at, latitude,
          longitude, speed_kmh, max_speed_kmh, limit_kmh, ended_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
               case when $1 = 'overspeed' then null else $7::timestamptz end)
       returning id`,
      [
        e.kind,
        e.deviceId,
        e.vehicle.vehicleId,
        e.vehicle.branchId,
        e.vehicle.driverId,
        e.geofenceId,
        e.startedAt,
        e.fix.latitude,
        e.fix.longitude,
        e.fix.speedKmh,
        e.maxSpeedKmh,
        e.limitKmh,
      ],
    );
    return rows[0]!.id;
  }

  async closeOverspeed(deviceId: string, fix: Fix, maxSpeedKmh: number): Promise<void> {
    await this.tx.query(
      `update telematics_events
          set ended_at = greatest(started_at, $2), max_speed_kmh = greatest(max_speed_kmh, $3)
        where device_id = $1 and kind = 'overspeed' and ended_at is null`,
      [deviceId, fix.recordedAt, maxSpeedKmh],
    );
  }

  // --- views ---

  async live(branchIds: "all" | readonly string[]): Promise<TelematicsDevice[]> {
    const w = new Where()
      .branches("v.branch_id", branchIds)
      .raw("d.status = 'active'")
      .raw("d.vehicle_id is not null")
      .raw("v.deleted_at is null");
    const { rows } = await this.tx.query<Row>(
      `${DEVICE} ${w.sql()} order by vehicle_name`,
      w.params,
    );
    return rows.map(toDevice);
  }

  async positions(vehicleId: string, from: Date, to: Date, limit: number): Promise<PositionView[]> {
    const { rows } = await this.tx.query<Row>(
      `select recorded_at, latitude, longitude, speed_kmh, heading, ignition
         from telematics_positions
        where vehicle_id = $1 and recorded_at >= $2 and recorded_at < $3
        order by recorded_at limit $4`,
      [vehicleId, from, to, limit],
    );
    return rows.map((r) => ({
      recordedAt: r.recorded_at as Date,
      latitude: n(r.latitude),
      longitude: n(r.longitude),
      speedKmh: n(r.speed_kmh),
      heading: nOrNull(r.heading),
      ignition: typeof r.ignition === "boolean" ? r.ignition : null,
    }));
  }

  async trips(filter: TripFilter): Promise<TripView[]> {
    const w = new Where()
      .branches("v.branch_id", filter.branchIds)
      .add("t.started_at >= ?", filter.from)
      .add("t.started_at < ?", filter.to);
    if (filter.branchIds !== "all") w.raw("t.vehicle_id is not null");
    if (filter.vehicleId !== undefined) w.add("t.vehicle_id = ?", filter.vehicleId);
    if (filter.driverId !== undefined) w.add("t.driver_id = ?", filter.driverId);
    const { rows } = await this.tx.query<Row>(
      `${TRIP} ${w.sql()} order by t.started_at desc limit ${w.next(filter.limit)}`,
      w.params,
    );
    return rows.map(toTrip);
  }

  async events(filter: EventFilter): Promise<TelematicsEvent[]> {
    const w = new Where().branches("e.branch_id", filter.branchIds);
    if (filter.kind !== undefined) w.add("e.kind = ?", filter.kind);
    if (filter.vehicleId !== undefined) w.add("e.vehicle_id = ?", filter.vehicleId);
    if (filter.driverId !== undefined) w.add("e.driver_id = ?", filter.driverId);
    if (filter.open === true) w.raw("e.acknowledged_at is null");
    if (filter.open === false) w.raw("e.acknowledged_at is not null");
    if (filter.from !== undefined) w.add("e.started_at >= ?", filter.from);
    if (filter.to !== undefined) w.add("e.started_at < ?", filter.to);
    const { rows } = await this.tx.query<Row>(
      `${EVENT} ${w.sql()} order by e.started_at desc limit ${w.next(filter.limit)}`,
      w.params,
    );
    return rows.map(toEvent);
  }

  async event(id: string): Promise<TelematicsEvent | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.tx.query<Row>(`${EVENT} where e.id = $1`, [id]);
    return rows[0] === undefined ? null : toEvent(rows[0]);
  }

  async acknowledge(id: string, userId: string, note: string | null, at: Date): Promise<void> {
    await this.tx.query(
      `update telematics_events set acknowledged_by = $2, acknowledged_at = $3, note = $4
        where id = $1 and acknowledged_at is null`,
      [id, userId, at, note],
    );
  }

  async usage(
    branchIds: "all" | readonly string[],
    fromDay: string,
    toDay: string,
    vehicleId: string | null,
  ): Promise<VehicleUsage[]> {
    const w = new Where().raw("v.deleted_at is null").branches("v.branch_id", branchIds);
    const from = w.next(fromDay);
    const to = w.next(toDay);
    w.raw(`(exists (select 1 from telematics_devices d
                     where d.vehicle_id = v.id and d.status = 'active')
            or exists (select 1 from telematics_daily t
                        where t.vehicle_id = v.id and t.day between ${from} and ${to}))`);
    if (vehicleId !== null) w.add("v.id = ?", vehicleId);
    const { rows } = await this.tx.query<Row>(
      `select v.id, ${vehicleName} as name, v.branch_id,
              coalesce(sum(t.engine_seconds), 0)::bigint as engine_seconds,
              coalesce(sum(t.moving_seconds), 0)::bigint as moving_seconds,
              coalesce(sum(t.idle_seconds), 0)::bigint as idle_seconds,
              coalesce(sum(t.distance_m), 0) as distance_m,
              coalesce(sum(t.trips), 0)::int as trips,
              coalesce(max(t.max_speed_kmh), 0) as max_speed_kmh,
              coalesce(sum(t.overspeed_events), 0)::int as overspeed_events,
              count(t.day) filter (where t.engine_seconds > 0)::int as active_days
         from vehicles v
         left join telematics_daily t on t.vehicle_id = v.id and t.day between ${from} and ${to}
        ${w.sql()}
        group by v.id
        order by name`,
      w.params,
    );
    return rows.map((r) => ({
      vehicleId: String(r.id),
      vehicleName: String(r.name),
      branchId: String(r.branch_id),
      engineSeconds: n(r.engine_seconds),
      movingSeconds: n(r.moving_seconds),
      idleSeconds: n(r.idle_seconds),
      distanceM: n(r.distance_m),
      trips: n(r.trips),
      maxSpeedKmh: n(r.max_speed_kmh),
      overspeedEvents: n(r.overspeed_events),
      activeDays: n(r.active_days),
    }));
  }

  // --- geofences ---

  async geofences(): Promise<GeofenceView[]> {
    const { rows } = await this.tx.query<Row>(
      "select *, name::text as name from geofences order by active desc, name",
    );
    return rows.map(toGeofence);
  }

  async geofence(id: string): Promise<GeofenceView | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.tx.query<Row>(
      "select *, name::text as name from geofences where id = $1",
      [id],
    );
    return rows[0] === undefined ? null : toGeofence(rows[0]);
  }

  async geofenceNameTaken(name: string, exceptId: string | null): Promise<boolean> {
    const { rows } = await this.tx.query(
      "select 1 from geofences where name = $1 and id is distinct from $2",
      [name, exceptId],
    );
    return rows.length > 0;
  }

  async saveGeofence(id: string, g: GeofenceInput, userId: string, isNew: boolean): Promise<void> {
    const circle = g.shape.kind === "circle" ? g.shape : null;
    const params = [
      id,
      g.name,
      g.shape.kind,
      circle?.center.latitude ?? null,
      circle?.center.longitude ?? null,
      circle?.radiusM ?? null,
      g.shape.kind === "polygon" ? JSON.stringify(g.shape.points) : null,
      g.branchId,
      g.alertOn,
      g.active,
      userId,
    ];
    if (isNew)
      await this.tx.query(
        `insert into geofences (id, name, kind, latitude, longitude, radius_m, points, branch_id,
                                alert_on, active, created_by, updated_by)
         values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $11)`,
        params,
      );
    else {
      await this.tx.query(
        `update geofences
            set name = $2, kind = $3, latitude = $4, longitude = $5, radius_m = $6,
                points = $7::jsonb, branch_id = $8, alert_on = $9, active = $10, updated_by = $11,
                updated_at = now()
          where id = $1`,
        params,
      );
      // A changed area is seen afresh: the next position says where each vehicle is.
      await this.tx.query("delete from telematics_geofence_states where geofence_id = $1", [id]);
    }
  }

  // --- daily ---

  async purgePositions(before: Date, batch: number): Promise<number> {
    const { rowCount } = await this.tx.query(
      `delete from telematics_positions
        where id in (select id from telematics_positions where recorded_at < $1 limit $2)`,
      [before, batch],
    );
    return rowCount ?? 0;
  }

  async closeStaleTrips(before: Date): Promise<number> {
    const { rowCount } = await this.tx.query(
      `with closed as (
         update telematics_trips set ended_at = last_position_at
          where ended_at is null and last_position_at < $1
          returning id)
       update telematics_devices set trip_id = null, updated_at = now()
        where trip_id in (select id from closed)`,
      [before],
    );
    await this.tx.query(
      `update telematics_events e set ended_at = greatest(e.started_at, d.last_position_at)
         from telematics_devices d
        where e.device_id = d.id and e.kind = 'overspeed' and e.ended_at is null
          and d.last_position_at < $1`,
      [before],
    );
    await this.tx.query(
      `update telematics_devices set overspeed_since = null, overspeed_max_kmh = null
        where overspeed_since is not null and last_position_at < $1`,
      [before],
    );
    return rowCount ?? 0;
  }

  async silentDevices(
    before: Date,
  ): Promise<Readonly<{ deviceId: string; vehicle: VehicleContext; lastReceivedAt: Date }>[]> {
    const { rows } = await this.tx.query<Row>(
      `select d.id, d.last_received_at, v.id as vehicle_id, ${vehicleName} as name, v.branch_id
         from telematics_devices d
         join vehicles v on v.id = d.vehicle_id and v.deleted_at is null
        where d.status = 'active' and d.last_received_at < $1 and d.silent_notified_at is null`,
      [before],
    );
    return rows.map((r) => ({
      deviceId: String(r.id),
      lastReceivedAt: r.last_received_at as Date,
      vehicle: {
        vehicleId: String(r.vehicle_id),
        name: String(r.name),
        branchId: String(r.branch_id),
        driverId: null,
      },
    }));
  }

  async markSilentNotified(deviceId: string, at: Date): Promise<void> {
    await this.tx.query("update telematics_devices set silent_notified_at = $2 where id = $1", [
      deviceId,
      at,
    ]);
  }

  async odometerReadings(): Promise<
    Readonly<{ deviceId: string; vehicleId: string; odometerKm: number; at: Date }>[]
  > {
    const { rows } = await this.tx.query<Row>(
      `select d.id, d.vehicle_id, d.last_odometer_km + d.odometer_offset_km as odometer_km,
              d.last_position_at
         from telematics_devices d
         join vehicles v on v.id = d.vehicle_id and v.deleted_at is null
        where d.status = 'active' and d.sync_odometer and d.last_odometer_km is not null
          and d.last_position_at is not null
          and d.last_odometer_km + d.odometer_offset_km >= coalesce(v.current_odometer, -1) + 1`,
    );
    return rows.map((r) => ({
      deviceId: String(r.id),
      vehicleId: String(r.vehicle_id),
      odometerKm: n(r.odometer_km),
      at: r.last_position_at as Date,
    }));
  }
}
