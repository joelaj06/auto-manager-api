import { contains, distanceMeters, type GeofenceArea } from "./Geo.js";

/** A position as a tracker reported it. */
export type Fix = Readonly<{
  recordedAt: Date;
  latitude: number;
  longitude: number;
  speedKmh: number;
  heading: number | null;
  /** Null when the tracker does not report it: the engine counts as on while moving. */
  ignition: boolean | null;
  odometerKm: number | null;
}>;

/** At or above this speed the vehicle is moving; below it with the engine on, idling. */
export const MOVING_KMH = 5;
/** A longer silence between two positions is a gap in the data: its time is not counted. */
export const MAX_GAP_SECONDS = 300;
/** A longer silence ends the trip under way (at the last position before it). */
export const TRIP_BREAK_SECONDS = 900;

export type TrackerSettings = Readonly<{ overspeedKmh: number; overspeedMinSeconds: number }>;

/** What is known of a tracker before the next position. */
export type TrackerState = Readonly<{
  last: Fix | null;
  tripOpen: boolean;
  overspeedSince: Date | null;
  overspeedMaxKmh: number | null;
  /** An over-speed event is recorded for the spell under way. */
  overspeedOpen: boolean;
  /** Inside or outside each geofence, once seen. */
  geofences: Readonly<Record<string, boolean>>;
}>;

export type TrackerEffect =
  | Readonly<{
      type: "usage";
      day: string;
      engineSeconds: number;
      movingSeconds: number;
      idleSeconds: number;
      distanceM: number;
      maxSpeedKmh: number;
    }>
  | Readonly<{ type: "trip_open"; at: Fix; day: string }>
  | Readonly<{
      type: "trip_extend";
      at: Fix;
      distanceM: number;
      movingSeconds: number;
      idleSeconds: number;
      maxSpeedKmh: number;
    }>
  | Readonly<{ type: "trip_close"; at: Fix }>
  | Readonly<{
      type: "overspeed_open";
      startedAt: Date;
      at: Fix;
      maxSpeedKmh: number;
      limitKmh: number;
      day: string;
    }>
  | Readonly<{ type: "overspeed_close"; at: Fix; maxSpeedKmh: number }>
  | Readonly<{
      type: "geofence";
      kind: "geofence_enter" | "geofence_exit";
      geofenceId: string;
      at: Fix;
    }>;

export type TrackerStep = Readonly<{
  state: TrackerState;
  effects: readonly TrackerEffect[];
  /** Older than the last position: kept, but it changes nothing. */
  late: boolean;
}>;

export const NEW_TRACKER: TrackerState = Object.freeze({
  last: null,
  tripOpen: false,
  overspeedSince: null,
  overspeedMaxKmh: null,
  overspeedOpen: false,
  geofences: {},
});

export const engineOn = (fix: Fix): boolean => fix.ignition ?? fix.speedKmh >= MOVING_KMH;

/**
 * One position of a tracker on a vehicle (docs/06 §9, decision 505): the time since the last one
 * counted as engine time (moving or idle) for the day it began in, the trip opened at ignition on
 * and closed at ignition off or after a long silence, an over-speed event once the vehicle stays
 * above the limit long enough, and geofence entries and exits. Positions arrive in time order
 * per tracker; one older than the last changes nothing.
 */
export function track(
  state: TrackerState,
  fix: Fix,
  areas: readonly GeofenceArea[],
  settings: TrackerSettings,
  dayOf: (at: Date) => string,
): TrackerStep {
  const prev = state.last;
  if (prev !== null && fix.recordedAt.getTime() <= prev.recordedAt.getTime())
    return { state, effects: [], late: true };
  const effects: TrackerEffect[] = [];
  let tripOpen = state.tripOpen;
  let since = state.overspeedSince;
  let max = state.overspeedMaxKmh;
  let overspeedOpen = state.overspeedOpen;

  if (prev !== null) {
    const gap = (fix.recordedAt.getTime() - prev.recordedAt.getTime()) / 1000;
    if (gap > TRIP_BREAK_SECONDS) {
      // A long silence: what was under way ended with the last position.
      if (tripOpen) effects.push({ type: "trip_close", at: prev });
      if (overspeedOpen) effects.push({ type: "overspeed_close", at: prev, maxSpeedKmh: max ?? 0 });
      tripOpen = false;
      since = null;
      max = null;
      overspeedOpen = false;
    } else if (engineOn(prev)) {
      const distanceM = distanceMeters(prev, fix);
      const counted = gap <= MAX_GAP_SECONDS ? Math.round(gap) : 0;
      const moving =
        prev.speedKmh >= MOVING_KMH ||
        fix.speedKmh >= MOVING_KMH ||
        (gap > 0 && (distanceM / gap) * 3.6 >= MOVING_KMH);
      const movingSeconds = moving ? counted : 0;
      const idleSeconds = moving ? 0 : counted;
      const maxSpeedKmh = Math.max(prev.speedKmh, fix.speedKmh);
      effects.push({
        type: "usage",
        day: dayOf(prev.recordedAt),
        engineSeconds: counted,
        movingSeconds,
        idleSeconds,
        distanceM,
        maxSpeedKmh,
      });
      if (tripOpen)
        effects.push({
          type: "trip_extend",
          at: fix,
          distanceM,
          movingSeconds,
          idleSeconds,
          maxSpeedKmh,
        });
    }
  }

  const on = engineOn(fix);
  if (on && !tripOpen) {
    effects.push({ type: "trip_open", at: fix, day: dayOf(fix.recordedAt) });
    tripOpen = true;
  } else if (!on && tripOpen) {
    effects.push({ type: "trip_close", at: fix });
    tripOpen = false;
  }

  if (fix.speedKmh > settings.overspeedKmh) {
    if (since === null) {
      since = fix.recordedAt;
      max = fix.speedKmh;
    } else max = Math.max(max ?? 0, fix.speedKmh);
    if (
      !overspeedOpen &&
      (fix.recordedAt.getTime() - since.getTime()) / 1000 >= settings.overspeedMinSeconds
    ) {
      effects.push({
        type: "overspeed_open",
        startedAt: since,
        at: fix,
        maxSpeedKmh: max,
        limitKmh: settings.overspeedKmh,
        day: dayOf(since),
      });
      overspeedOpen = true;
    }
  } else if (since !== null) {
    if (overspeedOpen) effects.push({ type: "overspeed_close", at: fix, maxSpeedKmh: max ?? 0 });
    since = null;
    max = null;
    overspeedOpen = false;
  }

  const geofences: Record<string, boolean> = { ...state.geofences };
  for (const area of areas) {
    const inside = contains(area.shape, fix);
    const before = geofences[area.id];
    geofences[area.id] = inside;
    // The first sighting only says where the vehicle is.
    if (before === undefined || before === inside) continue;
    const kind = inside ? "geofence_enter" : "geofence_exit";
    if (area.alertOn === "both" || (inside ? area.alertOn === "enter" : area.alertOn === "exit"))
      effects.push({ type: "geofence", kind, geofenceId: area.id, at: fix });
  }

  return {
    state: {
      last: fix,
      tripOpen,
      overspeedSince: since,
      overspeedMaxKmh: max,
      overspeedOpen,
      geofences,
    },
    effects,
    late: false,
  };
}

/** Engine hours against the working hours of the days in the period (decision 506). */
export function utilisationPercent(
  engineSeconds: number,
  days: number,
  workingHoursPerDay: number,
): number | null {
  const available = days * workingHoursPerDay * 3600;
  if (available <= 0) return null;
  return Math.round((engineSeconds / available) * 1000) / 10;
}
