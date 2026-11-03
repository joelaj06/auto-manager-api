import type { GeofenceAlert, GeofenceArea, GeofenceShape } from "../../domain/telematics/Geo.js";
import type { Fix, TrackerState } from "../../domain/telematics/Tracker.js";

export const TELEMATICS_PROVIDERS = ["generic", "flespi", "traccar"] as const;
export type TelematicsProvider = (typeof TELEMATICS_PROVIDERS)[number];

/** A position read from a provider's request, before it is matched to a tracker. */
export type ReceivedPosition = Readonly<{
  /** The tracker's identifier at the provider (IMEI, ident, unique id). */
  identifier: string;
  fix: Fix;
  attributes: Readonly<Record<string, unknown>>;
}>;

export type TelematicsSettings = Readonly<{
  positionRetentionDays: number;
  overspeedKmh: number;
  overspeedMinSeconds: number;
  workingHoursPerDay: number;
  silentAfterHours: number;
  updatedAt: Date;
}>;

export type TelematicsSettingsInput = Omit<TelematicsSettings, "updatedAt">;

export type TelematicsConnection = Readonly<{
  id: string;
  name: string;
  provider: TelematicsProvider;
  tokenHint: string;
  status: "active" | "disabled";
  lastReceivedAt: Date | null;
  acceptedCount: number;
  rejectedCount: number;
  lastError: string | null;
  devices: number;
  createdAt: Date;
}>;

export type ConnectionSecret = Readonly<{
  id: string;
  provider: TelematicsProvider;
  status: "active" | "disabled";
  tokenHash: string;
}>;

export type LastFix = Readonly<{
  at: Date;
  latitude: number;
  longitude: number;
  speedKmh: number;
  heading: number | null;
  ignition: boolean | null;
  odometerKm: number | null;
}>;

export type TelematicsDevice = Readonly<{
  id: string;
  connectionId: string;
  connectionName: string;
  identifier: string;
  label: string | null;
  vehicleId: string | null;
  vehicleName: string | null;
  branchId: string | null;
  status: "active" | "retired";
  syncOdometer: boolean;
  odometerOffsetKm: number;
  last: LastFix | null;
  lastReceivedAt: Date | null;
  onTrip: boolean;
  createdAt: Date;
}>;

export type DeviceFilter = Readonly<{
  branchIds: "all" | readonly string[];
  connectionId?: string;
  vehicleId?: string;
  /** Trackers not on a vehicle (seen from businesses' own branches only by `all`). */
  unlinked?: boolean;
  status?: "active" | "retired";
  limit: number;
}>;

export type DeviceChanges = Readonly<{
  label?: string | null;
  vehicleId?: string | null;
  status?: "active" | "retired";
  syncOdometer?: boolean;
  odometerOffsetKm?: number;
}>;

/** A tracker as ingestion works on it (locked for the request). */
export type Tracker = Readonly<{
  deviceId: string;
  identifier: string;
  vehicleId: string | null;
  status: "active" | "retired";
  tripId: string | null;
  state: TrackerState;
}>;

export type GeofenceView = GeofenceArea &
  Readonly<{ active: boolean; createdAt: Date; updatedAt: Date }>;

export type GeofenceInput = Readonly<{
  name: string;
  shape: GeofenceShape;
  branchId: string | null;
  alertOn: GeofenceAlert;
  active: boolean;
}>;

/** Where a vehicle belongs and who drives it now (for events and trips). */
export type VehicleContext = Readonly<{
  vehicleId: string;
  name: string;
  branchId: string;
  driverId: string | null;
}>;

export type TripView = Readonly<{
  id: string;
  deviceId: string;
  vehicleId: string | null;
  vehicleName: string | null;
  driverId: string | null;
  driverName: string | null;
  startedAt: Date;
  endedAt: Date | null;
  start: Readonly<{ latitude: number; longitude: number }>;
  end: Readonly<{ latitude: number; longitude: number }> | null;
  distanceKm: number;
  movingSeconds: number;
  idleSeconds: number;
  maxSpeedKmh: number;
  positions: number;
  startOdometerKm: number | null;
  endOdometerKm: number | null;
}>;

export type TripFilter = Readonly<{
  branchIds: "all" | readonly string[];
  vehicleId?: string;
  driverId?: string;
  from: Date;
  to: Date;
  limit: number;
}>;

export const TELEMATICS_EVENT_KINDS = ["geofence_enter", "geofence_exit", "overspeed"] as const;
export type TelematicsEventKind = (typeof TELEMATICS_EVENT_KINDS)[number];

export type TelematicsEvent = Readonly<{
  id: string;
  kind: TelematicsEventKind;
  deviceId: string;
  vehicleId: string;
  vehicleName: string;
  branchId: string;
  driverId: string | null;
  driverName: string | null;
  geofenceId: string | null;
  geofenceName: string | null;
  startedAt: Date;
  endedAt: Date | null;
  latitude: number;
  longitude: number;
  speedKmh: number;
  maxSpeedKmh: number | null;
  limitKmh: number | null;
  acknowledgedBy: string | null;
  acknowledgedAt: Date | null;
  note: string | null;
}>;

export type EventFilter = Readonly<{
  branchIds: "all" | readonly string[];
  kind?: TelematicsEventKind;
  vehicleId?: string;
  driverId?: string;
  open?: boolean;
  from?: Date;
  to?: Date;
  limit: number;
}>;

export type NewEvent = Readonly<{
  kind: TelematicsEventKind;
  deviceId: string;
  vehicle: VehicleContext;
  geofenceId: string | null;
  startedAt: Date;
  fix: Fix;
  maxSpeedKmh: number | null;
  limitKmh: number | null;
}>;

export type PositionView = Readonly<{
  recordedAt: Date;
  latitude: number;
  longitude: number;
  speedKmh: number;
  heading: number | null;
  ignition: boolean | null;
}>;

export type UsageIncrement = Readonly<{
  engineSeconds?: number;
  movingSeconds?: number;
  idleSeconds?: number;
  distanceM?: number;
  maxSpeedKmh?: number;
  trips?: number;
  overspeedEvents?: number;
}>;

export type VehicleUsage = Readonly<{
  vehicleId: string;
  vehicleName: string;
  branchId: string;
  engineSeconds: number;
  movingSeconds: number;
  idleSeconds: number;
  distanceM: number;
  trips: number;
  maxSpeedKmh: number;
  overspeedEvents: number;
  activeDays: number;
}>;

/** Telematics in the tenant's database (tenant migration 0047, docs/06 §9). */
export interface ITelematics {
  settings(): Promise<TelematicsSettings>;
  saveSettings(input: TelematicsSettingsInput, userId: string): Promise<void>;

  connections(): Promise<TelematicsConnection[]>;
  connection(id: string): Promise<TelematicsConnection | null>;
  secret(id: string): Promise<ConnectionSecret | null>;
  createConnection(
    input: Readonly<{
      id: string;
      name: string;
      provider: TelematicsProvider;
      tokenHash: string;
      tokenHint: string;
      createdBy: string;
    }>,
  ): Promise<void>;
  updateConnection(
    id: string,
    changes: Readonly<{
      name?: string;
      status?: "active" | "disabled";
      tokenHash?: string;
      tokenHint?: string;
    }>,
  ): Promise<void>;
  nameTaken(name: string, exceptId: string | null): Promise<boolean>;
  noteReceived(
    id: string,
    accepted: number,
    rejected: number,
    error: string | null,
    at: Date,
  ): Promise<void>;

  devices(filter: DeviceFilter): Promise<TelematicsDevice[]>;
  device(id: string): Promise<TelematicsDevice | null>;
  deviceCount(connectionId: string): Promise<number>;
  createDevice(
    input: Readonly<{
      connectionId: string;
      identifier: string;
      label: string | null;
      vehicleId: string | null;
      createdBy: string | null;
    }>,
  ): Promise<string>;
  updateDevice(id: string, changes: DeviceChanges): Promise<void>;
  /**
   * Starts a tracker's state afresh (moved to another vehicle, retired): its open trip ends at its
   * last position, an over-speed spell under way ends, and its geofence states are forgotten.
   */
  resetTracking(deviceId: string): Promise<void>;
  /** The active tracker of a vehicle, if any. */
  vehicleDevice(vehicleId: string): Promise<string | null>;

  /**
   * The trackers of a connection by identifier, locked for the request; identifiers not known
   * yet are added (unlinked) while the connection has fewer than `maxDevices`.
   */
  lockTrackers(
    connectionId: string,
    identifiers: readonly string[],
    maxDevices: number,
  ): Promise<Map<string, Tracker>>;
  activeGeofences(): Promise<GeofenceArea[]>;
  vehicleContexts(vehicleIds: readonly string[]): Promise<Map<string, VehicleContext>>;
  /** Stores what is new; returns the times (ms) actually stored (the rest were resent). */
  addPositions(
    deviceId: string,
    vehicleId: string | null,
    positions: readonly ReceivedPosition[],
  ): Promise<Set<number>>;
  saveTracker(
    deviceId: string,
    state: TrackerState,
    tripId: string | null,
    receivedAt: Date,
  ): Promise<void>;
  saveGeofenceState(
    deviceId: string,
    geofenceId: string,
    inside: boolean,
    since: Date,
  ): Promise<void>;
  openTrip(
    deviceId: string,
    vehicle: VehicleContext | null,
    vehicleId: string | null,
    fix: Fix,
  ): Promise<string>;
  extendTrip(
    tripId: string,
    increment: Readonly<{
      fix: Fix;
      distanceM: number;
      movingSeconds: number;
      idleSeconds: number;
      maxSpeedKmh: number;
    }>,
  ): Promise<void>;
  closeTrip(tripId: string, fix: Fix): Promise<void>;
  addUsage(vehicleId: string, day: string, increment: UsageIncrement): Promise<void>;
  openEvent(event: NewEvent): Promise<string>;
  closeOverspeed(deviceId: string, fix: Fix, maxSpeedKmh: number): Promise<void>;

  live(branchIds: "all" | readonly string[]): Promise<TelematicsDevice[]>;
  positions(vehicleId: string, from: Date, to: Date, limit: number): Promise<PositionView[]>;
  trips(filter: TripFilter): Promise<TripView[]>;
  events(filter: EventFilter): Promise<TelematicsEvent[]>;
  event(id: string): Promise<TelematicsEvent | null>;
  acknowledge(id: string, userId: string, note: string | null, at: Date): Promise<void>;
  usage(
    branchIds: "all" | readonly string[],
    fromDay: string,
    toDay: string,
    vehicleId: string | null,
  ): Promise<VehicleUsage[]>;

  geofences(): Promise<GeofenceView[]>;
  geofence(id: string): Promise<GeofenceView | null>;
  geofenceNameTaken(name: string, exceptId: string | null): Promise<boolean>;
  saveGeofence(id: string, input: GeofenceInput, userId: string, isNew: boolean): Promise<void>;

  /** Deletes up to `batch` positions recorded before `before`; returns how many. */
  purgePositions(before: Date, batch: number): Promise<number>;
  /** Trips left open by a tracker gone quiet end at their last position. */
  closeStaleTrips(before: Date): Promise<number>;
  silentDevices(
    before: Date,
  ): Promise<Readonly<{ deviceId: string; vehicle: VehicleContext; lastReceivedAt: Date }>[]>;
  markSilentNotified(deviceId: string, at: Date): Promise<void>;
  odometerReadings(): Promise<
    Readonly<{ deviceId: string; vehicleId: string; odometerKm: number; at: Date }>[]
  >;
}
