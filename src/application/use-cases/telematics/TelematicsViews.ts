import { pageOf, pageWindow, type Page, type Paging } from "../../dto/Page.js";
import { TelematicsRuleError } from "../../../domain/telematics/Geo.js";
import { utilisationPercent } from "../../../domain/telematics/Tracker.js";
import type { Principal } from "../../authorization/Principal.js";
import type { IAuditTrail } from "../../ports/IAuditTrail.js";
import type { IClock } from "../../ports/IClock.js";
import type { IOrganisationSettings } from "../../ports/IOrganisationSettings.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import type {
  EventFilter,
  ITelematics,
  PositionView,
  TelematicsDevice,
  TelematicsEvent,
  TripFilter,
  TripView,
} from "../../ports/ITelematics.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import { localDateTime } from "../../services/TenantLocalTime.js";
import { recordUserAction } from "../reference/userAudit.js";
import type { VehicleAccess } from "../vehicles/VehicleAccess.js";
import { TelematicsNotFoundError } from "./TelematicsSetup.js";

const DAY_MS = 86_400_000;
/** A tracker whose last position was taken this recently is live on the map. */
const LIVE_MS = 10 * 60_000;
const MAX_TRACK_POINTS = 5_000;
const MAX_TRACK_DAYS = 7;

export type LiveVehicle = TelematicsDevice &
  Readonly<{ state: "moving" | "idling" | "parked" | "offline" }>;

export type UtilisationRow = Readonly<{
  vehicleId: string;
  vehicleName: string;
  branchId: string;
  engineHours: number;
  movingHours: number;
  idleHours: number;
  idlePercent: number | null;
  distanceKm: number;
  trips: number;
  activeDays: number;
  maxSpeedKmh: number;
  overspeedEvents: number;
  /** Engine hours against the working hours of the period's days. */
  utilisationPercent: number | null;
}>;

export type Utilisation = Readonly<{
  from: string;
  to: string;
  days: number;
  workingHoursPerDay: number;
  vehicles: readonly UtilisationRow[];
  totals: Omit<UtilisationRow, "vehicleId" | "vehicleName" | "branchId">;
}>;

const hours = (seconds: number) => Math.round((seconds / 3600) * 10) / 10;
const shareOf = (part: number, whole: number) =>
  whole <= 0 ? null : Math.round((part / whole) * 1000) / 10;

/**
 * What the trackers tell (docs/06 §9): the live map, a vehicle's track, trips, events with their
 * acknowledgement, and utilisation from ignition — engine, moving and idle hours, distance and
 * active days per vehicle (decision 506). Branch-scoped like vehicles.
 */
export class TelematicsViews {
  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      telematics: ITelematics;
      vehicleAccess: VehicleAccess;
      organisation: IOrganisationSettings;
      auditTrail: IAuditTrail;
      requestContext: IRequestContext;
      clock: IClock;
    }>,
  ) {}

  live(actor: Principal): Promise<LiveVehicle[]> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const now = deps.clock.now().getTime();
      const devices = await deps.telematics.live(
        deps.vehicleAccess.branchesFor(actor, "telematics.view"),
      );
      return devices.map((d) => ({
        ...d,
        state:
          d.last === null || now - d.last.at.getTime() > LIVE_MS
            ? "offline"
            : d.last.speedKmh >= 5
              ? "moving"
              : d.last.ignition === true
                ? "idling"
                : "parked",
      }));
    });
  }

  /** A vehicle's positions over up to a week, thinned evenly to 5,000 points. */
  track(
    actor: Principal,
    vehicleId: string,
    range: Readonly<{ from: Date; to: Date }>,
  ): Promise<PositionView[]> {
    const { deps } = this;
    if (range.to <= range.from) throw new TelematicsRuleError("The end is before the start");
    if (range.to.getTime() - range.from.getTime() > MAX_TRACK_DAYS * DAY_MS)
      throw new TelematicsRuleError(`A track covers at most ${MAX_TRACK_DAYS} days`);
    return deps.unitOfWork.run(async () => {
      await deps.vehicleAccess.reach(actor, vehicleId, "telematics.view");
      const all = await deps.telematics.positions(vehicleId, range.from, range.to, 200_000);
      if (all.length <= MAX_TRACK_POINTS) return all;
      const step = all.length / MAX_TRACK_POINTS;
      const thinned: PositionView[] = [];
      for (let i = 0; i < MAX_TRACK_POINTS; i++) thinned.push(all[Math.floor(i * step)]!);
      thinned[thinned.length - 1] = all.at(-1)!;
      return thinned;
    });
  }

  trips(actor: Principal, filter: Paging<Omit<TripFilter, "branchIds">>): Promise<Page<TripView>> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      if (filter.vehicleId !== undefined)
        await deps.vehicleAccess.reach(actor, filter.vehicleId, "telematics.view");
      const found = await deps.telematics.trips({
        ...filter,
        ...pageWindow(filter),
        branchIds: deps.vehicleAccess.branchesFor(actor, "telematics.view"),
      });
      return pageOf(filter, found);
    });
  }

  events(
    actor: Principal,
    filter: Paging<Omit<EventFilter, "branchIds">>,
  ): Promise<Page<TelematicsEvent>> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const found = await deps.telematics.events({
        ...filter,
        ...pageWindow(filter),
        branchIds: deps.vehicleAccess.branchesFor(actor, "telematics.view"),
      });
      return pageOf(filter, found);
    });
  }

  acknowledge(actor: Principal, id: string, note: string | null): Promise<TelematicsEvent> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const event = await deps.telematics.event(id);
      if (
        event === null ||
        !deps.vehicleAccess.can(actor, "telematics.events.manage", event.branchId)
      )
        throw new TelematicsNotFoundError("event");
      if (event.acknowledgedAt !== null)
        throw new TelematicsRuleError("This event is already acknowledged");
      await deps.telematics.acknowledge(id, actor.userId, note?.trim() || null, deps.clock.now());
      await recordUserAction(deps, actor.userId, {
        action: "telematics.event_acknowledged",
        entityType: "telematics_event",
        entityId: id,
        after: { kind: event.kind, vehicleId: event.vehicleId, note },
      });
      return (await deps.telematics.event(id))!;
    });
  }

  /** Engine, moving and idle hours, distance and trips per vehicle over local days. */
  utilisation(
    actor: Principal,
    range: Readonly<{ from?: string; to?: string; branchId?: string; vehicleId?: string }>,
  ): Promise<Utilisation> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const { timezone } = await deps.organisation.get();
      const today = localDateTime(deps.clock.now(), timezone).date;
      const to = range.to ?? today;
      const from = range.from ?? shiftDay(to, -29);
      const days = Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS) + 1;
      if (!(days >= 1)) throw new TelematicsRuleError("The end is before the start");
      if (days > 366) throw new TelematicsRuleError("The period is at most a year");
      let branchIds = deps.vehicleAccess.branchesFor(actor, "telematics.view");
      if (range.branchId !== undefined) {
        await deps.vehicleAccess.branch(actor, "telematics.view", range.branchId);
        branchIds = [range.branchId];
      }
      if (range.vehicleId !== undefined)
        await deps.vehicleAccess.reach(actor, range.vehicleId, "telematics.view");
      const { workingHoursPerDay } = await deps.telematics.settings();
      const usage = await deps.telematics.usage(branchIds, from, to, range.vehicleId ?? null);
      const row = (u: (typeof usage)[number]): UtilisationRow => ({
        vehicleId: u.vehicleId,
        vehicleName: u.vehicleName,
        branchId: u.branchId,
        engineHours: hours(u.engineSeconds),
        movingHours: hours(u.movingSeconds),
        idleHours: hours(u.idleSeconds),
        idlePercent: shareOf(u.idleSeconds, u.engineSeconds),
        distanceKm: Math.round(u.distanceM / 100) / 10,
        trips: u.trips,
        activeDays: u.activeDays,
        maxSpeedKmh: u.maxSpeedKmh,
        overspeedEvents: u.overspeedEvents,
        utilisationPercent: utilisationPercent(u.engineSeconds, days, workingHoursPerDay),
      });
      const sum = (pick: (u: (typeof usage)[number]) => number) =>
        usage.reduce((total, u) => total + pick(u), 0);
      const engine = sum((u) => u.engineSeconds);
      return {
        from,
        to,
        days,
        workingHoursPerDay,
        vehicles: usage.map(row),
        totals: {
          engineHours: hours(engine),
          movingHours: hours(sum((u) => u.movingSeconds)),
          idleHours: hours(sum((u) => u.idleSeconds)),
          idlePercent: shareOf(
            sum((u) => u.idleSeconds),
            engine,
          ),
          distanceKm: Math.round(sum((u) => u.distanceM) / 100) / 10,
          trips: sum((u) => u.trips),
          activeDays: sum((u) => u.activeDays),
          maxSpeedKmh: usage.reduce((m, u) => Math.max(m, u.maxSpeedKmh), 0),
          overspeedEvents: sum((u) => u.overspeedEvents),
          utilisationPercent: utilisationPercent(
            engine,
            days * Math.max(1, usage.length),
            workingHoursPerDay,
          ),
        },
      };
    });
  }
}

function shiftDay(day: string, by: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + by * DAY_MS).toISOString().slice(0, 10);
}
