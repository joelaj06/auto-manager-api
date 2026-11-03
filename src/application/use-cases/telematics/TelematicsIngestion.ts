import { createHash, timingSafeEqual } from "node:crypto";
import type { GeofenceArea } from "../../../domain/telematics/Geo.js";
import { track, type TrackerEffect } from "../../../domain/telematics/Tracker.js";
import { TenantId } from "../../../domain/value-objects/TenantId.js";
import { assertTenantUsable } from "../../authorization/TenantAccessRules.js";
import { ApplicationError } from "../../errors/ApplicationError.js";
import { FeatureDisabledError, TenantReadOnlyError } from "../../errors/TenantErrors.js";
import type { IClock } from "../../ports/IClock.js";
import type { INotificationSettingsStore } from "../../ports/INotifications.js";
import type { IFeatureGate } from "../../ports/IOperationsGates.js";
import type { IOrganisationSettings } from "../../ports/IOrganisationSettings.js";
import type {
  ITelematics,
  ReceivedPosition,
  TelematicsProvider,
  Tracker,
  VehicleContext,
} from "../../ports/ITelematics.js";
import type { ITenantContext } from "../../ports/ITenantContext.js";
import type { ITenantDirectory } from "../../ports/ITenantDirectory.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import { localDateTime } from "../../services/TenantLocalTime.js";
import type { Notifier } from "../notifications/Notifier.js";

/** At most this many trackers per connection are added on their own (the rest are refused). */
export const MAX_DEVICES_PER_CONNECTION = 2_000;
/** Positions this far in the future (a tracker's clock gone wrong) are refused. */
const FUTURE_TOLERANCE_MS = 10 * 60_000;

/** Unknown business, connection or token: the same answer for all three (401). */
export class TelematicsAuthError extends ApplicationError {
  readonly code = "TELEMATICS_UNAUTHORIZED";
  constructor() {
    super("The address or the token is not right");
  }
}

export type IngestResult = Readonly<{
  accepted: number;
  duplicates: number;
  rejected: number;
  /** Trackers seen for the first time: link them to vehicles in the app. */
  newDevices: number;
}>;

export const tokenHash = (token: string): string =>
  createHash("sha256").update(token, "utf8").digest("hex");

const sameHash = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

const speed = (kmh: number) => `${Math.round(kmh)} km/h`;

/**
 * Positions pushed by a telematics provider (docs/06 §9, decision 504): to the business's own
 * address with the connection's secret token, matched to trackers by their identifier (new ones
 * added unlinked), each tracker's positions in time order driving its trips, the vehicle's
 * engine hours and distance per day, over-speed events and geofence alerts (decision 505), with
 * the branch's staff told of events. Positions resent are stored once.
 */
export class TelematicsIngestion {
  constructor(
    private readonly deps: Readonly<{
      tenants: ITenantDirectory;
      tenantContext: ITenantContext;
      unitOfWork: IUnitOfWork;
      telematics: ITelematics;
      organisation: IOrganisationSettings;
      notificationSettings: INotificationSettingsStore;
      notifier: Notifier;
      features?: IFeatureGate;
      clock: IClock;
    }>,
  ) {}

  async receive(
    tenantSlug: string,
    connectionId: string,
    token: string | null,
    parse: (provider: TelematicsProvider) => Readonly<{
      positions: ReceivedPosition[];
      rejected: number;
    }>,
  ): Promise<IngestResult> {
    const { deps } = this;
    if (token === null || token.length < 20 || token.length > 200) throw new TelematicsAuthError();
    const tenant = await deps.tenants.findBySlug(tenantSlug);
    if (tenant === null) throw new TelematicsAuthError();
    assertTenantUsable(tenant);
    if (tenant.status === "read_only") throw new TenantReadOnlyError();
    const flag = await deps.features?.disabledBy(tenant.id, "/api/v1/telematics");
    if (flag !== undefined && flag !== null) throw new FeatureDisabledError(flag);

    return deps.tenantContext.runAs(TenantId.from(tenant.id), () =>
      deps.unitOfWork.run(async () => {
        const secret = await deps.telematics.secret(connectionId);
        if (
          secret === null ||
          secret.status !== "active" ||
          !sameHash(secret.tokenHash, tokenHash(token))
        )
          throw new TelematicsAuthError();
        const now = deps.clock.now();
        const parsed = parse(secret.provider);
        let rejected = parsed.rejected;
        const byTracker = new Map<string, ReceivedPosition[]>();
        for (const p of parsed.positions) {
          if (p.fix.recordedAt.getTime() > now.getTime() + FUTURE_TOLERANCE_MS) {
            rejected += 1;
            continue;
          }
          const list = byTracker.get(p.identifier) ?? [];
          list.push(p);
          byTracker.set(p.identifier, list);
        }
        const before = await deps.telematics.deviceCount(connectionId);
        const trackers = await deps.telematics.lockTrackers(
          connectionId,
          [...byTracker.keys()],
          MAX_DEVICES_PER_CONNECTION,
        );
        const newDevices = (await deps.telematics.deviceCount(connectionId)) - before;
        let accepted = 0;
        let duplicates = 0;
        const work = await this.context(trackers);
        for (const [identifier, positions] of byTracker) {
          const tracker = trackers.get(identifier);
          if (tracker === undefined || tracker.status !== "active") {
            rejected += positions.length;
            continue;
          }
          positions.sort((a, b) => a.fix.recordedAt.getTime() - b.fix.recordedAt.getTime());
          const stored = await deps.telematics.addPositions(
            tracker.deviceId,
            tracker.vehicleId,
            positions,
          );
          accepted += stored.size;
          duplicates += positions.length - stored.size;
          const fresh = positions.filter((p) => stored.has(p.fix.recordedAt.getTime()));
          if (fresh.length > 0) await this.follow(tracker, fresh, work, now);
        }
        await deps.telematics.noteReceived(
          connectionId,
          accepted,
          rejected,
          rejected > 0 && accepted === 0 ? "No usable position in the last request" : null,
          now,
        );
        return { accepted, duplicates, rejected, newDevices };
      }),
    );
  }

  private async context(trackers: Map<string, Tracker>) {
    const { deps } = this;
    const vehicleIds = [...trackers.values()]
      .map((t) => t.vehicleId)
      .filter((id): id is string => id !== null);
    const [settings, areas, vehicles, organisation, notifications] = await Promise.all([
      deps.telematics.settings(),
      deps.telematics.activeGeofences(),
      deps.telematics.vehicleContexts(vehicleIds),
      deps.organisation.get(),
      deps.notificationSettings.get(),
    ]);
    const geofenceNames = new Map(areas.map((a) => [a.id, a.name]));
    return {
      settings,
      areas,
      vehicles,
      timezone: organisation.timezone,
      notifications,
      geofenceNames,
    };
  }

  /** Runs a tracker's new positions through its state and applies what they lead to. */
  private async follow(
    tracker: Tracker,
    positions: readonly ReceivedPosition[],
    work: Awaited<ReturnType<TelematicsIngestion["context"]>>,
    now: Date,
  ): Promise<void> {
    const { deps } = this;
    const vehicle =
      tracker.vehicleId === null ? null : (work.vehicles.get(tracker.vehicleId) ?? null);
    // A tracker not on a vehicle only reports where it is.
    const areas: GeofenceArea[] =
      vehicle === null
        ? []
        : work.areas.filter((a) => a.branchId === null || a.branchId === vehicle.branchId);
    const dayOf = (at: Date) => localDateTime(at, work.timezone).date;
    let state = tracker.state;
    let tripId = tracker.tripId;
    for (const { fix } of positions) {
      const step = track(
        state,
        fix,
        areas,
        {
          overspeedKmh: work.settings.overspeedKmh,
          overspeedMinSeconds: work.settings.overspeedMinSeconds,
        },
        dayOf,
      );
      if (step.late) continue;
      if (vehicle !== null)
        for (const effect of step.effects)
          tripId = await this.apply(tracker, vehicle, effect, tripId, work);
      for (const [geofenceId, inside] of Object.entries(step.state.geofences))
        if (state.geofences[geofenceId] !== inside)
          await deps.telematics.saveGeofenceState(
            tracker.deviceId,
            geofenceId,
            inside,
            fix.recordedAt,
          );
      state = step.state;
    }
    await deps.telematics.saveTracker(
      tracker.deviceId,
      vehicle === null ? { ...state, tripOpen: false, overspeedOpen: false } : state,
      vehicle === null ? null : tripId,
      now,
    );
  }

  private async apply(
    tracker: Tracker,
    vehicle: VehicleContext,
    effect: TrackerEffect,
    tripId: string | null,
    work: Awaited<ReturnType<TelematicsIngestion["context"]>>,
  ): Promise<string | null> {
    const { deps } = this;
    const t = deps.telematics;
    switch (effect.type) {
      case "usage":
        await t.addUsage(vehicle.vehicleId, effect.day, {
          engineSeconds: effect.engineSeconds,
          movingSeconds: effect.movingSeconds,
          idleSeconds: effect.idleSeconds,
          distanceM: effect.distanceM,
          maxSpeedKmh: effect.maxSpeedKmh,
        });
        return tripId;
      case "trip_open":
        await t.addUsage(vehicle.vehicleId, effect.day, { trips: 1 });
        return t.openTrip(tracker.deviceId, vehicle, vehicle.vehicleId, effect.at);
      case "trip_extend":
        if (tripId !== null)
          await t.extendTrip(tripId, {
            fix: effect.at,
            distanceM: effect.distanceM,
            movingSeconds: effect.movingSeconds,
            idleSeconds: effect.idleSeconds,
            maxSpeedKmh: effect.maxSpeedKmh,
          });
        return tripId;
      case "trip_close":
        if (tripId !== null) await t.closeTrip(tripId, effect.at);
        return null;
      case "overspeed_open": {
        await t.addUsage(vehicle.vehicleId, effect.day, { overspeedEvents: 1 });
        const id = await t.openEvent({
          kind: "overspeed",
          deviceId: tracker.deviceId,
          vehicle,
          geofenceId: null,
          startedAt: effect.startedAt,
          fix: effect.at,
          maxSpeedKmh: effect.maxSpeedKmh,
          limitKmh: effect.limitKmh,
        });
        await deps.notifier.staff(work.notifications, {
          rule: "telematics_overspeed",
          permission: "telematics.view",
          branchId: vehicle.branchId,
          dedupeKey: `telematics_overspeed:${id}`,
          title: `${vehicle.name} is over the speed limit`,
          body: `${vehicle.name} has been above ${speed(effect.limitKmh)} since ${this.clockTime(effect.startedAt, work.timezone)}, at ${speed(effect.at.speedKmh)} now.`,
          severity: "warning",
          data: { vehicleId: vehicle.vehicleId, eventId: id },
        });
        return tripId;
      }
      case "overspeed_close":
        await t.closeOverspeed(tracker.deviceId, effect.at, effect.maxSpeedKmh);
        return tripId;
      case "geofence": {
        const id = await t.openEvent({
          kind: effect.kind,
          deviceId: tracker.deviceId,
          vehicle,
          geofenceId: effect.geofenceId,
          startedAt: effect.at.recordedAt,
          fix: effect.at,
          maxSpeedKmh: null,
          limitKmh: null,
        });
        const area = work.geofenceNames.get(effect.geofenceId) ?? "a geofence";
        const verb = effect.kind === "geofence_enter" ? "entered" : "left";
        await deps.notifier.staff(work.notifications, {
          rule: "telematics_geofence",
          permission: "telematics.view",
          branchId: vehicle.branchId,
          dedupeKey: `telematics_geofence:${id}`,
          title: `${vehicle.name} ${verb} ${area}`,
          body: `${vehicle.name} ${verb} ${area} at ${this.clockTime(effect.at.recordedAt, work.timezone)}.`,
          severity: effect.kind === "geofence_exit" ? "warning" : "info",
          data: { vehicleId: vehicle.vehicleId, eventId: id, geofenceId: effect.geofenceId },
        });
        return tripId;
      }
    }
  }

  private clockTime(at: Date, timezone: string): string {
    const local = localDateTime(at, timezone);
    return `${String(local.hour).padStart(2, "0")}:${String(local.minute).padStart(2, "0")} on ${local.date}`;
  }
}
