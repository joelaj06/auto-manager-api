import { describe, expect, it } from "vitest";
import { chooseVehicle, dailyCapacity, isFree, planMoves, type Candidate } from "./Availability.js";
import {
  assertWindow,
  blockedUntil,
  holdExpiry,
  isLive,
  overlaps,
  VehicleBlockError,
  type VehicleBlock,
} from "./VehicleBlock.js";

const at = (day: number, hour = 9) =>
  new Date(`2026-11-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:00:00Z`);
const span = (from: Date, until: Date | null) => ({ from, until });
const car = (code: string, ...busy: [Date, Date | null][]): Candidate => ({
  vehicleId: code.toLowerCase(),
  code,
  busy: busy.map(([f, u]) => span(f, u)),
});

const block = (over: Partial<VehicleBlock>): VehicleBlock => ({
  id: "b",
  vehicleId: "v",
  branchId: "hq",
  classId: null,
  reason: "rental",
  status: "confirmed",
  startsAt: at(2),
  endsAt: at(5),
  blockedUntil: at(5),
  expiresAt: null,
  customerId: null,
  refType: null,
  refId: null,
  note: null,
  releasedAt: null,
  releasedReason: null,
  releasedBy: null,
  createdBy: null,
  createdAt: at(1),
  ...over,
});

describe("vehicle blocks", () => {
  it("overlap like half-open ranges: back to back is free", () => {
    expect(overlaps(span(at(2), at(5)), span(at(5), at(7)))).toBe(false);
    expect(overlaps(span(at(2), at(5)), span(at(4), at(7)))).toBe(true);
    expect(overlaps(span(at(2), null), span(at(20), at(21)))).toBe(true);
    expect(overlaps(span(at(10), null), span(at(2), at(10)))).toBe(false);
    expect(overlaps(span(at(3), at(4)), span(at(2), at(7)))).toBe(true);
  });

  it("block the turnaround after rentals only", () => {
    expect(blockedUntil("rental", at(5), 90)).toEqual(new Date("2026-11-05T10:30:00Z"));
    expect(blockedUntil("maintenance", at(5), 90)).toEqual(at(5));
    expect(blockedUntil("maintenance", null, 90)).toBeNull();
  });

  it("stop holding once released or a hold has lapsed", () => {
    expect(isLive(block({}), at(3))).toBe(true);
    expect(isLive(block({ status: "released", releasedAt: at(2) }), at(3))).toBe(false);
    const hold = block({ status: "hold", expiresAt: at(2, 10) });
    expect(isLive(hold, at(2, 9))).toBe(true);
    expect(isLive(hold, at(2, 10))).toBe(false);
  });

  it("check times", () => {
    expect(() => assertWindow("rental", at(5), at(5))).toThrow(VehicleBlockError);
    expect(() => assertWindow("rental", at(5), null)).toThrow("return time");
    expect(() => assertWindow("rental", at(1), new Date("2027-12-01T00:00:00Z"))).toThrow(
      "at most 366 days",
    );
    expect(() => assertWindow("maintenance", at(5), null)).not.toThrow();
    expect(holdExpiry(at(2), 30)).toEqual(new Date("2026-11-02T09:30:00Z"));
    expect(() => holdExpiry(at(2), 2)).toThrow("5 minutes");
  });
});

describe("allocation", () => {
  it("skips vehicles busy at any time of the window", () => {
    const busy = [span(at(2), at(4)), span(at(6), at(8))];
    expect(isFree(busy, span(at(4), at(6)))).toBe(true);
    expect(isFree(busy, span(at(3), at(5)))).toBe(false);
    expect(isFree(busy, span(at(5), null))).toBe(false);
  });

  it("gives a class booking the best-fit vehicle, keeping idle ones whole", () => {
    const window = span(at(4), at(6));
    const cars = [
      car("A"), // idle: kept for long hires
      car("B", [at(1), at(3)]), // one day idle before, open after
      car("C", [at(1), at(4)], [at(6), at(9)]), // fits exactly between two bookings
      car("D", [at(1), at(2)], [at(8), at(9)]), // fits, but leaves four idle days
      car("E", [at(5), at(7)]), // busy
    ];
    expect(chooseVehicle(cars, window)).toBe("c");
    expect(
      chooseVehicle(
        cars.filter((c) => c.code !== "C"),
        window,
      ),
    ).toBe("d");
    expect(chooseVehicle([car("A"), car("B", [at(1), at(3)])], window)).toBe("b");
    expect(chooseVehicle([car("Z"), car("A")], window)).toBe("a");
    expect(chooseVehicle([car("E", [at(5), at(7)])], window)).toBeNull();
  });

  it("counts free vehicles per day", () => {
    const days = [2, 3, 4].map((d) => ({
      date: `2026-11-0${d}`,
      from: at(d, 0),
      until: at(d + 1, 0),
    }));
    const cars = [car("A", [at(2, 9), at(3, 9)]), car("B"), car("C", [at(4, 23), null])];
    expect(dailyCapacity(cars, days)).toEqual([
      { date: "2026-11-02", vehicles: 3, free: 2 },
      { date: "2026-11-03", vehicles: 3, free: 2 },
      { date: "2026-11-04", vehicles: 3, free: 2 },
    ]);
  });

  it("moves class bookings off a vehicle in pickup order, counting earlier moves", () => {
    const first = { blockId: "1", busy: span(at(2), at(4)) };
    const second = { blockId: "2", busy: span(at(3), at(5)) };
    const third = { blockId: "3", busy: span(at(10), at(12)) };
    const moves = planMoves([third, second, first], [car("B"), car("C", [at(6), at(9)])]);
    expect(Object.fromEntries(moves)).toEqual({ "1": "c", "2": "b", "3": "c" });
    const stuck = planMoves([first, second], [car("B")]);
    expect(Object.fromEntries(stuck)).toEqual({ "1": "b", "2": null });
  });
});
