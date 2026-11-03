import { describe, expect, it } from "vitest";
import type { GeofenceArea } from "./Geo.js";
import { NEW_TRACKER, track, utilisationPercent, type Fix, type TrackerState } from "./Tracker.js";

const start = Date.parse("2026-11-03T08:00:00Z");
const settings = { overspeedKmh: 100, overspeedMinSeconds: 30 };
const dayOf = (at: Date) => at.toISOString().slice(0, 10);
const fix = (seconds: number, extra: Partial<Fix> = {}): Fix => ({
  recordedAt: new Date(start + seconds * 1000),
  latitude: 5.6,
  longitude: -0.2 + seconds * 0.0001,
  speedKmh: 40,
  heading: 90,
  ignition: true,
  odometerKm: null,
  ...extra,
});

function run(fixes: Fix[], areas: GeofenceArea[] = [], state: TrackerState = NEW_TRACKER) {
  const effects = [];
  for (const f of fixes) {
    const step = track(state, f, areas, settings, dayOf);
    effects.push(...step.effects);
    state = step.state;
  }
  return { state, effects };
}

describe("tracker", () => {
  it("opens a trip at ignition on, counts engine time and distance, and closes at ignition off", () => {
    const { state, effects } = run([
      fix(0),
      fix(30),
      fix(60, { speedKmh: 0 }),
      fix(90, { ignition: false, speedKmh: 0, longitude: -0.2 + 60 * 0.0001 }),
    ]);
    expect(effects.map((e) => e.type)).toEqual([
      "trip_open",
      "usage",
      "trip_extend",
      "usage",
      "trip_extend",
      "usage",
      "trip_extend",
      "trip_close",
    ]);
    const usage = effects.filter((e) => e.type === "usage");
    expect(usage.reduce((s, u) => s + u.engineSeconds, 0)).toBe(90);
    // The last interval had the vehicle standing still with the engine on.
    expect(usage.at(-1)!.idleSeconds).toBe(30);
    expect(usage.reduce((s, u) => s + u.distanceM, 0)).toBeGreaterThan(600);
    expect(state.tripOpen).toBe(false);
  });

  it("treats moving as engine on when the tracker reports no ignition", () => {
    const { effects } = run([
      fix(0, { ignition: null, speedKmh: 30 }),
      fix(60, { ignition: null, speedKmh: 0, longitude: -0.2 }),
    ]);
    expect(effects.map((e) => e.type)).toEqual(["trip_open", "usage", "trip_extend", "trip_close"]);
  });

  it("does not count a gap in the data, and ends a trip after a long silence", () => {
    const gap = run([fix(0), fix(600)]);
    expect(gap.effects.find((e) => e.type === "usage")).toMatchObject({ engineSeconds: 0 });
    const silence = run([fix(0), fix(1_000)]);
    expect(silence.effects.map((e) => e.type)).toEqual(["trip_open", "trip_close", "trip_open"]);
  });

  it("ignores a position older than the last one", () => {
    const first = run([fix(60)]);
    const step = track(first.state, fix(30), [], settings, dayOf);
    expect(step).toMatchObject({ late: true, effects: [] });
  });

  it("records over speed once the vehicle stays above the limit long enough", () => {
    const { effects } = run([
      fix(0, { speedKmh: 110 }),
      fix(20, { speedKmh: 125 }),
      fix(40, { speedKmh: 118 }),
      fix(60, { speedKmh: 90 }),
    ]);
    const open = effects.find((e) => e.type === "overspeed_open");
    expect(open).toMatchObject({ maxSpeedKmh: 125, limitKmh: 100 });
    expect(open?.type === "overspeed_open" && open.startedAt).toEqual(new Date(start));
    expect(effects.find((e) => e.type === "overspeed_close")).toMatchObject({ maxSpeedKmh: 125 });
    // A short burst is no event.
    const burst = run([fix(0, { speedKmh: 120 }), fix(10, { speedKmh: 80 })]);
    expect(burst.effects.some((e) => e.type.startsWith("overspeed"))).toBe(false);
  });

  it("tells geofence exits and entries after the first sighting", () => {
    const yard: GeofenceArea = {
      id: "yard",
      name: "Yard",
      shape: { kind: "circle", center: { latitude: 5.6, longitude: -0.2 }, radiusM: 500 },
      branchId: null,
      alertOn: "both",
    };
    const { effects, state } = run(
      [fix(0, { longitude: -0.2 }), fix(30, { longitude: -0.19 }), fix(60, { longitude: -0.2 })],
      [yard],
    );
    expect(
      effects.filter((e) => e.type === "geofence").map((e) => e.type === "geofence" && e.kind),
    ).toEqual(["geofence_exit", "geofence_enter"]);
    expect(state.geofences.yard).toBe(true);
    const exitsOnly = run(
      [fix(0, { longitude: -0.19 }), fix(30, { longitude: -0.2 })],
      [{ ...yard, alertOn: "exit" }],
    );
    expect(exitsOnly.effects.some((e) => e.type === "geofence")).toBe(false);
  });

  it("puts engine hours against the working day", () => {
    expect(utilisationPercent(36_000, 2, 10)).toBe(50);
    expect(utilisationPercent(0, 0, 10)).toBeNull();
  });
});
