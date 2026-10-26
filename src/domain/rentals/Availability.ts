import { overlaps, type BusyInterval } from "./VehicleBlock.js";

/** A vehicle that may take a booking, with the times it is already busy. */
export type Candidate = Readonly<{
  vehicleId: string;
  /** Tie-break, so the same request always gets the same vehicle. */
  code: string;
  busy: readonly BusyInterval[];
}>;

export function isFree(busy: readonly BusyInterval[], window: BusyInterval): boolean {
  return busy.every((b) => !overlaps(b, window));
}

/** Idle time left around the window on one vehicle: before, after; null when unbounded. */
function gaps(busy: readonly BusyInterval[], window: BusyInterval): [number | null, number | null] {
  let before: number | null = null;
  let after: number | null = null;
  for (const b of busy) {
    if (b.until !== null && b.until <= window.from) {
      const gap = window.from.getTime() - b.until.getTime();
      before = before === null ? gap : Math.min(before, gap);
    }
    if (window.until !== null && b.from >= window.until) {
      const gap = b.from.getTime() - window.until.getTime();
      after = after === null ? gap : Math.min(after, gap);
    }
  }
  return [before, after];
}

/**
 * The vehicle a class booking gets (docs/07 §3, decision 325): among those free for the whole
 * window, the best fit — the one the booking leaves the least idle time on, between the bookings
 * it already has — so idle vehicles stay whole for long hires. Unbounded sides count last.
 */
export function chooseVehicle(
  candidates: readonly Candidate[],
  window: BusyInterval,
): string | null {
  let best: { id: string; code: string; open: number; idle: number } | null = null;
  for (const c of candidates) {
    if (!isFree(c.busy, window)) continue;
    const [before, after] = gaps(c.busy, window);
    const open = (before === null ? 1 : 0) + (after === null ? 1 : 0);
    const idle = (before ?? 0) + (after ?? 0);
    const better =
      best === null ||
      open < best.open ||
      (open === best.open && (idle < best.idle || (idle === best.idle && c.code < best.code)));
    if (better) best = { id: c.vehicleId, code: c.code, open, idle };
  }
  return best?.id ?? null;
}

export type DayWindow = Readonly<{ date: string; from: Date; until: Date }>;
export type DayCapacity = Readonly<{ date: string; vehicles: number; free: number }>;

/** Per local day, how many of the vehicles are free all day (docs/07 §3 capacity per class). */
export function dailyCapacity(
  vehicles: readonly Candidate[],
  days: readonly DayWindow[],
): DayCapacity[] {
  return days.map((day) => ({
    date: day.date,
    vehicles: vehicles.length,
    free: vehicles.filter((v) => isFree(v.busy, day)).length,
  }));
}

export type MovableBlock = Readonly<{ blockId: string; busy: BusyInterval }>;

/**
 * Where class bookings go when their vehicle is needed (decision 326): each, in pickup order,
 * to the best-fit vehicle of the class still free once earlier moves are counted. Null: no
 * vehicle of the class is free, so the block stays and the caller refuses.
 */
export function planMoves(
  blocks: readonly MovableBlock[],
  candidates: readonly Candidate[],
): Map<string, string | null> {
  const busy = new Map(candidates.map((c) => [c.vehicleId, [...c.busy]]));
  const pool = () =>
    candidates.map((c) => ({ ...c, busy: busy.get(c.vehicleId) ?? [] }) satisfies Candidate);
  const moves = new Map<string, string | null>();
  const ordered = [...blocks].sort((a, b) => a.busy.from.getTime() - b.busy.from.getTime());
  for (const block of ordered) {
    const target = chooseVehicle(pool(), block.busy);
    moves.set(block.blockId, target);
    if (target !== null) busy.get(target)?.push(block.busy);
  }
  return moves;
}
